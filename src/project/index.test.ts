import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunner } from '../agent/index.js'
import type { ResolvedConfig } from '../config/index.js'
import type { Logger } from '../log/index.js'

const config: ResolvedConfig = {
  root: '/proj',
  baseURL: 'http://x',
  specsDir: '/proj/specs',
  backend: 'copilot',
  headless: true,
  playwrightConfig: null,
  profiles: {
    generate: { model: 'm', maxTurns: 1, maxBudgetUsd: null },
    triage: { model: 'm', maxTurns: 1, maxBudgetUsd: null },
    fix: { model: 'm', maxTurns: 1, maxBudgetUsd: null },
  },
}
const suite = { stub: 'suite' }
const workspace = { stub: 'workspace' }
const created: AgentRunner = { backend: 'created', run: vi.fn() }

const loadConfig = vi.fn(async () => config)
const loadSuite = vi.fn(async () => suite)
const openWorkspace = vi.fn(() => workspace)
const createAgentRunner = vi.fn(() => created)

vi.mock('../config/index.js', () => ({ loadConfig }))
vi.mock('../spec/index.js', () => ({ loadSuite }))
vi.mock('../workspace/index.js', () => ({ openWorkspace }))
vi.mock('../agent/index.js', () => ({ createAgentRunner }))

const { openProject } = await import('./index.js')

afterEach(() => vi.clearAllMocks())

describe('openProject', () => {
  it('wires config, suite, workspace and the configured backend', async () => {
    const project = await openProject({ cwd: '/work', config: 'c.ts' })
    expect(loadConfig).toHaveBeenCalledWith('/work', 'c.ts')
    expect(loadSuite).toHaveBeenCalledWith('/proj/specs')
    expect(openWorkspace).toHaveBeenCalledWith('/proj', '/proj/specs')
    expect(createAgentRunner).toHaveBeenCalledWith('copilot')
    expect(project).toMatchObject({ config, suite, workspace, agent: created, signal: undefined })
    expect(typeof project.log.info).toBe('function')
  })

  it('uses the supplied agent, logger and signal instead of defaults', async () => {
    const agent: AgentRunner = { backend: 'fake', run: vi.fn() }
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), agent: vi.fn() }
    const signal = new AbortController().signal
    const project = await openProject({ agent, log, signal })
    expect(createAgentRunner).not.toHaveBeenCalled()
    expect(project.agent).toBe(agent)
    expect(project.log).toBe(log)
    expect(project.signal).toBe(signal)
    expect(loadConfig).toHaveBeenCalledWith(process.cwd(), undefined)
  })

  it('does not open a workspace when the suite fails to load', async () => {
    loadSuite.mockRejectedValueOnce(new Error('bad spec'))
    await expect(openProject({})).rejects.toThrow('bad spec')
    expect(openWorkspace).not.toHaveBeenCalled()
  })
})
