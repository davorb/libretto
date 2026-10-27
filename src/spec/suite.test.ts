import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SpecError } from './types.js'
import type { Suite, SpecId, SpecIssue } from './types.js'
import { loadSuite } from './suite.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'libretto-spec-'))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), content)
  }
  return dir
}

const scenario = (uses?: string, title = 'Login') =>
  `${uses ? `---\nuses: [${uses}]\n---\n` : ''}# ${title}\n## Scenario: s\nSteps:\n- go {{env.PW}}\nExpect:\n- ok\n`
const fixture = (uses?: string, step = 'sign in') => `${uses ? `---\nuses: [${uses}]\n---\n` : ''}# Fx\nSteps:\n- ${step}\n`
const id = (s: string) => s as SpecId

const BASE = {
  'app.md': '# App\nBase URL http://localhost\n',
  'fixtures/base.md': fixture(),
  'fixtures/logged-in.md': fixture('base', 'log in'),
  'auth/login.md': scenario('logged-in'),
  'auth/logout.md': scenario(),
  'cart.md': scenario(),
}

const issuesOf = async (files: Record<string, string>): Promise<readonly SpecIssue[]> => {
  const dir = await project(files)
  try {
    await loadSuite(dir)
  } catch (e) {
    if (e instanceof SpecError) return e.issues
    throw e
  }
  throw new Error('expected SpecError')
}

