import type { z } from 'zod'
import type { Secrets } from './secrets.js'

/**
 * Tool input schemas must be Zod objects: MCP tool schemas are JSON objects, and
 * Claude's `tool()` takes a raw shape. Encoded here so a union or primitive schema
 * fails at the definition site, not inside a runner.
 */
export type ObjectSchema<I> = z.ZodType<I> & { readonly shape: z.ZodRawShape }

/** A PNG the agent should see, e.g. a failure screenshot. */
export interface PngImage {
  readonly base64: string
}

/**
 * What a tool hands back to the agent. Widened from SPEC.md's `string` so triage can
 * show screenshots; runners translate to vendor content blocks.
 */
export type ToolReply = string | { readonly text: string; readonly images: readonly PngImage[] }

/**
 * A non-terminal tool the agent may call, defined once, vendor-neutral.
 *
 * Invariants:
 * - `name` is snake_case and unique within a task. It is never prefixed: runners own
 *   `mcp__libretto__<name>` / `libretto-<name>` and nothing outside `agent/` sees those.
 * - `handler` receives Zod-parsed input. A thrown error is reported to the agent as a
 *   tool error and the session continues; it does not fail the task.
 * - Tools are read-only. The only way an agent produces an effect is its task's
 *   `Submission`, and the caller (not the agent) applies that effect.
 */
export interface LibrettoTool<I> {
  readonly name: string
  readonly description: string
  readonly input: ObjectSchema<I>
  handler(input: I): Promise<ToolReply>
}

/** Result of `Submission.accept`. A rejection keeps the session alive with `feedback` as the tool reply. */
export type Acceptance<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly feedback: string }

/**
 * The terminal tool of a task: `write_test`, `submit_verdict`, `propose_spec_edit`.
 * Replaces vendor structured output (SPEC.md: "submit_verdict replaces structured output").
 *
 * Invariants:
 * - The first accepted submission wins; later calls get "already submitted".
 * - An accepted submission wins over any later stop reason (a cap hit after acceptance
 *   still yields `status: 'submitted'`).
 * - `accept` is where semantic validation lives (things Zod can't say): draft shape vs
 *   spec, secret leaks, draft passes against the app, edited spec still parses.
 */
export interface Submission<I, R> {
  readonly name: string
  readonly description: string
  readonly input: ObjectSchema<I>
  accept(input: I): Promise<Acceptance<R>>
}

/** Model and caps for one command, resolved from config. `maxBudgetUsd` is `null` for Copilot by construction. */
export interface AgentProfile {
  readonly model: string
  readonly maxTurns: number
  readonly maxBudgetUsd: number | null
}

/**
 * The browser the agent drives through Playwright MCP. `secrets` reach the MCP child
 * process env and nothing else.
 */
export interface BrowserTarget {
  readonly baseURL: string
  readonly secrets: Secrets
  /** Path to a Playwright storageState JSON to start from (fixture chain), or null for a clean context. */
  readonly storageState: string | null
  readonly headless: boolean
  /** Where Playwright MCP may write its own screenshots/traces. Inside `.libretto/`. */
  readonly outputDir: string
}

/**
 * One agent job. Every Libretto agent task has this shape: explore through Playwright
 * MCP and `tools`, then finish by calling `submit` once.
 */
export interface AgentTask<R> {
  /** Short label for logs, e.g. `generate auth/login`. */
  readonly label: string
  readonly system: string
  readonly prompt: string
  /**
   * `any` is deliberate and local: each tool's handler is fed only its own schema's
   * parse output by the harness, so the erased input type can't be violated.
   */
  readonly tools: readonly LibrettoTool<any>[]
  readonly submit: Submission<any, R>
  /** `null` means no Playwright MCP is attached (triage with an unreachable baseURL). */
  readonly browser: BrowserTarget | null
  readonly profile: AgentProfile
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly onEvent?: (event: AgentEvent) => void
}

/** Vendor-neutral transcript events, streamed into the logger. Tool names are unprefixed. */
export type AgentEvent =
  | { readonly type: 'turn'; readonly turn: number }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly server: 'playwright' | 'libretto'; readonly tool: string; readonly input: unknown }
  | { readonly type: 'tool-result'; readonly server: 'playwright' | 'libretto'; readonly tool: string; readonly ok: boolean }

export interface Usage {
  readonly turns: number
  /** `null` when the backend does not report cost (Copilot). */
  readonly costUsd: number | null
}

/** Why a session ended without an accepted submission. */
export type StopReason = 'turn-cap' | 'budget-cap' | 'ended' | 'aborted'

export type AgentResult<R> =
  | { readonly status: 'submitted'; readonly value: R; readonly usage: Usage }
  | {
      readonly status: 'unsubmitted'
      readonly reason: StopReason
      /** Last assistant text, for the report ("I could not find a login page"). */
      readonly lastText: string
      readonly usage: Usage
    }

/**
 * The only AI seam (SPEC.md). Starts a session with Playwright MCP (if `task.browser`)
 * plus `task.tools` and `task.submit`, and **no vendor built-in tools**, and resolves
 * when the session ends.
 *
 * Contract:
 * - Resolves for every agent-behavior outcome (submitted, caps, gave up, aborted).
 * - Rejects only with `AgentSetupError`, for failures that would hit every task the
 *   same way: SDK missing, auth failed, Playwright MCP failed to start.
 * - Enforces `profile.maxTurns` and `profile.maxBudgetUsd` (natively or by counting).
 */
export interface AgentRunner {
  readonly backend: string
  run<R>(task: AgentTask<R>): Promise<AgentResult<R>>
}

export class AgentSetupError extends Error {
  override readonly name = 'AgentSetupError'
  constructor(
    readonly backend: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}
