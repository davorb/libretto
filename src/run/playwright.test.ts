import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunContext } from '../project/index.js'
import type { Spec, SpecId } from '../spec/index.js'
import { openWorkspace } from '../workspace/index.js'
import { parseListFailure, writeWrapperConfig } from './playwright.js'

let root: string
let ctx: RunContext

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'libretto-run-'))
  ctx = makeCtx(null)
})
afterEach(() => rm(root, { recursive: true, force: true }))

function makeCtx(playwrightConfig: string | null): RunContext {
  return {
    config: { root, baseURL: 'http://localhost:3000', specsDir: path.join(root, 'specs'), playwrightConfig },
    workspace: openWorkspace(root, path.join(root, 'specs')),
    log: { info() {}, warn() {}, error() {}, agent() {} },
    signal: undefined,
    suite: {},
  } as unknown as RunContext
}

const spec = (id: string, kind: Spec['kind'], uses: string | null): Spec => ({ id: id as SpecId, kind, uses: uses as SpecId | null }) as Spec

async function loadWrapper(file: string): Promise<any> {
  return (await import(`${pathToFileURL(file).href}?t=${Math.random()}`)).default
}

describe('writeWrapperConfig', () => {
  const specs = [
    spec('fixtures/base', 'fixture', null),
    spec('fixtures/logged-in', 'fixture', 'fixtures/base'),
    spec('auth/login', 'scenario', null),
    spec('cart/checkout', 'scenario', 'fixtures/logged-in'),
  ]

  it('suite mode: owns testDir, use, setup projects with chained dependencies, and appends the reporter', async () => {
    const file = await writeWrapperConfig(ctx, { kind: 'suite', specs })
    expect(file).toBe(path.join(root, '.libretto/playwright.config.mjs'))
    const config = await loadWrapper(file)
    expect(config.testDir).toBe(ctx.workspace.generatedDir)
    expect(config.use).toMatchObject({ baseURL: 'http://localhost:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' })
    expect(config.projects.map((p: any) => [p.name, p.dependencies])).toEqual([
      ['setup:fixtures/base', []],
      ['setup:fixtures/logged-in', ['setup:fixtures/base']],
      ['scenarios', []],
      ['scenarios:fixtures/logged-in', ['setup:fixtures/logged-in']],
    ])
    const checkout = config.projects[3].testMatch[0] as RegExp
    expect(checkout.test(ctx.workspace.generatedFile('cart/checkout' as SpecId))).toBe(true)
    expect(checkout.test(ctx.workspace.generatedFile('auth/login' as SpecId))).toBe(false)
    expect(config.reporter[0]).toEqual(['list'])
    const [reporterPath, options] = config.reporter[1]
    expect(reporterPath).toMatch(/dist[\\/]run[\\/]reporter\.js$/)
    expect(options).toEqual({ workspace: root, specsDir: path.join(root, 'specs'), baseURL: 'http://localhost:3000' })
  })

  it('suite mode: keeps the user reporters, use, and settings, and only the first project use', async () => {
    const userFile = path.join(root, 'playwright.config.mjs')
    await writeFile(
      userFile,
      `export default {
        timeout: 7000,
        reporter: 'dot',
        use: { locale: 'sv-SE', baseURL: 'http://wrong' },
        projects: [{ name: 'a', use: { viewport: { width: 1, height: 2 } } }, { name: 'b', use: { locale: 'de' } }],
      }`,
    )
    const config = await loadWrapper(await writeWrapperConfig(makeCtx(userFile), { kind: 'suite', specs }))
    expect(config.timeout).toBe(7000)
    expect(config.reporter[0]).toEqual(['dot'])
    expect(config.reporter).toHaveLength(2)
    expect(config.use).toMatchObject({ locale: 'sv-SE', viewport: { width: 1, height: 2 }, baseURL: 'http://localhost:3000' })
    expect(config.projects.map((p: any) => p.name)).not.toContain('a')
  })

  it('draft mode: one file, no retries, one worker, list reporter, optional storageState', async () => {
    const draft = path.join(ctx.workspace.draftsDir, 'auth/login.generated.spec.ts')
    const file = await writeWrapperConfig(ctx, { kind: 'draft', file: draft, storageState: '/state.json' })
    const config = await loadWrapper(file)
    expect(config).toMatchObject({ testDir: ctx.workspace.draftsDir, retries: 0, workers: 1 })
    expect(config.reporter[0][0]).toBe('list')
    expect(config.reporter).toHaveLength(1)
    expect(config.use.storageState).toBe('/state.json')
    expect(config.projects).toHaveLength(1)
    expect(config.projects[0].testMatch[0].test(draft)).toBe(true)
    const without = await loadWrapper(await writeWrapperConfig(ctx, { kind: 'draft', file: draft, storageState: null }))
    expect(without.use).not.toHaveProperty('storageState')
  })

  it('fixtures mode: setup projects only, and no libretto reporter', async () => {
    const config = await loadWrapper(await writeWrapperConfig(ctx, { kind: 'fixtures', chain: specs.slice(0, 2) }))
    expect(config.projects.map((p: any) => p.name)).toEqual(['setup:fixtures/base', 'setup:fixtures/logged-in'])
    expect(config.reporter).toEqual([['list']])
  })

  it('is idempotent and writes the libretto/test shim next to the generated tests', async () => {
    const a = await writeWrapperConfig(ctx, { kind: 'suite', specs })
    const before = await readFile(a, 'utf8')
    await writeWrapperConfig(ctx, { kind: 'suite', specs })
    expect(await readFile(a, 'utf8')).toBe(before)
    const shim = path.join(root, '.libretto/node_modules/libretto')
    expect(JSON.parse(await readFile(path.join(shim, 'package.json'), 'utf8')).exports['./test']).toBe('./test.js')
    expect(await readFile(path.join(shim, 'test.js'), 'utf8')).toContain('dist/test/index.js')
    expect((await stat(path.join(shim, 'reporter.js'))).isFile()).toBe(true)
  })
})

describe('parseListFailure', () => {
  const output = `Running 1 test using 1 worker

  ✘  1 auth/login.generated.spec.ts:4:5 › valid credentials (1.1s)

  1) auth/login.generated.spec.ts:4:5 › valid credentials › Steps 2: Enter wrong password ──────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 2
    Received: 1

      8 |     await test.step('Steps 2: Enter wrong password', async () => {
    > 9 |       expect(1).toBe(2)
        |                 ^
        at /tmp/x/auth/login.generated.spec.ts:9:21

  1 failed
    auth/login.generated.spec.ts:4:5 › valid credentials ───────────────────────────────────────
`

  it('extracts scenario, step, and the error message', () => {
    const failure = parseListFailure(output)
    expect(failure.scenario).toBe('valid credentials')
    expect(failure.step).toEqual({ scenario: 'valid credentials', section: 'steps', index: 2 })
    expect(failure.error.message).toContain('Expected: 2')
    expect(failure.error.message).not.toContain('at /tmp')
  })

  it('handles a project prefix and ANSI colors', () => {
    const colored = output.replace('1) auth', '1) [chromium] › auth').replace('Error:', '\u001b[31mError:\u001b[39m')
    const failure = parseListFailure(colored)
    expect(failure.scenario).toBe('valid credentials')
    expect(failure.error.message).toMatch(/^Error: expect/)
  })

  it('degrades to the trimmed output when nothing parses', () => {
    const failure = parseListFailure('boom\n')
    expect(failure).toEqual({ scenario: '', step: null, error: { message: 'boom', stack: null } })
  })
})