describe('loadSuite', () => {
  it('loads specs, kinds, ids, uses, env refs and the app spec', async () => {
    const dir = await project(BASE)
    const suite = await loadSuite(dir)
    expect([...suite.specs.keys()]).toEqual(['auth/login', 'auth/logout', 'cart', 'fixtures/base', 'fixtures/logged-in'])
    const login = suite.specs.get(id('auth/login'))
    expect(login).toMatchObject({ kind: 'scenario', title: 'Login', uses: 'fixtures/logged-in', envRefs: ['PW'] })
    expect(login?.file).toBe(path.join(dir, 'auth/login.md'))
    expect(suite.specs.get(id('fixtures/base'))?.kind).toBe('fixture')
    expect(suite.app.source).toContain('Base URL')
    expect(suite.app.file).toBe(path.join(dir, 'app.md'))
    expect(suite.specs.has(id('app'))).toBe(false)
  })

  it('collects every issue across files in one SpecError', async () => {
    const issues = await issuesOf({
      ...BASE,
      'auth/login.md': '# L\n## Scenario: s\nSteps:\n- a\n',
      'cart.md': scenario('nope'),
    })
    expect(issues.map((i) => path.basename(i.file)).sort()).toEqual(['cart.md', 'login.md'])
    expect(issues.find((i) => i.file.endsWith('cart.md'))).toMatchObject({ line: 2 })
    expect(issues.find((i) => i.file.endsWith('cart.md'))?.message).toMatch(/Unknown fixture "nope".*base, logged-in/)
  })

  it('reports a missing app.md and a missing directory', async () => {
    const { 'app.md': _, ...rest } = BASE
    expect((await issuesOf(rest))[0]?.message).toMatch(/Missing app\.md/)
    await expect(loadSuite('/nonexistent/specs-dir')).rejects.toBeInstanceOf(SpecError)
  })

  it('rejects multiple uses entries', async () => {
    const issues = await issuesOf({ ...BASE, 'cart.md': scenario('base, logged-in') })
    expect(issues[0]?.message).toMatch(/lists 2 fixtures.*compose by making one fixture use the other/)
  })

  it('rejects a scenario used as a fixture', async () => {
    const issues = await issuesOf({ ...BASE, 'cart.md': scenario('auth/logout') })
    expect(issues[0]?.message).toMatch(/names a scenario spec/)
  })

  it('names the full cycle', async () => {
    const issues = await issuesOf({
      ...BASE,
      'fixtures/a.md': fixture('b'),
      'fixtures/b.md': fixture('c'),
      'fixtures/c.md': fixture('a'),
      'cart.md': scenario('a'),
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toBe('Fixture cycle: fixtures/a → fixtures/b → fixtures/c → fixtures/a.')
    expect(issues[0]?.line).toBe(2)
  })

  it('rejects a fixture that uses itself', async () => {
    const issues = await issuesOf({ ...BASE, 'fixtures/a.md': fixture('a') })
    expect(issues[0]?.message).toBe('Fixture cycle: fixtures/a → fixtures/a.')
  })
})

describe('hashing', () => {
  const hashes = async (files: Record<string, string>) => {
    const suite = await loadSuite(await project(files))
    return Object.fromEntries([...suite.specs].map(([k, v]) => [k, v.hash])) as Record<string, string>
  }

  it('is stable under CRLF, trailing whitespace and trailing newlines', async () => {
    const a = await hashes(BASE)
    const noisy = Object.fromEntries(
      Object.entries(BASE).map(([k, v]) => [k, `${v.replace(/\n/g, '  \r\n')}\r\n\r\n`]),
    )
    const b = await hashes(noisy)
    expect(b).toEqual(a)
  })

  it('changes when content changes, and gives distinct hashes to distinct specs', async () => {
    const a = await hashes(BASE)
    const b = await hashes({ ...BASE, 'cart.md': scenario(undefined, 'Cart v2') })
    expect(b['cart']).not.toBe(a['cart'])
    expect(b['auth/logout']).toBe(a['auth/logout'])
    expect(a['fixtures/base']).not.toBe(a['fixtures/logged-in'])
    expect(a['auth/login']).not.toBe(a['auth/logout'])
  })

  it('propagates a fixture change to every transitive dependent only', async () => {
    const a = await hashes(BASE)
    const b = await hashes({ ...BASE, 'fixtures/base.md': fixture(undefined, 'sign in differently') })
    for (const changed of ['fixtures/base', 'fixtures/logged-in', 'auth/login']) expect(b[changed]).not.toBe(a[changed])
    for (const same of ['auth/logout', 'cart']) expect(b[same]).toBe(a[same])
  })

  it('hashes app.md separately from spec hashes', async () => {
    const dir = await project(BASE)
    const s1 = await loadSuite(dir)
    await writeFile(path.join(dir, 'app.md'), '# App\nchanged\n')
    const s2 = await loadSuite(dir)
    expect(s2.app.hash).not.toBe(s1.app.hash)
    expect(s2.specs.get(id('cart'))?.hash).toBe(s1.specs.get(id('cart'))?.hash)
    await writeFile(path.join(dir, 'app.md'), '# App\r\nchanged   \r\n')
    expect((await loadSuite(dir)).app.hash).toBe(s2.app.hash)
  })
})

describe('Suite', () => {
  let suite: Suite
  const load = async () => (suite = await loadSuite(await project(BASE)))
  const ids = (specs: readonly { id: string }[]) => specs.map((s) => s.id)

  it('select: none selects all, exact id, md path, directory, dedupes', async () => {
    await load()
    expect(suite.select([])).toHaveLength(5)
    expect(ids(suite.select(['auth/login']))).toEqual(['auth/login'])
    expect(ids(suite.select(['auth/login.md']))).toEqual(['auth/login'])
    expect(ids(suite.select(['./auth/']))).toEqual(['auth/login', 'auth/logout'])
    expect(ids(suite.select(['auth', 'auth/login', 'cart']))).toEqual(['auth/login', 'auth/logout', 'cart'])
    expect(ids(suite.select(['fixtures']))).toEqual(['fixtures/base', 'fixtures/logged-in'])
  })

  it('select: accepts a path through the specs dir, relative or absolute', async () => {
    const dir = await project(BASE)
    suite = await loadSuite(dir)
    expect(ids(suite.select([path.join(dir, 'auth/login.md')]))).toEqual(['auth/login'])
    const rel = path.relative(process.cwd(), path.join(dir, 'cart.md'))
    expect(ids(suite.select([rel]))).toEqual(['cart'])
  })

  it('select: throws one SpecError naming every unmatched selector, and does not match prefixes of names', async () => {
    await load()
    try {
      suite.select(['auth/login', 'nope', 'au'])
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(SpecError)
      expect((e as SpecError).issues.map((i) => i.file)).toEqual(['nope', 'au'])
    }
  })

  it('fixtureChain is outermost first and excludes the spec', async () => {
    await load()
    expect(ids(suite.fixtureChain(suite.specs.get(id('auth/login'))!))).toEqual(['fixtures/base', 'fixtures/logged-in'])
    expect(ids(suite.fixtureChain(suite.specs.get(id('fixtures/base'))!))).toEqual([])
    expect(ids(suite.fixtureChain(suite.specs.get(id('cart'))!))).toEqual([])
  })

  it('withEdit returns a new suite with fresh hashes and leaves the original untouched', async () => {
    await load()
    const edited = suite.withEdit(id('fixtures/base'), fixture(undefined, 'new base step'))
    expect('specs' in edited).toBe(true)
    const next = edited as Suite
    expect(next.specs.get(id('fixtures/base'))?.scenarios[0]?.steps[0]?.text).toBe('new base step')
    expect(next.specs.get(id('auth/login'))?.hash).not.toBe(suite.specs.get(id('auth/login'))?.hash)
    expect(next.specs.get(id('cart'))?.hash).toBe(suite.specs.get(id('cart'))?.hash)
    expect(next.app).toBe(suite.app)
    expect(suite.specs.get(id('fixtures/base'))?.scenarios[0]?.steps[0]?.text).toBe('sign in')
    expect(next.withEdit(id('cart'), scenario(undefined, 'Cart 3'))).toHaveProperty('specs')
  })

  it('withEdit returns issues instead of throwing', async () => {
    await load()
    const bad = suite.withEdit(id('cart'), '# Cart\n## Scenario: s\nSteps:\n- a\n')
    expect(Array.isArray(bad)).toBe(true)
    expect((bad as SpecIssue[])[0]).toMatchObject({ line: 2 })

    const cyc = suite.withEdit(id('fixtures/base'), fixture('logged-in'))
    expect((cyc as SpecIssue[])[0]?.message).toMatch(/Fixture cycle: fixtures\/(base|logged-in) → .* → fixtures\/(base|logged-in)\./)

    expect((suite.withEdit(id('missing'), '# x') as SpecIssue[])[0]?.message).toMatch(/Unknown spec/)
  })
})
