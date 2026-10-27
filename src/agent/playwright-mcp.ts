import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
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
 * Playwright MCP tool names, from its README. Used only where a vendor needs an explicit
 * allowlist and cannot express "every tool of this server" (Copilot's `availableTools`).
 * Listing a tool the server does not expose (capability-gated ones) is harmless.
 */
export const PLAYWRIGHT_TOOLS: readonly string[] = [
  'browser_click', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_evaluate',
  'browser_file_upload', 'browser_fill_form', 'browser_find', 'browser_handle_dialog', 'browser_hover',
  'browser_navigate', 'browser_navigate_back', 'browser_network_requests', 'browser_press_key',
  'browser_resize', 'browser_select_option', 'browser_snapshot', 'browser_tabs', 'browser_take_screenshot',
  'browser_type', 'browser_wait_for', 'browser_verify_element_visible', 'browser_verify_list_visible',
  'browser_verify_text_visible', 'browser_verify_value', 'browser_generate_locator',
]

/** Environment the MCP child inherits. Everything else, including secret values, is withheld. */
const CHILD_ENV_ALLOWLIST = ['PATH', 'HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'TMPDIR', 'LANG']

/**
 * Single source of the Playwright MCP launch spec for every backend and every command.
 *
 * - `command` is `process.execPath` plus the resolved `@playwright/mcp` CLI, not `npx`:
 *   no network fetch and no version drift between runs.
 * - `--isolated` gives each session its own browser profile, so concurrent sessions
 *   share nothing.
 * - `--storage-state` when the target starts from a fixture chain.
 * - `--output-dir` keeps MCP artifacts under `.libretto/`.
 *
 * How secrets reach the browser (verified against @playwright/mcp 0.0.83):
 * `browser_type` and `browser_fill_form` pass their text through `lookupSecret`. When the
 * whole text equals a secret's *name*, the server types the value instead. The server
 * also replaces every value with `<secret>NAME</secret>` in its responses, logs, and
 * files, so snapshots the model receives are already scrubbed. The names and values
 * come from `--secrets <dotenv>`, written here with mode 0600 to `<outputDir>/secrets.env`
 * and removed by `cleanup()`. This is the only file on disk that ever holds a value.
 *
 * Prompts therefore tell the agent to type the bare name (see `secretUsageInstructions`),
 * and generated code reads `process.env.NAME`.
 */
export function playwrightMcp(target: BrowserTarget): McpServerLaunch {
  const values = unseal(target.secrets)
  const names = Object.keys(values)
  const secretsFile = path.join(target.outputDir, 'secrets.env')
  // The package exports only its root; `cli.js` sits beside it (it is the package's `bin`).
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('@playwright/mcp')), 'cli.js')

  const args = ['--isolated', '--output-dir', target.outputDir]
  if (target.headless) args.push('--headless')
  if (target.storageState) args.push('--storage-state', target.storageState)
  if (names.length > 0) args.push('--secrets', secretsFile)

  const env: Record<string, string> = {}
  for (const key of CHILD_ENV_ALLOWLIST) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }

  // The file must exist before the SDK spawns the child. Runners spawn after openSession,
  // and this write is synchronous from their point of view via `ready`.
  const ready = (async () => {
    await mkdir(target.outputDir, { recursive: true })
    if (names.length > 0) await writeFile(secretsFile, renderDotenv(values), { mode: 0o600 })
  })()

  return {
    command: process.execPath,
    args: [cli, ...args],
    env,
    cleanup: async () => {
      await ready.catch(() => undefined)
      await rm(secretsFile, { force: true })
    },
    // Exposed for runners that must await the file before spawning.
    ...{ ready },
  } as McpServerLaunch & { ready: Promise<void> }
}

/** Dotenv: one `NAME=value` per line. Values are double-quoted with `"`, `\\`, and newlines escaped. */
function renderDotenv(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
      .join('\n') + '\n'
  )
}

/**
 * The paragraph every prompt builder appends when `secrets.names` is non-empty. Lives
 * here, next to the mechanism it describes, so the text and the delivery can't drift.
 * Returns an empty string when there are no secrets.
 */
export function secretUsageInstructions(secrets: Secrets): string {
  const names = secrets.names
  if (names.length === 0) return ''
  return [
    `Secrets available by name: ${names.join(', ')}.`,
    'To enter one into a field, call browser_type or browser_fill_form with the bare name as the entire text',
    `(for example, text: "${names[0]}"). The browser substitutes the real value. You never see values,`,
    'never ask for them, and never try to read them back from the page.',
    'In generated test code, a secret is `process.env.NAME`, never a literal.',
  ].join(' ')
}
