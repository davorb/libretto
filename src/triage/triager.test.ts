import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResult, AgentRunner, AgentTask, Unsubmitted } from '../agent/index.js'
import type { Project } from '../project/index.js'
import type { AppHash, Spec, SpecHash, SpecId, Suite } from '../spec/index.js'
import { openWorkspace, type FailureId, type FailureRecord, type RunId, type Verdict, type Workspace } from '../workspace/index.js'

vi.mock('../project/index.js', () => ({ openProject: vi.fn() }))

import { openProject } from '../project/index.js'
import { triage } from './index.js'
import { probe, submitVerdict, triageOne, triageTask, UNPROBED_PREFIX, verdictFrom } from './triager.js'

const usage = { turns: 3, costUsd: 0.5 }
const specId = 'auth/login' as SpecId
const specHash = 'spec-h1' as SpecHash
const appHash = 'app-h1' as AppHash
const BODY = "test('valid credentials', async () => { /* BODY_MARKER */ })\n"

let root: string
let ws: Workspace
let server: http.Server
let baseURL: string
let closedURL: string

const step = (section: 'steps' | 'expect', index: number, text: string) => ({ ref: { scenario: 'valid credentials', section, index }, text, envRefs: [] })
const spec: Spec = {
  id: specId,
  kind: 'scenario',
  file: '/x/auth/login.md',
  title: 'Login',
  tags: [],
  uses: null,
  scenarios: [
    { name: 'valid credentials', steps: [step('steps', 1, 'Open the login page'), step('steps', 2, 'Click the sign-in button')], expect: [step('expect', 1, 'See the dashboard')] },
    { name: 'second', steps: [], expect: [] },
  ],
  envRefs: ['LIBRETTO_TEST_MISSING_SECRET'],
  source: 'SPEC_SOURCE_MARKER',
  hash: specHash,
}

function makeSuite(current: Spec): Suite {
  return {
    app: { file: '', source: 'APP_SOURCE_MARKER', hash: appHash },
    specs: new Map([[current.id, current]]),
    select: (selectors: readonly string[]) => {
      if (selectors.length > 0 && !selectors.some((s) => current.id.startsWith(s))) throw new Error('no match')
      return [current]
    },
  } as unknown as Suite
}

function failure(scenario: string, bodyHash: string, runId = 'run1', stepRef: FailureRecord['step'] = { scenario, section: 'steps', index: 2 }): FailureRecord {
  return {
    id: `${specId}::chromium::${scenario}` as FailureId,
    runId: runId as RunId,
    spec: specId,
    scenario,
    project: 'chromium',
    step: stepRef,
    error: { message: 'locator timed out', stack: null },
    artifacts: { trace: null, screenshots: [], domSnapshot: null },
    generated: { specHash, appHash, bodyHash },
    retries: 0,
  }
}

function makeProject(agent: AgentRunner, over: { baseURL?: string; suite?: Suite } = {}): Project {
  return {
    config: {
      root,
      baseURL: over.baseURL ?? baseURL,
      profiles: { triage: { model: 'test-model', maxTurns: 5, maxBudgetUsd: 1 } },
    },
    suite: over.suite ?? makeSuite(spec),
    workspace: ws,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), agent: vi.fn() },
    signal: undefined,
    agent,
  } as unknown as Project
}

/** Like a real agent: probes the live app once (one browser call) when a browser is attached, then submits. */
const submitting = (verdict: unknown, seen: AgentTask<Verdict>[] = []): AgentRunner => ({
  backend: 'scripted',
  async run<R>(task: AgentTask<R>): Promise<AgentResult<R>> {
    seen.push(task as unknown as AgentTask<Verdict>)
    if (task.browser) task.onEvent?.({ type: 'tool-call', server: 'playwright', tool: 'browser_navigate', input: {} })
    const accepted = await task.submit.accept(task.submit.input.parse(verdict))
    return accepted.ok ? { status: 'submitted', value: accepted.value, usage } : { status: 'unsubmitted', reason: 'ended', lastText: accepted.feedback, usage }
  },
})

