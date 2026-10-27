import type { z } from 'zod'
import type { AgentEvent, AgentResult, AgentTask, LibrettoTool, StopReason, Submission, ToolReply, Usage } from './types.js'
import { AgentSetupError } from './types.js'
import { Secrets } from './secrets.js'
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
   * before it reaches a log. Playwright MCP redacts its own responses too, so the
   * model's context is covered by the server and our logs by this.
   */
  redact(text: string): string
  /** Single place that builds an `AgentResult`. An accepted submission overrides `reason`. */
  finish(reason: StopReason, usage: Usage, lastText: string): AgentResult<R>
  /** Removes the secrets file, if any. Runners call it in `finally`. */
  cleanup(): Promise<void>
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/

/** Replies to the agent when it calls `submit` again after acceptance. */
export const ALREADY_SUBMITTED = 'Already submitted. End your turn now.'
/** Replies to the agent when `accept` succeeds. */
export const ACCEPTED = 'Accepted. End your turn now.'

/**
 * Throws `AgentSetupError` when tool names are malformed or collide (including with
 * `submit.name`). Collisions are a programming error that would otherwise show up
 * as a confusing vendor error.
 */
export function openSession<R>(task: AgentTask<R>, backend: string): Session<R> {
  const names = [...task.tools.map((t) => t.name), task.submit.name]
  const seen = new Set<string>()
  for (const name of names) {
    if (!TOOL_NAME.test(name)) throw new AgentSetupError(backend, `Invalid tool name "${name}": must match ${TOOL_NAME}`)
    if (seen.has(name)) throw new AgentSetupError(backend, `Duplicate tool name "${name}"`)
    seen.add(name)
  }

  const secrets = task.browser?.secrets ?? Secrets.none
  const redact = (text: string): string => secrets.redact(text)
  const emit = (event: AgentEvent): void => task.onEvent?.(redactEvent(event, redact))

  let settled = false
  let value: R | undefined

  const wrapTool = (tool: LibrettoTool<unknown>): NeutralTool => ({
    name: tool.name,
    description: tool.description,
    shape: tool.input.shape,
    schema: tool.input,
    async invoke(raw) {
      emit({ type: 'tool-call', server: 'libretto', tool: tool.name, input: raw })
      const parsed = tool.input.safeParse(raw)
      if (!parsed.success) {
        emit({ type: 'tool-result', server: 'libretto', tool: tool.name, ok: false })
        return `Invalid input: ${formatIssues(parsed.error)}`
      }
      try {
        const reply = await tool.handler(parsed.data)
        emit({ type: 'tool-result', server: 'libretto', tool: tool.name, ok: true })
        return redactReply(reply, redact)
      } catch (error) {
        emit({ type: 'tool-result', server: 'libretto', tool: tool.name, ok: false })
        return `Tool error: ${redact(messageOf(error))}`
      }
    },
  })

  const wrapSubmit = (submit: Submission<unknown, R>): NeutralTool => ({
    name: submit.name,
    description: submit.description,
    shape: submit.input.shape,
    schema: submit.input,
    async invoke(raw) {
      emit({ type: 'tool-call', server: 'libretto', tool: submit.name, input: raw })
      if (settled) return ALREADY_SUBMITTED
      const parsed = submit.input.safeParse(raw)
      if (!parsed.success) {
        emit({ type: 'tool-result', server: 'libretto', tool: submit.name, ok: false })
        return `Invalid input: ${formatIssues(parsed.error)}`
      }
      let acceptance
      try {
        acceptance = await submit.accept(parsed.data)
      } catch (error) {
        emit({ type: 'tool-result', server: 'libretto', tool: submit.name, ok: false })
        return `Tool error: ${redact(messageOf(error))}`
      }
      if (acceptance.ok) {
        settled = true
        value = acceptance.value
        emit({ type: 'tool-result', server: 'libretto', tool: submit.name, ok: true })
        return ACCEPTED
      }
      emit({ type: 'tool-result', server: 'libretto', tool: submit.name, ok: false })
      return redact(acceptance.feedback)
    },
  })

  const tools = [...task.tools.map(wrapTool), wrapSubmit(task.submit)]
  const playwright = task.browser ? playwrightMcp(task.browser) : null

  return {
    tools,
    toolNames: tools.map((t) => t.name),
    playwright,
    get settled() {
      return settled
    },
    emit,
    redact,
    finish(reason, usage, lastText) {
      if (settled) return { status: 'submitted', value: value as R, usage }
      return { status: 'unsubmitted', reason, lastText: redact(lastText), usage }
    },
    cleanup: () => playwright?.cleanup() ?? Promise.resolve(),
  }
}

/** Formats Zod issues on one line each, `path: message`, so the agent can fix its call. */
export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

/** Text of a `ToolReply`, for vendors whose tool results are text only. */
export function replyText(reply: ToolReply): string {
  return typeof reply === 'string' ? reply : reply.text
}

function redactReply(reply: ToolReply, redact: (s: string) => string): ToolReply {
  return typeof reply === 'string' ? redact(reply) : { text: redact(reply.text), images: reply.images }
}

function redactEvent(event: AgentEvent, redact: (s: string) => string): AgentEvent {
  switch (event.type) {
    case 'text':
      return { ...event, text: redact(event.text) }
    case 'tool-call':
      return { ...event, input: redactUnknown(event.input, redact) }
    default:
      return event
  }
}

function redactUnknown(input: unknown, redact: (s: string) => string): unknown {
  if (typeof input === 'string') return redact(input)
  if (input === null || typeof input !== 'object') return input
  try {
    return JSON.parse(redact(JSON.stringify(input))) as unknown
  } catch {
    return '[unserializable input]'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
