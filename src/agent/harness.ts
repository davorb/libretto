import type { z } from 'zod'
import type { AgentEvent, AgentResult, AgentTask, StopReason, ToolReply, Usage } from './types.js'
import { AgentSetupError } from './types.js'
import { playwrightMcp, type McpServerLaunch } from './playwright-mcp.js'

/**
 * Everything both runners need that is not vendor-specific. A runner calls
 * `openSession(task)`, registers `session.tools` in its SDK's format, drives its loop,
 * and ends with `session.finish(reason, usage)`.
 *
 * Package-internal: not exported from `agent/index.ts`.
 */

/** A Libretto tool after neutral wrapping: input is `unknown`, parsing and error capture happen here. */
export interface NeutralTool {
  readonly name: string
  readonly description: string
  /** Raw shape for Claude's `tool()`; full schema for Copilot's `defineTool()`. */
  readonly shape: z.ZodRawShape
  readonly schema: z.ZodTypeAny
  /** Never throws. Invalid input and handler errors become a reply the agent can act on. */
  invoke(raw: unknown): Promise<ToolReply>
}

export interface Session<R> {
  /** `task.tools` plus the wrapped `task.submit`, in registration order. */
  readonly tools: readonly NeutralTool[]
  /** Unprefixed names of `tools`, for allowlists. */
  readonly toolNames: readonly string[]
  readonly playwright: McpServerLaunch | null
  /** True once a submission is accepted; runners end the session at the next turn boundary. */
  readonly settled: boolean
  /** Redacts secret values (see `Secrets.redact`) before forwarding to `task.onEvent`. */
  emit(event: AgentEvent): void
  /**
   * Runners pass every vendor-side tool result (Playwright MCP included) through this
   * before it reaches a log. It cannot change what the model sees: MCP results go
   * vendor → model directly. See `playwright-mcp.ts` on why that is acceptable.
   */
  redact(text: string): string
  /** Single place that builds an `AgentResult`. An accepted submission overrides `reason`. */
  finish(reason: StopReason, usage: Usage, lastText: string): AgentResult<R>
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/

/**
 * Throws `AgentSetupError` when tool names are malformed or collide (including with
 * `submit.name`). Collisions are a programming error that would otherwise show up
 * as a confusing vendor error.
 */
export function openSession<R>(task: AgentTask<R>, backend: string): Session<R> {
  // TODO:
  // 1. validate every name against TOOL_NAME and uniqueness → AgentSetupError(backend, ...)
  // 2. wrap each LibrettoTool:
  //      invoke(raw) { emit tool-call; const p = schema.safeParse(raw)
  //        if (!p.success) return `Invalid input: ${formatIssues(p.error)}`
  //        try { reply = await handler(p.data) } catch (e) { reply = `Tool error: ${msg(e)}` }
  //        emit tool-result; return redact(reply) }
  // 3. wrap submit:
  //      invoke(raw) { if (box.settled) return 'Already submitted. End your turn.'
  //        parse as above; const a = await submit.accept(p.data)
  //        if (a.ok) { box.settle(a.value); return 'Accepted. End your turn now.' }
  //        return a.feedback }
  // 4. playwright = task.browser ? playwrightMcp(task.browser) : null
  // 5. finish(reason, usage, lastText) = box.settled
  //      ? { status: 'submitted', value: box.value, usage }
  //      : { status: 'unsubmitted', reason, lastText, usage }
  void TOOL_NAME
  void playwrightMcp
  void AgentSetupError
  throw new Error('not implemented')
}
