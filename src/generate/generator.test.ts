import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResult, AgentRunner, AgentTask } from '../agent/index.js'
import type { Logger } from '../log/index.js'
import type { Project } from '../project/index.js'
import type { AppHash, AppSpec, Scenario, Spec, SpecHash, SpecId, Step, Suite } from '../spec/index.js'
import { openWorkspace, parseHeader, type Workspace } from '../workspace/index.js'
import { FixtureNotReadyError, prepareStorageState, runDraft } from '../run/index.js'
import { openProject } from '../project/index.js'
import type { TestDraft } from './draft.js'
import { generateOne } from './generator.js'
import { generate, generateSpecs } from './index.js'

vi.mock('../run/index.js', async () => {
  class FixtureNotReadyError extends Error {
    override readonly name = 'FixtureNotReadyError'
    constructor(
      readonly fixture: string,
      readonly why: string,
    ) {
      super(`Fixture ${fixture} is ${why}`)
    }
  }
  return { runDraft: vi.fn(), prepareStorageState: vi.fn(), FixtureNotReadyError }
})
vi.mock('../project/index.js', () => ({ openProject: vi.fn() }))

const runDraftMock = vi.mocked(runDraft)
const prepareMock = vi.mocked(prepareStorageState)

const step = (scenario: string, section: 'steps' | 'expect', index: number, text: string, envRefs: string[] = []): Step => ({
  ref: { scenario, section, index },
  text,
  envRefs,
})

function makeSpec(id: string, over: { uses?: string; envRefs?: string[]; stepText?: string } = {}): Spec {
  const name = 'valid credentials'
  const envRefs = over.envRefs ?? []
  const scenario: Scenario = {
    name,
    steps: [step(name, 'steps', 1, over.stepText ?? 'Open the login page', envRefs)],
    expect: [step(name, 'expect', 1, 'Welcome is visible')],
  }
  return {
    id: id as SpecId,
    kind: id.startsWith('fixtures/') ? 'fixture' : 'scenario',
    file: `/specs/${id}.md`,
    title: id,
    tags: [],
    uses: (over.uses ?? null) as SpecId | null,
    scenarios: [scenario],
    envRefs,
    source: `# ${id}\nsource of ${id}`,
    hash: `hash-${id}` as SpecHash,
  }
}

function makeSuite(specs: Spec[]): Suite {
  const map = new Map(specs.map((s) => [s.id, s]))
  const app: AppSpec = { file: '/specs/app.md', source: 'APP DESCRIPTION', hash: 'app-hash' as AppHash }
  const chainOf = (spec: Spec): Spec[] => (spec.uses === null ? [] : [...chainOf(map.get(spec.uses)!), map.get(spec.uses)!])
  return {
    app,
    specs: map,
    select: (selectors) => specs.filter((s) => selectors.length === 0 || selectors.includes(s.id)),
    fixtureChain: chainOf,
    withEdit: () => [],
  }
}

const goodDraft = (steps = ["await page.goto('/login')"]): TestDraft => ({
  helpers: '',
  scenarios: [{ name: 'valid credentials', steps, expect: ["await expect(page.getByText('Welcome')).toBeVisible()"] }],
})

type Script = (task: AgentTask<unknown>) => Promise<AgentResult<unknown>>
const usage = { turns: 1, costUsd: 0 }

/** Calls the task's own submit.accept with each draft in turn until one is accepted. */
function scripted(drafts: TestDraft[]): AgentRunner & { tasks: AgentTask<unknown>[]; feedback: string[] } {
  const tasks: AgentTask<unknown>[] = []
  const feedback: string[] = []
  return {
    backend: 'scripted',
    tasks,
    feedback,
    async run<R>(task: AgentTask<R>): Promise<AgentResult<R>> {
      tasks.push(task)
      for (const draft of drafts) {
        const verdict = await task.submit.accept(task.submit.input.parse(draft))
        if (verdict.ok) return { status: 'submitted', value: verdict.value, usage }
        feedback.push(verdict.feedback)
      }
      return { status: 'unsubmitted', reason: 'ended', lastText: feedback.at(-1) ?? '', usage }
    },
  }
}

let root: string
let workspace: Workspace
let warnings: string[]

function project(specs: Spec[], agent: AgentRunner): Project {
  const log: Logger = { info: () => {}, warn: (m) => void warnings.push(m), error: () => {}, agent: () => {} }
  return {
    config: {
      root,
      baseURL: 'http://localhost:3000',
      profiles: { generate: { model: 'm', maxTurns: 5, maxBudgetUsd: null }, triage: { model: 'm', maxTurns: 5, maxBudgetUsd: null }, fix: { model: 'm', maxTurns: 5, maxBudgetUsd: null } },
    },
    suite: makeSuite(specs),
    workspace,
    log,
    signal: undefined,
    agent,
  } as unknown as Project
}

