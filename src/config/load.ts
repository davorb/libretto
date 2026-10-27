import type { LibrettoConfig, ResolvedConfig } from './define.js'

/**
 * Finds and imports `libretto.config.ts` (walking up from `cwd`), parses it with Zod
 * (the file is user code, so this is a boundary), and resolves it.
 *
 * - `.ts` is imported natively (Node ≥ 22.18 type stripping). No jiti or tsx.
 * - Parse errors name the key path: `agent.maxBudgetUsd: not allowed with backend "copilot"`
 *   (the runtime mirror of the type rule, for JS configs).
 */
export async function loadConfig(cwd: string, explicitPath?: string): Promise<ResolvedConfig> {
  throw new Error('not implemented')
}

/**
 * Pure. Each `profiles[cmd]` = `{ ...agent, ...config[cmd] }` with
 * `maxTurns ?? DEFAULT_MAX_TURNS` and `maxBudgetUsd ?? null` (always null for copilot).
 */
export function resolveConfig(config: LibrettoConfig, root: string, playwrightConfig: string | null): ResolvedConfig {
  throw new Error('not implemented')
}
