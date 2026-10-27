import type { AgentResult, AgentRunner, AgentTask } from './types.js'
import { openSession } from './harness.js'
import { PLAYWRIGHT_SERVER } from './playwright-mcp.js'

/** Options a user may pass when constructing the runner directly. Auth stays in env vars, per the SDK. */
export interface ClaudeRunnerOptions {
  /** Extra env for the Claude Code subprocess (e.g. `ANTHROPIC_API_KEY`, Bedrock/Vertex switches). */
  readonly env?: Readonly<Record<string, string>>
}

const LIBRETTO_SERVER = 'libretto'

/**
 * `AgentRunner` over `@anthropic-ai/claude-agent-sdk`'s `query()`.
 *
 * SDK option mapping (the only place these vendor names appear):
 * - `tools: []` turns off every built-in (Read, Edit, Bash, WebFetch...).
 * - `mcpServers`: `{ playwright: { type: 'stdio', ...launch }, libretto: createSdkMcpServer({ tools: session.tools.map(t => tool(t.name, t.description, t.shape, t.invoke)) }) }`
 * - `allowedTools`: `mcp__playwright__*` (if attached) and `mcp__libretto__<name>` for each tool.
 * - `canUseTool`: deny anything not in the allowlist. Defense in depth over `tools: []`.
 * - `settingSources: []`: the user's ~/.claude settings, hooks, and CLAUDE.md never load.
 * - `env`: `process.env` minus every name in `task.browser.secrets.names`, plus
 *   `options.env`. The Claude Code subprocess has no reason to hold a secret value;
 *   only the Playwright MCP child does, through its own launch spec.
 * - `systemPrompt`, `model`, `cwd`, `maxTurns`, `maxBudgetUsd` (when non-null), `abortController` tied to `task.signal`.
 *
 * Stop mapping: result subtype `success` → `ended`; `error_max_turns` → `turn-cap`;
 * `error_max_budget_usd` → `budget-cap`; abort → `aborted`. `total_cost_usd` → `usage.costUsd`.
 * Once `session.settled`, the runner closes the query iterator at the next assistant message.
 */
export class ClaudeRunner implements AgentRunner {
  readonly backend = 'claude'

  constructor(private readonly options: ClaudeRunnerOptions = {}) {}

  async run<R>(task: AgentTask<R>): Promise<AgentResult<R>> {
    const session = openSession(task, this.backend)
    // TODO:
    // const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')
    //   (missing package → AgentSetupError with the pnpm add hint)
    // for await (const msg of query({ prompt: task.prompt, options })) {
    //   assistant → emit 'turn' / 'text' / 'tool-call' with unprefix(name)
    //   if (session.settled) break
    //   result → capture subtype, num_turns, total_cost_usd
    //   system init with mcp_servers status 'failed' → AgentSetupError
    // }
    // return session.finish(mapSubtype(subtype), { turns, costUsd }, lastText)
    void session
    void PLAYWRIGHT_SERVER
    void LIBRETTO_SERVER
    void this.options
    throw new Error('not implemented')
  }
}
