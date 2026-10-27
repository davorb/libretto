import { z } from 'zod'
import type { AgentResult, AgentRunner, AgentTask, StopReason } from './types.js'
import { AgentSetupError } from './types.js'
import { openSession, replyText } from './harness.js'
import { PLAYWRIGHT_SERVER, PLAYWRIGHT_TOOLS } from './playwright-mcp.js'

export interface CopilotRunnerOptions {
  /** Passed to `new CopilotClient(...)`: connection, working directory, log level. Never read from config files. */
  readonly client?: Readonly<Record<string, unknown>>
  /** Upper bound on one session's wall-clock time. Default 30 minutes. */
  readonly timeoutMs?: number
}

const PLAYWRIGHT_PREFIX = `${PLAYWRIGHT_SERVER}-`
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/**
 * `AgentRunner` over `@github/copilot-sdk`.
 *
 * SDK mapping (the only place these vendor names appear):
 * - `createSession({ model, systemMessage: { content }, workingDirectory, tools, mcpServers, availableTools })`.
 *   `availableTools` lists our custom tools plus `mcp:playwright-<tool>` for every Playwright
 *   tool, which excludes every built-in. TODO(spike): confirm the `mcp:` spelling excludes built-ins.
 * - `onPermissionRequest`: approve `custom-tool` requests for our names and `mcp` requests for
 *   the playwright server; reject the rest. Never `approveAll`, which throws under managed settings.
 * - Cancel: `task.signal` → `session.abort()`.
 *
 * Limits: the SDK has none, so this runner counts turns itself. On each
 * `assistant.turn_start` it increments `turns`; when `turns > profile.maxTurns` it calls
 * `session.abort()` and finishes with `turn-cap`. `profile.maxBudgetUsd` is always null
 * here (config types forbid it). `usage.costUsd` is null.
 */
export class CopilotRunner implements AgentRunner {
  readonly backend = 'copilot'

  constructor(private readonly options: CopilotRunnerOptions = {}) {}

  async run<R>(task: AgentTask<R>): Promise<AgentResult<R>> {
    const session = openSession(task, this.backend)
    const { CopilotClient, defineTool } = await loadSdk()

    const tools = session.tools.map((t) =>
      defineTool(t.name, {
        description: t.description,
        parameters: z.toJSONSchema(t.schema),
        handler: async (args: unknown) => replyText(await t.invoke(args)),
      }),
    )
    const customNames = new Set(session.toolNames)
    const availableTools = [
      ...session.toolNames,
      ...(session.playwright ? PLAYWRIGHT_TOOLS.map((n) => `mcp:${PLAYWRIGHT_PREFIX}${n}`) : []),
    ]

    const client = new CopilotClient({ workingDirectory: task.cwd, ...(this.options.client ?? {}) })
    let reason: StopReason = 'ended'
    let turns = 0
    let lastText = ''
    let errorMessage: string | null = null

    try {
      await client.start()
      if (session.playwright) await (session.playwright as { ready?: Promise<void> }).ready
      const s = await client.createSession({
        model: task.profile.model,
        systemMessage: { content: task.system },
        workingDirectory: task.cwd,
        tools,
        availableTools,
        mcpServers: session.playwright
          ? {
              [PLAYWRIGHT_SERVER]: {
                type: 'local',
                command: session.playwright.command,
                args: [...session.playwright.args],
                env: { ...session.playwright.env },
                tools: ['*'],
              },
            }
          : {},
        onPermissionRequest: (request) => {
          if (request.kind === 'custom-tool' && customNames.has(request.toolName)) return { kind: 'approve-once' }
          if (request.kind === 'mcp' && request.serverName === PLAYWRIGHT_SERVER && session.playwright) return { kind: 'approve-once' }
          return { kind: 'reject', feedback: 'Not available in this session.' }
        },
      })

      const onAbort = (): void => {
        reason = 'aborted'
        void s.abort()
      }
      task.signal?.addEventListener('abort', onAbort, { once: true })

      s.on('assistant.turn_start', () => {
        turns += 1
        session.emit({ type: 'turn', turn: turns })
        if (turns > task.profile.maxTurns) {
          reason = 'turn-cap'
          void s.abort()
        }
      })
      s.on('assistant.message', (e) => {
        lastText = e.data.content
        session.emit({ type: 'text', text: e.data.content })
        if (session.settled) void s.abort()
      })
      s.on('tool.execution_start', (e) => {
        const name = e.data.toolName
        if (name.startsWith(PLAYWRIGHT_PREFIX)) {
          session.emit({ type: 'tool-call', server: 'playwright', tool: name.slice(PLAYWRIGHT_PREFIX.length), input: e.data.arguments })
        }
      })
      s.on('session.error', (e) => {
        errorMessage = e.data.message
      })

      try {
        await s.sendAndWait({ prompt: task.prompt }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      } catch (error) {
        if (reason === 'ended' && !session.settled) {
          throw new AgentSetupError(this.backend, errorMessage ?? (error instanceof Error ? error.message : String(error)), { cause: error })
        }
      } finally {
        task.signal?.removeEventListener('abort', onAbort)
        await s.disconnect().catch(() => undefined)
      }
      if (task.signal?.aborted) reason = 'aborted'
      return session.finish(reason, { turns, costUsd: null }, lastText)
    } finally {
      await client.stop().catch(() => undefined)
      await session.cleanup()
    }
  }
}

type Sdk = typeof import('@github/copilot-sdk')

async function loadSdk(): Promise<Sdk> {
  try {
    return await import('@github/copilot-sdk')
  } catch (error) {
    throw new AgentSetupError('copilot', 'Cannot load @github/copilot-sdk. Install it: pnpm add -D @github/copilot-sdk', { cause: error })
  }
}
