import type { AgentProfile, Backend } from '../agent/index.js'

/**
 * Caps per backend. Copilot has no budget option, so the key does not exist for it, and
 * `maxBudgetUsd` under `backend: 'copilot'` is a type error, not a silent no-op.
 */
export type LimitsFor<B extends Backend> = B extends 'claude'
  ? { readonly maxTurns?: number; readonly maxBudgetUsd?: number }
  : { readonly maxTurns?: number }

/** Per-command override. Model names are vendor strings passed through (SPEC). */
export type CommandOverrides<B extends Backend> = { readonly model?: string } & LimitsFor<B>

export type LibrettoConfig<B extends Backend = Backend> = {
  readonly baseURL: string
  /** Default `'specs'`. */
  readonly specs?: string
  readonly agent: { readonly backend: B; readonly model: string } & LimitsFor<B>
  readonly generate?: CommandOverrides<B>
  readonly triage?: CommandOverrides<B>
  readonly fix?: CommandOverrides<B>
  /** Browser for agent sessions (Playwright MCP). Default true. Test runs follow playwright.config. */
  readonly headless?: boolean
}

/** Identity at runtime. Exists for inference: `B` is taken from `agent.backend`. */
export function defineConfig<const B extends Backend>(config: LibrettoConfig<B>): LibrettoConfig<B> {
  return config
}

export type AgentCommand = 'generate' | 'triage' | 'fix'

/**
 * Config after defaults and per-command merge. Each command reads `profiles[cmd]` and
 * nothing else about models or caps (single source; no re-merging at call sites).
 */
export interface ResolvedConfig {
  readonly root: string
  readonly baseURL: string
  readonly specsDir: string
  readonly backend: Backend
  readonly profiles: Readonly<Record<AgentCommand, AgentProfile>>
  readonly headless: boolean
  /** Absolute path of the user's playwright.config.* if present; the wrapper config imports it. */
  readonly playwrightConfig: string | null
}

export const DEFAULT_MAX_TURNS = 40
