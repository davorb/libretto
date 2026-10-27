import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResult, AgentRunner, AgentTask, StopReason, ToolReply, Usage } from './types.js'
import { AgentSetupError } from './types.js'
import { openSession, type Session } from './harness.js'
import { PLAYWRIGHT_SERVER } from './playwright-mcp.js'

/** Options a user may pass when constructing the runner directly. Auth stays in env vars or the CLI login, per the SDK. */
export interface ClaudeRunnerOptions {
  /** Extra env for the Claude Code subprocess (e.g. `ANTHROPIC_API_KEY`, Bedrock/Vertex switches). */
  readonly env?: Readonly<Record<string, string>>
}

const LIBRETTO_SERVER = 'libretto'
const LIBRETTO_PREFIX = `mcp__${LIBRETTO_SERVER}__`
const PLAYWRIGHT_PREFIX = `mcp__${PLAYWRIGHT_SERVER}__`

/**
 * Env vars a parent Claude Code session sets. The subprocess must not inherit them:
 * `CLAUDECODE` makes the CLI refuse to start nested, and the rest tie it to the parent.
 */
const PARENT_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT)$/

/**
 * `AgentRunner` over `@anthropic-ai/claude-agent-sdk`'s `query()`.
 *
 * SDK option mapping (the only place these vendor names appear):
 * - `tools: []` turns off every built-in (Read, Edit, Bash, WebFetch...).
 * - `mcpServers`: `{ playwright: stdio launch, libretto: createSdkMcpServer(session.tools) }`.
 * - `strictMcpConfig: true`: the user's `.mcp.json` and plugin servers never load.
 * - `canUseTool`: allow `mcp__libretto__<name>` for each tool and `mcp__playwright__*`,
 *   deny anything else. There is deliberately no `allowedTools`: bare entries there
 *   auto-approve before the callback runs, so the callback is the only gate.
 * - `settingSources: []`: the user's ~/.claude settings, hooks, and CLAUDE.md never load.
 * - `env`: `process.env` minus parent-session vars and every secret name, plus `options.env`.
 *   The Claude Code subprocess has no reason to hold a secret value; only the Playwright
 *   MCP child does, through its secrets file.
 * - `systemPrompt`, `model`, `cwd`, `maxTurns`, `maxBudgetUsd` (when non-null), `abortController` tied to `task.signal`.
 *
 * Stop mapping: result subtype `success` → `ended`; `error_max_turns` → `turn-cap`;
 * `error_max_budget_usd` → `budget-cap`; abort → `aborted`. `total_cost_usd` → `usage.costUsd`.
 * Once `session.settled`, an assistant message that still calls tools closes the query.
 */
export class ClaudeRunner implements AgentRunner {
  readonly backend = 'claude'

  constructor(private readonly options: ClaudeRunnerOptions = {}) {}

