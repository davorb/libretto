import type { AgentResult, AgentRunner, AgentTask } from './types.js'
import { openSession } from './harness.js'
import { PLAYWRIGHT_SERVER } from './playwright-mcp.js'

export interface CopilotRunnerOptions {
  /** Passed to `new CopilotClient(...)`: token, BYOK provider, CLI path. Never read from config files. */
  readonly client?: Readonly<Record<string, unknown>>
}

/**
 * `AgentRunner` over `@github/copilot-sdk`.
 *
 * SDK mapping (the only place these vendor names appear):
 * - `createSession({ model, systemMessage: { content: task.system }, workingDirectory: task.cwd,
 *     tools: session.tools.map(t => defineTool(t.name, { description, parameters: t.schema, handler: t.invoke })),
 *     mcpServers: { playwright: { type: 'local', ...launch, tools: ['*'] } },
 *     availableTools: [...libretto names, 'playwright-*'] })` turns off built-ins.
 * - `onPermissionRequest`: approve only attached tools and deny the rest. Never
 *   `approveAll`, which throws under managed settings.
 * - Cancel: `task.signal` → `session.abort()`.
 *
 * Limits: the SDK has none, so this runner counts turns itself. On each
 * `assistant.turn_start` it increments `turns`; when `turns > profile.maxTurns` it calls
 * `session.abort()` and finishes with `turn-cap`. `profile.maxBudgetUsd` is always null
 * here (config types forbid it). `usage.costUsd` is null.
 * TODO(spike): confirm event names and that `availableTools` excludes all built-ins.
 */
export class CopilotRunner implements AgentRunner {
  readonly backend = 'copilot'

  constructor(private readonly options: CopilotRunnerOptions = {}) {}

  async run<R>(task: AgentTask<R>): Promise<AgentResult<R>> {
    const session = openSession(task, this.backend)
    // TODO:
    // const { CopilotClient, defineTool } = await import('@github/copilot-sdk')
    // let turns = 0, reason: StopReason = 'ended'
    // s.on('assistant.turn_start', () => { if (++turns > task.profile.maxTurns) { reason = 'turn-cap'; s.abort() } })
    // s.on('assistant.message', e => emit text; if (session.settled) s.abort())
    // s.on('tool.execution_start', e => emit tool-call with unprefix(e.toolName))
    // await s.sendAndWait({ prompt: task.prompt }) (abort resolves/rejects → map to reason)
    // finally: await s.destroy(); await client.stop()
    // return session.finish(reason, { turns, costUsd: null }, lastText)
    void session
    void PLAYWRIGHT_SERVER
    void this.options
    throw new Error('not implemented')
  }
}
