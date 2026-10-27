import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResult, AgentRunner, AgentTask } from '../agent/index.js'
import type { Project } from '../project/index.js'
import { loadSuite, type SpecId } from '../spec/index.js'
import { openWorkspace, type FailureId, type RunId, type TriageRecord, type Verdict, type Workspace } from '../workspace/index.js'

vi.mock('../project/index.js', () => ({ openProject: vi.fn() }))
vi.mock('../generate/index.js', () => ({ generateSpecs: vi.fn() }))

import { generateSpecs } from '../generate/index.js'
import { openProject } from '../project/index.js'
import { fix, type FixProposal } from './index.js'

const usage = { turns: 2, costUsd: 0.1 }
const spec = (title: string, step = 'Click Sign in') => `# ${title}\n## Scenario: valid\nSteps:\n- ${step}\nExpect:\n- See the dashboard\n`
const GEN_REPORT = { written: [], fresh: [], failed: [] }

let root: string
let ws: Workspace
let server: http.Server
let baseURL: string
let closedURL: string
let logWarn: ReturnType<typeof vi.fn>

async function layout(files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, 'specs', rel)), { recursive: true })
    await writeFile(path.join(root, 'specs', rel), content)
  }
}

async function makeProject(agent: AgentRunner, url = baseURL): Promise<Project> {
  const specsDir = path.join(root, 'specs')
  return {
    config: { root, specsDir, baseURL: url, profiles: { fix: { model: 'fix-model', maxTurns: 5, maxBudgetUsd: 1 } } },
    suite: await loadSuite(specsDir),
    workspace: ws,
    log: { info: vi.fn(), warn: logWarn, error: vi.fn(), agent: vi.fn() },
    signal: undefined,
    agent,
  } as unknown as Project
}

async function triaged(project: Project, specId: string, verdict: Verdict, scenario = 'valid'): Promise<TriageRecord> {
  const s = project.suite.specs.get(specId as SpecId)!
  await ws.writeGenerated({ spec: s.id, specHash: s.hash, appHash: project.suite.app.hash, body: `// body of ${specId}\n` }, s.file)
  const failure = `${specId}::chromium::${scenario}` as FailureId
  const record: TriageRecord = {
    failure,
    runId: 'r1' as RunId,
    spec: s.id,
    generated: { specHash: s.hash, appHash: project.suite.app.hash, bodyHash: (await ws.stamp(s.id))!.bodyHash },
    verdict,
    live: true,
    model: 'm',
    usage,
    at: 'now',
  }
  const log = await ws.readTriage()
  await ws.writeTriage({ records: { ...log.records, [failure]: record } })
  return record
}

const specWrong = (evidence = 'button renamed to Log in'): Verdict => ({ kind: 'test-broken', cause: 'spec-wrong', evidence })
const codeWrong = (evidence = 'locator is brittle'): Verdict => ({ kind: 'test-broken', cause: 'generated-code-wrong', evidence })

/** Submits `edit(task)` through the task's own submit tool, like a real agent. */
function scripted(edit: (task: AgentTask<unknown>) => unknown, seen: AgentTask<unknown>[] = []): AgentRunner {
  return {
    backend: 'scripted',
    async run<R>(task: AgentTask<R>): Promise<AgentResult<R>> {
      seen.push(task as AgentTask<unknown>)
      const accepted = await task.submit.accept(task.submit.input.parse(edit(task as AgentTask<unknown>)))
      return accepted.ok ? { status: 'submitted', value: accepted.value, usage } : { status: 'unsubmitted', reason: 'ended', lastText: accepted.feedback, usage }
    },
  }
}

const unsubmitted = (reason: 'turn-cap' | 'ended' | 'aborted', lastText = 'gave up'): AgentRunner => ({
  backend: 'scripted',
  run: async <R>() => ({ status: 'unsubmitted', reason, lastText, usage }) as AgentResult<R>,
})