  async run<R>(task: AgentTask<R>): Promise<AgentResult<R>> {
    const session = openSession(task, this.backend)
    const sdk = await loadSdk()
    const { query, tool, createSdkMcpServer } = sdk

    const libretto = createSdkMcpServer({
      name: LIBRETTO_SERVER,
      tools: session.tools.map((t) =>
        tool(t.name, t.description, t.shape, async (args) => toCallToolResult(await t.invoke(args))),
      ),
    })
    const mcpServers: Record<string, McpServerConfig> = { [LIBRETTO_SERVER]: libretto }
    if (session.playwright) {
      await (session.playwright as { ready?: Promise<void> }).ready
      mcpServers[PLAYWRIGHT_SERVER] = {
        type: 'stdio',
        command: session.playwright.command,
        args: [...session.playwright.args],
        env: { ...session.playwright.env },
      }
    }

    // No `allowedTools`: a bare entry there auto-approves before `canUseTool` runs (the SDK
    // warns about it), so every call falls through to the callback, which is the gate.
    const librettoNames = new Set(session.toolNames.map((n) => `${LIBRETTO_PREFIX}${n}`))
    const allowed = (name: string): boolean =>
      librettoNames.has(name) || (session.playwright !== null && name.startsWith(PLAYWRIGHT_PREFIX))

    const abort = new AbortController()
    const onAbort = (): void => abort.abort()
    task.signal?.addEventListener('abort', onAbort, { once: true })
    if (task.signal?.aborted) abort.abort()

    let reason: StopReason = 'ended'
    let usage: Usage = { turns: 0, costUsd: null }
    let lastText = ''
    let turns = 0

    const q = query({
      prompt: task.prompt,
      options: {
        systemPrompt: task.system,
        model: task.profile.model,
        cwd: task.cwd,
        tools: [],
        mcpServers,
        strictMcpConfig: true,
        settingSources: [],
        canUseTool: async (toolName) =>
          allowed(toolName)
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: `${toolName} is not available in this session.` },
        maxTurns: task.profile.maxTurns,
        ...(task.profile.maxBudgetUsd === null ? {} : { maxBudgetUsd: task.profile.maxBudgetUsd }),
        abortController: abort,
        env: subprocessEnv(task, this.options.env),
      },
    })

    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          const failed = msg.mcp_servers.filter((s) => s.status === 'failed').map((s) => s.name)
          if (failed.length > 0) {
            q.close()
            throw new AgentSetupError(this.backend, `MCP server failed to start: ${failed.join(', ')}`)
          }
          continue
        }
        if (msg.type === 'assistant') {
          turns += 1
          session.emit({ type: 'turn', turn: turns })
          let callsTools = false
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              lastText = block.text
              session.emit({ type: 'text', text: block.text })
            } else if (block.type === 'tool_use') {
              callsTools = true
              if (block.name.startsWith(PLAYWRIGHT_PREFIX)) {
                session.emit({ type: 'tool-call', server: 'playwright', tool: block.name.slice(PLAYWRIGHT_PREFIX.length), input: block.input })
              }
            }
          }
          if (session.settled && callsTools) {
            // Accepted already; don't let the agent spend more turns.
            usage = { turns, costUsd: null }
            q.close()
            break
          }
          continue
        }
        if (msg.type === 'result') {
          usage = { turns: msg.num_turns, costUsd: msg.total_cost_usd }
          reason = mapSubtype(msg.subtype)
          if (msg.subtype === 'success') lastText = msg.result || lastText
        }
      }
      if (abort.signal.aborted) reason = 'aborted'
      return session.finish(reason, usage, lastText)
    } finally {
      task.signal?.removeEventListener('abort', onAbort)
      await session.cleanup()
    }
  }
}

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')

async function loadSdk(): Promise<Sdk> {
  try {
    return await import('@anthropic-ai/claude-agent-sdk')
  } catch (error) {
    throw new AgentSetupError('claude', 'Cannot load @anthropic-ai/claude-agent-sdk. Install it: pnpm add -D @anthropic-ai/claude-agent-sdk', { cause: error })
  }
}

function mapSubtype(subtype: string): StopReason {
  switch (subtype) {
    case 'error_max_turns':
      return 'turn-cap'
    case 'error_max_budget_usd':
      return 'budget-cap'
    default:
      return 'ended'
  }
}

function toCallToolResult(reply: ToolReply): { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> } {
  if (typeof reply === 'string') return { content: [{ type: 'text', text: reply }] }
  return {
    content: [
      { type: 'text', text: reply.text },
      ...reply.images.map((img) => ({ type: 'image' as const, data: img.base64, mimeType: 'image/png' })),
    ],
  }
}

function subprocessEnv<R>(task: AgentTask<R>, extra: Readonly<Record<string, string>> | undefined): Record<string, string | undefined> {
  const secretNames = new Set(task.browser?.secrets.names ?? [])
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (PARENT_SESSION_VARS.test(k) || secretNames.has(k)) continue
    env[k] = v
  }
  return { ...env, ...extra }
}

export type { Session }