const unsubmitted = (reason: 'turn-cap' | 'budget-cap' | 'ended' | 'aborted', lastText = 'gave up'): AgentRunner => ({
  backend: 'scripted',
  run: async <R>() => ({ status: 'unsubmitted', reason, lastText, usage }) as AgentResult<R>,
})

let bodyHash: string

async function writeLastRun(failures: FailureRecord[]) {
  await ws.mergeLastRun({ runId: 'run1' as RunId, startedAt: 'now', baseURL, passed: 0 }, [], failures, [])
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'libretto-triage-'))
  ws = openWorkspace(root, path.join(root, 'specs'))
  server = http.createServer((_, res) => res.writeHead(404).end('nope'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const closed = http.createServer()
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
  closedURL = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`
  await new Promise((r) => closed.close(r))
  await ws.writeGenerated({ spec: specId, specHash, appHash, body: BODY }, spec.file)
  bodyHash = (await ws.stamp(specId))!.bodyHash
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  await rm(root, { recursive: true, force: true })
  vi.mocked(openProject).mockReset()
})

describe('submitVerdict', () => {
  it('rejects test-broken without a cause', async () => {
    const r = await submitVerdict().accept({ kind: 'test-broken', evidence: 'e' })
    expect(r.ok).toBe(false)
  })
  it('rejects a cause on app-broken and inconclusive', async () => {
    expect((await submitVerdict().accept({ kind: 'app-broken', cause: 'spec-wrong', evidence: 'e' })).ok).toBe(false)
    expect((await submitVerdict().accept({ kind: 'inconclusive', cause: 'spec-wrong', evidence: 'e' })).ok).toBe(false)
  })
  it('accepts well-formed verdicts', async () => {
    expect(await submitVerdict().accept({ kind: 'test-broken', cause: 'generated-code-wrong', evidence: 'e' })).toEqual({
      ok: true,
      value: { kind: 'test-broken', cause: 'generated-code-wrong', evidence: 'e' },
    })
    expect(await submitVerdict().accept({ kind: 'app-broken', evidence: 'e' })).toEqual({ ok: true, value: { kind: 'app-broken', evidence: 'e' } })
  })
})

describe('submitVerdict probing gate', () => {
  it('rejects the first unprobed verdict, then accepts with a prefix', async () => {
    const s = submitVerdict(() => false)
    expect(s.description).toContain('reproduce the failing step')
    const first = await s.accept({ kind: 'app-broken', evidence: 'from the screenshot' })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.feedback).toMatch(/have not used the browser/)
    const second = await s.accept({ kind: 'app-broken', evidence: 'from the screenshot' })
    expect(second).toEqual({ ok: true, value: { kind: 'app-broken', evidence: `${UNPROBED_PREFIX}from the screenshot` } })
  })

  it('accepts a probed verdict first time, unprefixed, and still validates cause', async () => {
    const s = submitVerdict(() => true)
    expect(await s.accept({ kind: 'test-broken', cause: 'spec-wrong', evidence: 'saw it live' })).toEqual({
      ok: true,
      value: { kind: 'test-broken', cause: 'spec-wrong', evidence: 'saw it live' },
    })
    expect((await s.accept({ kind: 'test-broken', evidence: 'no cause' })).ok).toBe(false)
  })

  it('has no gate without a probe function (offline)', async () => {
    expect(await submitVerdict().accept({ kind: 'inconclusive', evidence: 'e' })).toEqual({ ok: true, value: { kind: 'inconclusive', evidence: 'e' } })
  })
})

describe('verdictFrom', () => {
  const unsub = <R extends 'turn-cap' | 'budget-cap' | 'ended'>(reason: R, lastText = 'hmm'): Unsubmitted<R> =>
    ({ status: 'unsubmitted', reason, lastText, usage }) as Unsubmitted<R>
  it('passes a submitted value through', () => {
    const value: Verdict = { kind: 'app-broken', evidence: 'x' }
    expect(verdictFrom({ status: 'submitted', value, usage })).toBe(value)
  })
  it('maps both caps to budget exhausted', () => {
    expect(verdictFrom(unsub('turn-cap'))).toEqual({ kind: 'inconclusive', evidence: 'budget exhausted' })
    expect(verdictFrom(unsub('budget-cap'))).toEqual({ kind: 'inconclusive', evidence: 'budget exhausted' })
  })
  it('maps ended with the last text', () => {
    expect(verdictFrom(unsub('ended', 'I could not log in'))).toEqual({ kind: 'inconclusive', evidence: 'agent ended without a verdict: I could not log in' })
  })
})

describe('triageTask', () => {
  it('quotes the failing step, the sources and the body, and states live mode', async () => {
    const project = makeProject(unsubmitted('ended'))
    const task = await triageTask(project, spec, failure('valid credentials', bodyHash), true)
    expect(task.prompt).toContain('Click the sign-in button')
    expect(task.prompt).toContain('Steps 2')
    expect(task.prompt).toContain('APP_SOURCE_MARKER')
    expect(task.prompt).toContain('SPEC_SOURCE_MARKER')
    expect(task.prompt).toContain('locator timed out')
    expect(task.prompt).toContain('BODY_MARKER')
    expect(task.prompt).not.toContain('GENERATED by libretto')
    expect(task.prompt).toContain(`live at ${baseURL}`)
    expect(task.system).toContain('spec-wrong')
    expect(task.system).toContain('generated-code-wrong')
    expect(task.browser).toMatchObject({ baseURL, storageState: null, headless: true })
    expect(task.browser?.outputDir.startsWith(path.join(ws.dir, 'agent-output'))).toBe(true)
    expect(task.submit.name).toBe('submit_verdict')
    expect(project.log.warn).toHaveBeenCalled() // missing secret falls back to none
  })

  it('live: the gate opens once the session makes a browser call', async () => {
    const task = await triageTask(makeProject(unsubmitted('ended')), spec, failure('valid credentials', bodyHash), true)
    expect(task.system).toContain('must reproduce the failing step')
    expect((await task.submit.accept({ kind: 'app-broken', evidence: 'e' })).ok).toBe(false)
    task.onEvent?.({ type: 'tool-call', server: 'playwright', tool: 'browser_navigate', input: {} })
    expect(await task.submit.accept({ kind: 'app-broken', evidence: 'e' })).toEqual({ ok: true, value: { kind: 'app-broken', evidence: 'e' } })
  })

  it('offline: no gate, a first unprobed verdict is accepted as is', async () => {
    const task = await triageTask(makeProject(unsubmitted('ended')), spec, failure('valid credentials', bodyHash), false)
    expect(await task.submit.accept({ kind: 'app-broken', evidence: 'e' })).toEqual({ ok: true, value: { kind: 'app-broken', evidence: 'e' } })
  })

  it('says outside any step when step is null', async () => {
    const task = await triageTask(makeProject(unsubmitted('ended')), spec, failure('valid credentials', bodyHash, 'run1', null), true)
    expect(task.prompt).toContain('outside any step')
  })

  it('offline: no browser and artifacts-only wording', async () => {
    const task = await triageTask(makeProject(unsubmitted('ended')), spec, failure('valid credentials', bodyHash), false)
    expect(task.browser).toBeNull()
    expect(task.prompt).toContain('unreachable')
    expect(task.prompt).toContain('artifacts only')
  })
})

describe('triageOne', () => {
  it('fills the record from a submitted verdict', async () => {
    const f = failure('valid credentials', bodyHash)
    const rec = await triageOne(makeProject(submitting({ kind: 'test-broken', cause: 'spec-wrong', evidence: 'button renamed' })), f, true)
    expect(rec).toMatchObject({
      failure: f.id,
      runId: 'run1',
      spec: specId,
      generated: f.generated,
      verdict: { kind: 'test-broken', cause: 'spec-wrong', evidence: 'button renamed' },
      live: true,
      model: 'test-model',
      usage,
    })
    expect(typeof (rec as { at: string }).at).toBe('string')
  })

  it('prefixes evidence when offline', async () => {
    const rec = await triageOne(makeProject(submitting({ kind: 'app-broken', evidence: 'dom lacks button' }), ), failure('valid credentials', bodyHash), false)
    expect(rec).toMatchObject({ live: false, verdict: { evidence: `[artifacts only: ${baseURL} unreachable] dom lacks button` } })
  })

  it('maps stop reasons and aborts', async () => {
    const f = failure('valid credentials', bodyHash)
    expect(await triageOne(makeProject(unsubmitted('turn-cap')), f, true)).toMatchObject({ verdict: { kind: 'inconclusive', evidence: 'budget exhausted' } })
    expect(await triageOne(makeProject(unsubmitted('aborted')), f, true)).toBe('aborted')
  })
})

describe('probe', () => {
  it('treats any HTTP response as reachable', async () => {
    expect(await probe(baseURL)).toBe(true)
  })
  it('is false for a closed port', async () => {
    expect(await probe(closedURL)).toBe(false)
  })
})

describe('triage', () => {
  async function run(agent: AgentRunner, options: Parameters<typeof triage>[0] = {}, suite?: Suite) {
    vi.mocked(openProject).mockResolvedValue(makeProject(agent, suite ? { suite } : {}))
    return triage(options)
  }

  it('throws without a recorded run', async () => {
    await expect(run(unsubmitted('ended'))).rejects.toThrow('no recorded run')
  })

  it('writes triage.json after each record; a crash keeps the first', async () => {
    const a = failure('valid credentials', bodyHash)
    const b = failure('second', bodyHash)
    await writeLastRun([a, b])
    let calls = 0
    const crashing: AgentRunner = {
      backend: 'scripted',
      async run<R>(task: AgentTask<R>) {
        if (++calls === 2) throw new Error('boom')
        return submitting({ kind: 'app-broken', evidence: 'e' }).run(task)
      },
    }
    await expect(run(crashing)).rejects.toThrow('boom')
    const log = await ws.readTriage()
    expect(Object.keys(log.records)).toEqual([a.id])

    // Re-run resumes: first is skipped as already triaged, second is triaged.
    const report = await run(submitting({ kind: 'inconclusive', evidence: 'e' }))
    expect(report.skipped).toEqual([{ failure: a.id, reason: 'already-triaged' }])
    expect(report.records.map((r) => r.failure)).toEqual([b.id])
    expect(report.live).toBe(true)
    expect(Object.keys((await ws.readTriage()).records).sort()).toEqual([a.id, b.id].sort())
  })

  it('force re-triages', async () => {
    const a = failure('valid credentials', bodyHash)
    await writeLastRun([a])
    await run(submitting({ kind: 'app-broken', evidence: 'first' }))
    const report = await run(submitting({ kind: 'app-broken', evidence: 'second' }), { force: true })
    expect(report.skipped).toEqual([])
    expect((await ws.readTriage()).records[a.id]?.verdict.evidence).toBe('second')
  })

  it('skips when the spec hash moved, spending no agent call', async () => {
    const a = failure('valid credentials', bodyHash)
    await writeLastRun([a])
    const agent = vi.fn()
    const moved = makeSuite({ ...spec, hash: 'spec-h2' as SpecHash })
    const report = await run({ backend: 'x', run: agent }, {}, moved)
    expect(report.skipped).toEqual([{ failure: a.id, reason: 'spec-changed-since-run' }])
    expect(agent).not.toHaveBeenCalled()
  })

  it('skips when the generated body moved', async () => {
    const a = failure('valid credentials', 'stale-body-hash')
    await writeLastRun([a])
    const agent = vi.fn()
    const report = await run({ backend: 'x', run: agent })
    expect(report.skipped).toEqual([{ failure: a.id, reason: 'generated-changed-since-run' }])
    expect(agent).not.toHaveBeenCalled()
  })

  it('reports live false and gives no browser when baseURL is unreachable', async () => {
    await writeLastRun([failure('valid credentials', bodyHash)])
    const seen: AgentTask<Verdict>[] = []
    vi.mocked(openProject).mockResolvedValue(makeProject(submitting({ kind: 'app-broken', evidence: 'e' }, seen), { baseURL: closedURL }))
    const report = await triage()
    expect(report.live).toBe(false)
    expect(seen[0]?.browser).toBeNull()
    expect(report.records[0]?.verdict.evidence).toContain('[artifacts only:')
  })

  it('stops without writing when a failure aborts', async () => {
    await writeLastRun([failure('valid credentials', bodyHash)])
    const report = await run(unsubmitted('aborted'))
    expect(report.records).toEqual([])
    expect(Object.keys((await ws.readTriage()).records)).toEqual([])
  })
})