const never: AgentRunner = { backend: 'never', run: () => Promise.reject(new Error('agent must not be called')) }

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'libretto-fix-cmd-'))
  ws = openWorkspace(root, path.join(root, 'specs'))
  logWarn = vi.fn()
  server = http.createServer((_, res) => res.writeHead(200).end('ok'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const closed = http.createServer()
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
  closedURL = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`
  await new Promise((r) => closed.close(r))
  await layout({ 'app.md': '# APP_MARKER\n' })
  vi.mocked(generateSpecs).mockResolvedValue(GEN_REPORT)
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  await rm(root, { recursive: true, force: true })
  vi.mocked(openProject).mockReset()
  vi.mocked(generateSpecs).mockReset()
})

describe('fix', () => {
  it('proposes a regenerate for generated-code-wrong without calling the agent, then regenerates with the reason as hint', async () => {
    await layout({ 'cart.md': spec('Cart') })
    const project = await makeProject(never)
    await triaged(project, 'cart', codeWrong())
    const second = await makeProject(never)
    vi.mocked(openProject).mockResolvedValueOnce(project).mockResolvedValueOnce(second)
    const confirm = vi.fn(async () => true)

    const report = await fix({ confirm })

    expect(confirm).toHaveBeenCalledWith({ kind: 'regenerate', spec: 'cart', reason: 'locator is brittle' })
    expect(report.applied).toHaveLength(1)
    expect(generateSpecs).toHaveBeenCalledTimes(1)
    expect(generateSpecs).toHaveBeenCalledWith(second, ['cart'], { force: true, hints: new Map([['cart', 'locator is brittle']]) })
    expect(report.generated).toBe(GEN_REPORT)
  })

  it('shows an edit-spec proposal with a diff, applies it with writeSpec, and regenerates from the reloaded project', async () => {
    await layout({ 'auth/login.md': spec('Login') })
    const seen: AgentTask<unknown>[] = []
    const agent = scripted(() => ({ markdown: spec('Login', 'Click Log in'), summary: 'button renamed' }), seen)
    const project = await makeProject(agent)
    await triaged(project, 'auth/login', specWrong())
    const second = await makeProject(agent)
    vi.mocked(openProject).mockResolvedValueOnce(project).mockResolvedValueOnce(second)
    const proposals: FixProposal[] = []

    const report = await fix({ confirm: async (p) => (proposals.push(p), true) })

    expect(proposals).toHaveLength(1)
    const proposal = proposals[0]!
    expect(proposal.kind).toBe('edit-spec')
    if (proposal.kind !== 'edit-spec') return
    expect(proposal.diff).toContain('-- Click Sign in')
    expect(proposal.diff).toContain('+- Click Log in')
    expect(proposal.summary).toBe('button renamed')
    expect(await readFile(path.join(root, 'specs/auth/login.md'), 'utf8')).toBe(spec('Login', 'Click Log in'))
    expect(report.applied).toEqual([proposal])
    expect(generateSpecs).toHaveBeenCalledWith(second, ['auth/login'], { force: true, hints: new Map() })

    const task = seen[0]!
    expect(task.browser?.baseURL).toBe(baseURL)
    expect(task.browser?.outputDir).toContain(path.join('agent-output', 'fix-auth_login'))
    expect(task.profile.model).toBe('fix-model')
    expect(task.prompt).toContain('APP_MARKER')
    expect(task.prompt).toContain('Click Sign in')
    expect(task.prompt).toContain('// body of auth/login')
    expect(task.prompt).toContain('button renamed to Log in')
    expect(task.prompt).toContain('propose_spec_edit')
  })

  it('regenerates specs that use an edited fixture, since the edit made them stale', async () => {
    const fixture = (step: string) => `# Logged in\nSteps:\n- ${step}\n`
    await layout({
      'fixtures/logged-in.md': fixture('Click Sign in'),
      'home/logout.md': `---\nuses: [logged-in]\n---\n${spec('Logout', 'Click Log out')}`,
      'auth/login.md': spec('Login', 'Open the login page'),
    })
    const agent = scripted(() => ({ markdown: fixture('Click Log in'), summary: 'button renamed' }))
    const project = await makeProject(agent)
    await triaged(project, 'fixtures/logged-in', specWrong(), 'Logged in')
    const second = await makeProject(agent)
    vi.mocked(openProject).mockResolvedValueOnce(project).mockResolvedValueOnce(second)

    await fix({ confirm: async () => true })

    expect(generateSpecs).toHaveBeenCalledTimes(1)
    const ids = vi.mocked(generateSpecs).mock.calls[0]![1]
    expect(ids).toEqual(['fixtures/logged-in', 'home/logout'])
  })

  it('does not write a declined proposal and does not regenerate', async () => {
    await layout({ 'auth/login.md': spec('Login') })
    const agent = scripted(() => ({ markdown: spec('Login', 'Click Log in'), summary: 's' }))
    const project = await makeProject(agent)
    await triaged(project, 'auth/login', specWrong())
    vi.mocked(openProject).mockResolvedValueOnce(project)

    const report = await fix({ confirm: async () => false })

    expect(await readFile(path.join(root, 'specs/auth/login.md'), 'utf8')).toBe(spec('Login'))
    expect(report.declined).toHaveLength(1)
    expect(report.applied).toHaveLength(0)
    expect(generateSpecs).not.toHaveBeenCalled()
    expect(openProject).toHaveBeenCalledTimes(1)
  })

  it('marks spec-wrong specs unresolved when baseURL is unreachable, and still proposes regenerates', async () => {
    await layout({ 'a.md': spec('A'), 'b.md': spec('B') })
    const project = await makeProject(never, closedURL)
    await triaged(project, 'a', specWrong())
    await triaged(project, 'b', codeWrong())
    const second = await makeProject(never, closedURL)
    vi.mocked(openProject).mockResolvedValueOnce(project).mockResolvedValueOnce(second)
    const confirm = vi.fn(async () => true)

    const report = await fix({ confirm })

    expect(report.unresolved).toEqual([{ spec: 'a', detail: expect.stringContaining('unreachable') }])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'regenerate', spec: 'b' }))
    expect(generateSpecs).toHaveBeenCalledWith(second, ['b'], expect.anything())
  })

  it('does not probe or warn about baseURL when only regenerates are pending', async () => {
    await layout({ 'b.md': spec('B') })
    const project = await makeProject(never, closedURL)
    await triaged(project, 'b', codeWrong())
    vi.mocked(openProject).mockResolvedValueOnce(project).mockResolvedValueOnce(project)

    await fix({ confirm: async () => true })

    expect(logWarn).not.toHaveBeenCalled()
  })

  it('confirms proposals in spec order', async () => {
    await layout({ 'b.md': spec('B'), 'a.md': spec('A'), 'c.md': spec('C') })
    const project = await makeProject(never)
    await triaged(project, 'c', codeWrong())
    await triaged(project, 'a', codeWrong())
    await triaged(project, 'b', codeWrong())
    vi.mocked(openProject).mockResolvedValue(project)
    const order: string[] = []

    await fix({ confirm: async (p) => (order.push(p.spec), true) })

    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('reports an agent that gives up as unresolved and moves on', async () => {
    await layout({ 'a.md': spec('A') })
    const project = await makeProject(unsubmitted('turn-cap'))
    await triaged(project, 'a', specWrong())
    vi.mocked(openProject).mockResolvedValue(project)
    const confirm = vi.fn(async () => true)

    const report = await fix({ confirm })

    expect(report.unresolved).toEqual([{ spec: 'a', detail: expect.stringContaining('budget') }])
    expect(confirm).not.toHaveBeenCalled()
    expect(generateSpecs).not.toHaveBeenCalled()
  })

  it('skips records whose spec was already edited since the verdict', async () => {
    await layout({ 'a.md': spec('A') })
    const project = await makeProject(never)
    await triaged(project, 'a', specWrong())
    await writeFile(path.join(root, 'specs/a.md'), spec('A', 'Click Log in'))
    vi.mocked(openProject).mockResolvedValue(await makeProject(never))
    const confirm = vi.fn(async () => true)

    const report = await fix({ confirm })

    expect(confirm).not.toHaveBeenCalled()
    expect(report).toEqual({ applied: [], declined: [], unresolved: [], generated: GEN_REPORT })
  })

  it('limits proposals to the selected specs', async () => {
    await layout({ 'a.md': spec('A'), 'b.md': spec('B') })
    const project = await makeProject(never)
    await triaged(project, 'a', codeWrong())
    await triaged(project, 'b', codeWrong())
    vi.mocked(openProject).mockResolvedValue(project)
    const order: string[] = []

    await fix({ specs: ['b'], confirm: async (p) => (order.push(p.spec), true) })

    expect(order).toEqual(['b'])
  })
})
