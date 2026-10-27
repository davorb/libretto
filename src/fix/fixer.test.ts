import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSuite, type AppHash, type Spec, type SpecHash, type SpecId, type Suite } from '../spec/index.js'
import type { FailureId, RunId, TriageRecord, Verdict } from '../workspace/index.js'
import { pendingRecords, proposeSpecEdit } from './fixer.js'

const id = (s: string) => s as SpecId

function record(spec: string, scenario: string, verdict: Verdict, stamp: { specHash?: string; bodyHash?: string } = {}): TriageRecord {
  return {
    failure: `${spec}::chromium::${scenario}` as FailureId,
    runId: 'r1' as RunId,
    spec: id(spec),
    generated: { specHash: (stamp.specHash ?? 'S') as SpecHash, appHash: 'A' as AppHash, bodyHash: stamp.bodyHash ?? 'B' },
    verdict,
    live: true,
    model: 'm',
    usage: { turns: 1, costUsd: 0 },
    at: 'now',
  }
}

const specWrong: Verdict = { kind: 'test-broken', cause: 'spec-wrong', evidence: 'button renamed' }
const codeWrong: Verdict = { kind: 'test-broken', cause: 'generated-code-wrong', evidence: 'bad locator' }

describe('pendingRecords', () => {
  const current = (specHash: string | null, bodyHash: string | null) => () => ({ specHash, bodyHash })

  it('keeps unhandled spec-wrong and generated-code-wrong records', () => {
    const records = [record('a', 's', specWrong), record('b', 's', codeWrong)]
    expect(pendingRecords(records, current('S', 'B'))).toEqual(records)
  })

  it('drops a spec-wrong record once the spec hash moved', () => {
    expect(pendingRecords([record('a', 's', specWrong)], current('S2', 'B'))).toEqual([])
  })

  it('drops a generated-code-wrong record once the body hash moved or the file is gone', () => {
    expect(pendingRecords([record('a', 's', codeWrong)], current('S', 'B2'))).toEqual([])
    expect(pendingRecords([record('a', 's', codeWrong)], current('S', null))).toEqual([])
  })

  it('judges each cause by its own hash', () => {
    const records = [record('a', 's1', specWrong), record('a', 's2', codeWrong)]
    expect(pendingRecords(records, current('S', 'B2')).map((r) => r.verdict.evidence)).toEqual(['button renamed'])
  })

  it('never returns app-broken or inconclusive records', () => {
    const records = [record('a', 's', { kind: 'app-broken', evidence: 'x' }), record('a', 't', { kind: 'inconclusive', evidence: 'y' })]
    expect(pendingRecords(records, current('S', 'B'))).toEqual([])
  })
})

describe('proposeSpecEdit', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  const LOGIN = [
    '# Login',
    '## Scenario: valid',
    'Steps:',
    '- Open the login page',
    '- Click Sign in',
    'Expect:',
    '- See the dashboard',
    '## Scenario: invalid',
    'Steps:',
    '- Open the login page',
    'Expect:',
    '- See an error',
    '',
  ].join('\n')

  async function setup(files: Record<string, string> = {}): Promise<{ suite: Suite; spec: Spec }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'libretto-fix-'))
    dirs.push(dir)
    const all = { 'app.md': '# App\n', 'fixtures/base.md': '# Base\nSteps:\n- go\n', 'auth/login.md': LOGIN, ...files }
    for (const [rel, content] of Object.entries(all)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
      await writeFile(path.join(dir, rel), content)
    }
    const suite = await loadSuite(dir)
    return { suite, spec: suite.specs.get(id('auth/login'))! }
  }

  const submit = async (edited: string, failing: string[] = ['valid'], env: NodeJS.ProcessEnv = {}) => {
    const { suite, spec } = await setup()
    return proposeSpecEdit(suite, spec, new Set(failing), env).accept({ markdown: edited, summary: 'renamed button' })
  }

  it('accepts a valid edit and returns markdown and summary', async () => {
    const edited = LOGIN.replace('Click Sign in', 'Click Log in')
    expect(await submit(edited)).toEqual({ ok: true, value: { markdown: edited, summary: 'renamed button' } })
  })

  it('returns parse issues as feedback', async () => {
    const result = await submit('not a spec at all')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.feedback).toContain('does not parse')
  })

  it('rejects a changed title', async () => {
    const result = await submit(LOGIN.replace('# Login', '# Sign in'))
    expect(result).toMatchObject({ ok: false, feedback: expect.stringContaining('title') })
  })

  it('rejects changed uses', async () => {
    const result = await submit(`---\nuses: [base]\n---\n${LOGIN}`)
    expect(result).toMatchObject({ ok: false, feedback: expect.stringContaining('uses') })
  })

  it('rejects dropping a scenario that was not failing, and allows dropping a failing one', async () => {
    const dropped = LOGIN.slice(0, LOGIN.indexOf('## Scenario: invalid'))
    const rejected = await submit(dropped)
    expect(rejected).toMatchObject({ ok: false, feedback: expect.stringContaining('"invalid"') })
    expect((await submit(dropped, ['valid', 'invalid'])).ok).toBe(true)
  })

  it('allows renaming a failing scenario', async () => {
    expect((await submit(LOGIN.replace('Scenario: valid', 'Scenario: valid login'))).ok).toBe(true)
  })

  it('rejects a new env reference that is unset and allows one that is set', async () => {
    const edited = LOGIN.replace('Click Sign in', 'Type {{env.NEW_PASSWORD}}')
    const rejected = await submit(edited)
    expect(rejected).toMatchObject({ ok: false, feedback: expect.stringContaining('NEW_PASSWORD') })
    expect((await submit(edited, ['valid'], { NEW_PASSWORD: 'x' })).ok).toBe(true)
  })

  it('does not call an env reference the spec already had "new"', async () => {
    const withEnv = LOGIN.replace('Click Sign in', 'Type {{env.OLD}}')
    const { suite, spec } = await setup({ 'auth/login.md': withEnv })
    const result = await proposeSpecEdit(suite, spec, new Set(['valid']), {}).accept({ markdown: withEnv.replace('Type', 'Enter'), summary: 's' })
    expect(result.ok).toBe(true)
  })
})