async function writeFresh(spec: Spec, suite: Suite) {
  await workspace.writeGenerated({ spec: spec.id, specHash: spec.hash, appHash: suite.app.hash, body: 'body\n' }, spec.file)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'libretto-gen-'))
  workspace = openWorkspace(root, path.join(root, 'specs'))
  warnings = []
  runDraftMock.mockReset().mockResolvedValue({ passed: true })
  prepareMock.mockReset().mockResolvedValue(null)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('generateOne', () => {
  it('skips a fresh spec without calling the agent', async () => {
    const spec = makeSpec('auth/login')
    const agent = scripted([goodDraft()])
    const p = project([spec], agent)
    await writeFresh(spec, p.suite)
    expect(await generateOne(p, spec, { force: false, hint: null })).toEqual({ status: 'fresh', spec: spec.id })
    expect(agent.tasks).toHaveLength(0)
  })

  it('regenerates a fresh spec with force', async () => {
    const spec = makeSpec('auth/login')
    const agent = scripted([goodDraft()])
    const p = project([spec], agent)
    await writeFresh(spec, p.suite)
    expect((await generateOne(p, spec, { force: true, hint: null })).status).toBe('written')
    expect(agent.tasks).toHaveLength(1)
  })

  it('writes a stale spec with the header and the rendered steps', async () => {
    const spec = makeSpec('auth/login')
    const p = project([spec], scripted([goodDraft()]))
    expect(await generateOne(p, spec, { force: false, hint: null })).toEqual({ status: 'written', spec: spec.id, replaced: 'missing' })
    const text = await readFile(workspace.generatedFile(spec.id), 'utf8')
    expect(parseHeader(text)?.header.specHash).toBe(spec.hash)
    expect(text).toContain('Steps 1: Open the login page')
    expect(text).toContain("await page.goto('/login')")
  })

  it('regenerates when only app.md changed', async () => {
    const spec = makeSpec('auth/login')
    const agent = scripted([goodDraft()])
    const p = project([spec], agent)
    await workspace.writeGenerated({ spec: spec.id, specHash: spec.hash, appHash: 'old-app' as AppHash, body: 'body\n' }, spec.file)
    const result = await generateOne(p, spec, { force: false, hint: null })
    expect(result).toEqual({ status: 'written', spec: spec.id, replaced: 'app-changed' })
  })

  it('warns naming the file when it overwrites a hand edit', async () => {
    const spec = makeSpec('auth/login')
    const p = project([spec], scripted([goodDraft()]))
    await writeFresh(spec, p.suite)
    const file = workspace.generatedFile(spec.id)
    await import('node:fs/promises').then(async (fs) => fs.writeFile(file, (await fs.readFile(file, 'utf8')) + '// my edit\n'))
    const result = await generateOne(p, spec, { force: false, hint: null })
    expect(result).toMatchObject({ status: 'written', replaced: 'hand-edited' })
    expect(warnings.some((w) => w.includes(file))).toBe(true)
  })

  it('warns when a secret value is too short to redact', async () => {
    vi.stubEnv('PASSWORD', 'abc')
    const spec = makeSpec('auth/login', { envRefs: ['PASSWORD'], stepText: 'Enter {{env.PASSWORD}}' })
    const p = project([spec], scripted([goodDraft(['await page.fill("#p", process.env.PASSWORD!)'])]))
    await generateOne(p, spec, { force: false, hint: null })
    expect(warnings.some((w) => w.includes('PASSWORD') && w.includes('too short'))).toBe(true)
  })

  it('rejects a bad draft with the checkDraft problems and lets the agent retry', async () => {
    const spec = makeSpec('auth/login')
    const bad: TestDraft = { helpers: '', scenarios: [{ name: 'valid credentials', steps: [], expect: [] }] }
    const agent = scripted([bad, goodDraft()])
    const result = await generateOne(project([spec], agent), spec, { force: false, hint: null })
    expect(result.status).toBe('written')
    expect(agent.feedback).toHaveLength(1)
    expect(agent.feedback[0]).toContain('valid credentials')
    expect(agent.feedback[0]).toContain('one code block per Steps bullet')
    expect(runDraftMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a leaked secret naming only the env var', async () => {
    vi.stubEnv('PASSWORD', 'hunter2-long-value')
    const spec = makeSpec('auth/login', { envRefs: ['PASSWORD'], stepText: 'Enter {{env.PASSWORD}}' })
    const leaky = goodDraft(['await page.fill("#p", process.env.PASSWORD!) // hunter2-long-value'])
    const agent = scripted([leaky])
    const result = await generateOne(project([spec], agent), spec, { force: false, hint: null })
    expect(result).toMatchObject({ status: 'failed', reason: 'ended' })
    expect(agent.feedback[0]).toContain('PASSWORD')
    expect(agent.feedback[0]).not.toContain('hunter2-long-value')
    expect(runDraftMock).not.toHaveBeenCalled()
  })

  it('rejects a draft that fails against the app, naming the step title', async () => {
    runDraftMock.mockResolvedValueOnce({
      passed: false,
      failure: { scenario: 'valid credentials', step: { scenario: 'valid credentials', section: 'steps', index: 1 }, error: { message: 'locator not found', stack: null } },
      output: 'LIST OUTPUT line',
    })
    const spec = makeSpec('auth/login')
    const agent = scripted([goodDraft(), goodDraft(["await page.goto('/sign-in')"])])
    const result = await generateOne(project([spec], agent), spec, { force: false, hint: null })
    expect(result.status).toBe('written')
    expect(agent.feedback[0]).toContain('Steps 1: Open the login page')
    expect(agent.feedback[0]).toContain('locator not found')
    expect(agent.feedback[0]).toContain('LIST OUTPUT line')
    expect(runDraftMock).toHaveBeenCalledTimes(2)
  })

  it('renders a fixture so it saves its storage state, and a dependent so it loads one', async () => {
    const fixture = makeSpec('fixtures/logged-in')
    const dependent = makeSpec('auth/account', { uses: fixture.id })
    prepareMock.mockResolvedValue(workspace.stateFile(fixture.id))
    const p = project([fixture, dependent], scripted([goodDraft()]))
    await generateOne(p, fixture, { force: false, hint: null })
    await generateOne(p, dependent, { force: false, hint: null })
    const fixtureFile = await readFile(workspace.generatedFile(fixture.id), 'utf8')
    const dependentFile = await readFile(workspace.generatedFile(dependent.id), 'utf8')
    expect(fixtureFile).toContain('storageState({ path: ".libretto/state/fixtures/logged-in.json" })')
    expect(dependentFile).toContain('test.use({ storageState: ".libretto/state/fixtures/logged-in.json" })')
    expect(fixtureFile + dependentFile).not.toContain(workspace.root)
    expect(runDraftMock.mock.calls[1]![3]).toBe(workspace.stateFile(fixture.id))
  })

  it('fails with missing-secrets and no agent call when an env var is unset', async () => {
    vi.stubEnv('PASSWORD', '')
    const spec = makeSpec('auth/login', { envRefs: ['PASSWORD'] })
    const agent = scripted([goodDraft()])
    const result = await generateOne(project([spec], agent), spec, { force: false, hint: null })
    expect(result).toMatchObject({ status: 'failed', reason: 'missing-secrets' })
    expect(result).toMatchObject({ detail: expect.stringContaining('PASSWORD') })
    expect(agent.tasks).toHaveLength(0)
  })

  it('fails with fixture-not-ready and no agent call when the fixture chain is not ready', async () => {
    prepareMock.mockRejectedValue(new FixtureNotReadyError('fixtures/logged-in' as SpecId, 'setup-failed'))
    const fixture = makeSpec('fixtures/logged-in')
    const dependent = makeSpec('auth/account', { uses: fixture.id })
    const agent = scripted([goodDraft()])
    const result = await generateOne(project([fixture, dependent], agent), dependent, { force: false, hint: null })
    expect(result).toMatchObject({ status: 'failed', reason: 'fixture-not-ready' })
    expect(agent.tasks).toHaveLength(0)
  })

  it('leaves the generated file untouched when the agent gives up', async () => {
    const spec = makeSpec('auth/login')
    const bad: TestDraft = { helpers: '', scenarios: [{ name: 'nope', steps: [], expect: [] }] }
    const result = await generateOne(project([spec], scripted([bad])), spec, { force: false, hint: null })
    expect(result).toMatchObject({ status: 'failed', reason: 'ended' })
    expect(await workspace.staleness(spec, makeSuite([spec]).app)).toBe('missing')
  })
})

describe('generationTask', () => {
  it('puts app, fixture chain, spec, contract, hint, and secret names in the prompt', async () => {
    vi.stubEnv('PASSWORD', 'hunter2-long-value')
    const fixture = makeSpec('fixtures/logged-in')
    const spec = makeSpec('auth/account', { uses: fixture.id, envRefs: ['PASSWORD'], stepText: 'Enter {{env.PASSWORD}}' })
    const agent = scripted([])
    const p = project([fixture, spec], agent)
    prepareMock.mockResolvedValue('/state/logged-in.json')
    await generateOne(p, spec, { force: false, hint: 'the button moved' })
    const task = agent.tasks[0]!
    expect(task.label).toBe('generate auth/account')
    expect(task.prompt).toContain('APP DESCRIPTION')
    expect(task.prompt).toContain('Already done before this test starts')
    expect(task.prompt).toContain('source of fixtures/logged-in')
    expect(task.prompt).toContain('source of auth/account')
    expect(task.prompt).toContain('"valid credentials": steps 1, expect 1')
    expect(task.prompt).toContain('the button moved')
    expect(task.prompt).toContain('PASSWORD')
    expect(task.prompt + task.system).not.toContain('hunter2-long-value')
    expect(task.system).toContain('process.env.NAME')
    expect(task.system).toContain('waitForTimeout')
    expect(task.browser).toMatchObject({
      baseURL: 'http://localhost:3000',
      storageState: '/state/logged-in.json',
      headless: true,
      outputDir: path.join(workspace.dir, 'agent-output', 'auth__account'),
    })
    expect(task.profile).toEqual(p.config.profiles.generate)
  })

  it('hands the agent a write_test submission over the testDraft schema', async () => {
    const spec = makeSpec('auth/login')
    const agent = scripted([])
    await generateOne(project([spec], agent), spec, { force: false, hint: null })
    expect(agent.tasks[0]!.submit.name).toBe('write_test')
    expect(Object.keys(agent.tasks[0]!.submit.input.shape)).toEqual(['helpers', 'scenarios'])
  })
})

describe('generateSpecs', () => {
  const trio = () => {
    const base = makeSpec('fixtures/base')
    const loggedIn = makeSpec('fixtures/logged-in', { uses: base.id })
    const a = makeSpec('auth/a', { uses: loggedIn.id })
    const b = makeSpec('auth/b', { uses: loggedIn.id })
    return [a, b, loggedIn, base]
  }

  it('generates fixtures before dependents, deduped, sequentially', async () => {
    const agent = scripted([goodDraft()])
    const specs = trio()
    const report = await generateSpecs(project(specs, agent), ['auth/a', 'auth/b'] as SpecId[], { force: false, hints: new Map() })
    expect(agent.tasks.map((t) => t.label)).toEqual(['generate fixtures/base', 'generate fixtures/logged-in', 'generate auth/a', 'generate auth/b'])
    expect(report.written.map((w) => w.spec)).toEqual(['fixtures/base', 'fixtures/logged-in', 'auth/a', 'auth/b'])
    expect(report.failed).toEqual([])
  })

  it('marks dependents fixture-not-ready without calling the agent when a fixture fails', async () => {
    const bad: TestDraft = { helpers: '', scenarios: [{ name: 'nope', steps: [], expect: [] }] }
    const agent = scripted([bad])
    const report = await generateSpecs(project(trio(), agent), ['auth/a', 'auth/b'] as SpecId[], { force: false, hints: new Map() })
    expect(agent.tasks.map((t) => t.label)).toEqual(['generate fixtures/base'])
    expect(report.failed.map((f) => [f.spec, f.reason])).toEqual([
      ['fixtures/base', 'ended'],
      ['fixtures/logged-in', 'fixture-not-ready'],
      ['auth/a', 'fixture-not-ready'],
      ['auth/b', 'fixture-not-ready'],
    ])
    expect(report.failed[1]!.detail).toContain('fixtures/base')
  })

  it('applies force to the selected specs only, never to their fixtures', async () => {
    const agent = scripted([goodDraft()])
    const specs = trio()
    const p = project(specs, agent)
    for (const s of specs) await writeFresh(s, p.suite)
    const report = await generateSpecs(p, ['auth/a'] as SpecId[], { force: true, hints: new Map() })
    expect(report.fresh).toEqual(['fixtures/base', 'fixtures/logged-in'])
    expect(report.written.map((w) => w.spec)).toEqual(['auth/a'])
    expect(agent.tasks.map((t) => t.label)).toEqual(['generate auth/a'])
  })

  it('passes each spec its own hint', async () => {
    const agent = scripted([goodDraft()])
    const a = makeSpec('auth/a')
    await generateSpecs(project([a], agent), [a.id], { force: false, hints: new Map([[a.id, 'try the other button']]) })
    expect(agent.tasks[0]!.prompt).toContain('try the other button')
  })
})

describe('generate', () => {
  it('opens the project, selects specs, and reports', async () => {
    const spec = makeSpec('auth/login')
    const agent = scripted([goodDraft()])
    vi.mocked(openProject).mockResolvedValue(project([spec], agent))
    const report = await generate({ specs: ['auth/login'] })
    expect(report.written.map((w) => w.spec)).toEqual(['auth/login'])
  })
})
