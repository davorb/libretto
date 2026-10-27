import type { BrowserTarget } from './types.js'
import type { Secrets } from './secrets.js'
import { unseal } from './secrets.js'

/** How to launch Playwright MCP over stdio. Both runners translate this into their own config shape. */
export interface McpServerLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** Deletes the secrets file. Runners call it in `finally`. */
  cleanup(): Promise<void>
}

/** The fixed server key. Runners derive prefixes from it (`mcp__playwright__`, `playwright-`). */
export const PLAYWRIGHT_SERVER = 'playwright'

/**
 * Single source of the Playwright MCP launch spec for every backend and every command.
 *
 * - `command` is `process.execPath` plus the resolved bin of the pinned `@playwright/mcp`
 *   dependency, not `npx`: no network fetch and no version drift between runs.
 * - `--isolated` gives each session its own browser profile, so concurrent sessions
 *   share nothing.
 * - `--storage-state` when the target starts from a fixture chain.
 * - `--output-dir` keeps MCP artifacts under `.libretto/`.
 * - The child env is a minimal allowlist (PATH, HOME, DISPLAY, PLAYWRIGHT_BROWSERS_PATH),
 *   not the parent's full env, and it carries no secret values.
 *
 * How secrets reach the browser. The agent types `{{env.NAME}}` placeholders; Playwright
 * MCP's `--secrets <dotenv>` substitutes them by name inside `browser_type` and
 * `browser_fill_form`, so the model never sees a value. The dotenv file is written
 * with mode 0600 under `<outputDir>/secrets.env` from `unseal(target.secrets)` and
 * removed by `cleanup()`. This is the only file on disk that ever holds a value.
 *
 * TODO(spike, SPEC open question 1): confirm `--secrets` exists on the pinned
 * `@playwright/mcp` and covers both tools on both backends. Fallback if it does not: a
 * stdio shim process between the SDK and Playwright MCP that rewrites the placeholders
 * in those two tools' arguments and redacts values from results. The shim would live in
 * this directory and change nothing outside it.
 *
 * Known limit either way: a value typed into a field can appear in a later DOM snapshot
 * (e.g. a visible password field). `Secrets.redact` scrubs it from our logs, but the
 * model's own context receives MCP results directly. Specs should not read secrets back.
 */
export function playwrightMcp(target: BrowserTarget): McpServerLaunch {
  const secretEnv = unseal(target.secrets)
  // TODO: resolve bin via import.meta.resolve('@playwright/mcp/cli')
  // TODO: args = ['--isolated', target.headless && '--headless', storageState && ['--storage-state', p],
  //               '--output-dir', target.outputDir, names.length && ['--secrets', writeDotenv(secretEnv, 0o600)]]
  void secretEnv
  throw new Error('not implemented')
}

/**
 * The paragraph every prompt builder appends when `secrets.names` is non-empty. Lives
 * here, next to the mechanism it describes, so the text and the delivery can't drift.
 *
 *   "Secrets are available by name: ALICE_PASSWORD. To enter one, type the literal text
 *    {{env.ALICE_PASSWORD}} into the field; the browser substitutes the value. Never ask
 *    for the value and never try to read it back."
 */
export function secretUsageInstructions(secrets: Secrets): string {
  void secrets
  throw new Error('not implemented')
}
