import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { AgentProfile } from '../agent/index.js'
import { DEFAULT_MAX_TURNS, type AgentCommand, type LibrettoConfig, type ResolvedConfig } from './define.js'

const CONFIG_NAMES = ['libretto.config.ts', 'libretto.config.js', 'libretto.config.mjs']
const PLAYWRIGHT_CONFIG_NAMES = ['playwright.config.ts', 'playwright.config.mts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']
const COMMANDS: readonly AgentCommand[] = ['generate', 'triage', 'fix']

const limits = {
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
}
const overrides = z.strictObject({ model: z.string().min(1).optional(), ...limits })

const configSchema = z.strictObject({
  baseURL: z.string().min(1),
  specs: z.string().min(1).optional(),
  agent: z.strictObject({ backend: z.enum(['claude', 'copilot']), model: z.string().min(1), ...limits }),
  generate: overrides.optional(),
  triage: overrides.optional(),
  fix: overrides.optional(),
  headless: z.boolean().optional(),
}).superRefine((config, ctx) => {
  if (config.agent.backend !== 'copilot') return
  const places: [string, { maxBudgetUsd?: number | undefined } | undefined][] = [
    ['agent', config.agent],
    ...COMMANDS.map((c): [string, { maxBudgetUsd?: number | undefined } | undefined] => [c, config[c]]),
  ]
  for (const [key, value] of places) {
    if (value?.maxBudgetUsd !== undefined) {
      ctx.addIssue({ code: 'custom', path: [key, 'maxBudgetUsd'], message: 'not allowed with backend "copilot"' })
    }
  }
})

function findConfigFile(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    if (dirname(dir) === dir) return null
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join('.')
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.map((k) => [...issue.path, k].join('.'))
    return `${keys.join(', ')}: unknown key`
  }
  return `${path || '(config)'}: ${issue.message}`
}

/**
 * Finds and imports `libretto.config.ts` (walking up from `cwd`), parses it with Zod
 * (the file is user code, so this is a boundary), and resolves it.
 *
 * - `.ts` is imported natively (Node ≥ 22.18 type stripping). No jiti or tsx.
 * - Parse errors name the key path: `agent.maxBudgetUsd: not allowed with backend "copilot"`
 *   (the runtime mirror of the type rule, for JS configs).
 */
export async function loadConfig(cwd: string, explicitPath?: string): Promise<ResolvedConfig> {
  const file = explicitPath ? (isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath)) : findConfigFile(cwd)
  if (file === null) {
    throw new Error(`No libretto.config.ts (or .js/.mjs) found in ${resolve(cwd)} or any parent directory`)
  }
  if (!existsSync(file)) throw new Error(`Config file not found: ${file}`)

  let mod: { default?: unknown }
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (cause) {
    throw new Error(`${file}: failed to import: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
  if (mod.default === undefined) throw new Error(`${file}: no default export (use \`export default defineConfig({...})\`)`)

  const parsed = configSchema.safeParse(mod.default)
  if (!parsed.success) {
    throw new Error(`${file}: invalid config\n${parsed.error.issues.map((i) => `  ${describeIssue(i)}`).join('\n')}`)
  }

  const root = dirname(file)
  const playwrightName = PLAYWRIGHT_CONFIG_NAMES.find((name) => existsSync(join(root, name)))
  return resolveConfig(parsed.data as LibrettoConfig, root, playwrightName ? join(root, playwrightName) : null)
}

/**
 * Pure. Each `profiles[cmd]` = `{ ...agent, ...config[cmd] }` with
 * `maxTurns ?? DEFAULT_MAX_TURNS` and `maxBudgetUsd ?? null` (always null for copilot).
 */
export function resolveConfig(config: LibrettoConfig, root: string, playwrightConfig: string | null): ResolvedConfig {
  const { backend } = config.agent
  const agent: { model: string; maxTurns?: number; maxBudgetUsd?: number } = config.agent
  const profile = (cmd: AgentCommand): AgentProfile => {
    const o: { model?: string; maxTurns?: number; maxBudgetUsd?: number } = config[cmd] ?? {}
    const budget = o.maxBudgetUsd ?? agent.maxBudgetUsd
    return {
      model: o.model ?? agent.model,
      maxTurns: o.maxTurns ?? agent.maxTurns ?? DEFAULT_MAX_TURNS,
      maxBudgetUsd: backend === 'copilot' ? null : (budget ?? null),
    }
  }
  return {
    root,
    baseURL: config.baseURL,
    specsDir: resolve(root, config.specs ?? 'specs'),
    backend,
    profiles: { generate: profile('generate'), triage: profile('triage'), fix: profile('fix') },
    headless: config.headless ?? true,
    playwrightConfig,
  }
}
