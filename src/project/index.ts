import { createAgentRunner, type AgentRunner } from '../agent/index.js'
import { loadConfig, type ResolvedConfig } from '../config/index.js'
import { loadSuite, type Suite } from '../spec/index.js'
import { openWorkspace, type Workspace } from '../workspace/index.js'
import { consoleLogger, type Logger } from '../log/index.js'

/** Options shared by all four commands' programmatic API. */
export interface CommandOptions {
  /** Default `process.cwd()`. The config is found by walking up from here. */
  readonly cwd?: string
  /** Explicit config path. */
  readonly config?: string
  /** Spec selectors, as on the CLI. Empty means all. */
  readonly specs?: readonly string[]
  readonly log?: Logger
  readonly signal?: AbortSignal
  /** Replaces the configured backend: tests, or a custom `AgentRunner`. Ignored by `run`. */
  readonly agent?: AgentRunner
}

/** Everything a command needs, loaded once. */
export interface Project {
  readonly config: ResolvedConfig
  readonly suite: Suite
  readonly workspace: Workspace
  readonly log: Logger
  readonly signal: AbortSignal | undefined
  /** `options.agent` or `createAgentRunner(config.backend)`. Constructing it loads no SDK. */
  readonly agent: AgentRunner
}

/**
 * The deterministic subset. `run` and the Playwright helpers take this, so they cannot
 * reach an agent: "run never calls AI" is a type error to violate.
 */
export type RunContext = Omit<Project, 'agent'>

/** loadConfig → loadSuite (throws SpecError) → openWorkspace. */
export async function openProject(options: CommandOptions): Promise<Project> {
  const config = await loadConfig(options.cwd ?? process.cwd(), options.config)
  const suite = await loadSuite(config.specsDir)
  const workspace = openWorkspace(config.root, config.specsDir)
  return {
    config,
    suite,
    workspace,
    log: options.log ?? consoleLogger({ verbose: false }),
    signal: options.signal,
    agent: options.agent ?? createAgentRunner(config.backend),
  }
}
