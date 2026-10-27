import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_TURNS } from './define.js'
import { loadConfig } from './load.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'libretto-config-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const write = (name: string, body: string, at = dir) => writeFile(join(at, name), body)
const tsConfig = (body: string) => `export default ${body}\n`

describe('loadConfig', () => {
  it('loads a claude .ts config, merging overrides over agent defaults', async () => {
    await write('libretto.config.ts', tsConfig(`{
      baseURL: 'http://localhost:3000',
      specs: 'my-specs',
      agent: { backend: 'claude', model: 'sonnet-x', maxTurns: 10, maxBudgetUsd: 2 },
      generate: { model: 'opus-x', maxBudgetUsd: 5 },
      triage: { model: 'opus-x' },
      fix: {},
    }`))
    const config = await loadConfig(dir)
    expect(config).toEqual({
      root: dir,
      baseURL: 'http://localhost:3000',
      specsDir: join(dir, 'my-specs'),
      backend: 'claude',
      headless: true,
      playwrightConfig: null,
      profiles: {
        generate: { model: 'opus-x', maxTurns: 10, maxBudgetUsd: 5 },
        triage: { model: 'opus-x', maxTurns: 10, maxBudgetUsd: 2 },
        fix: { model: 'sonnet-x', maxTurns: 10, maxBudgetUsd: 2 },
      },
    })
  })

  it('defaults specs, turns, budget and headless; copilot budget is null', async () => {
    await write('libretto.config.mjs', `export default { baseURL: 'http://x', headless: false, agent: { backend: 'copilot', model: 'gpt-5' }, fix: { maxTurns: 3 } }`)
    const config = await loadConfig(dir)
    expect(config.specsDir).toBe(join(dir, 'specs'))
    expect(config.headless).toBe(false)
    expect(config.profiles.generate).toEqual({ model: 'gpt-5', maxTurns: DEFAULT_MAX_TURNS, maxBudgetUsd: null })
    expect(config.profiles.fix).toEqual({ model: 'gpt-5', maxTurns: 3, maxBudgetUsd: null })
  })

  it('walks up from a nested cwd and reports the playwright config next to it', async () => {
    await write('libretto.config.ts', tsConfig(`{ baseURL: 'http://x', agent: { backend: 'claude', model: 'm' } }`))
    await write('playwright.config.ts', 'export default {}')
    const nested = join(dir, 'a', 'b')
    await mkdir(nested, { recursive: true })
    const config = await loadConfig(nested)
    expect(config.root).toBe(dir)
    expect(config.playwrightConfig).toBe(join(dir, 'playwright.config.ts'))
  })

  it('takes an explicit path, relative to cwd', async () => {
    await write('custom.config.mjs', `export default { baseURL: 'http://x', agent: { backend: 'claude', model: 'm' } }`)
    const config = await loadConfig(dir, 'custom.config.mjs')
    expect(config.root).toBe(dir)
  })

  it('throws when no config exists', async () => {
    await expect(loadConfig(dir)).rejects.toThrow(/No libretto\.config\.ts/)
    await expect(loadConfig(dir, 'nope.mjs')).rejects.toThrow(/Config file not found: .*nope\.mjs/)
  })

  it('names the file and the offending key for an invalid value', async () => {
    await write('libretto.config.mjs', `export default { baseURL: 'http://x', agent: { backend: 'claude', model: 'm', maxTurns: 'lots' } }`)
    const error = await loadConfig(dir).catch((e: Error) => e)
    expect((error as Error).message).toContain(join(dir, 'libretto.config.mjs'))
    expect((error as Error).message).toContain('agent.maxTurns')
  })

  it('names an unknown key and a bad backend', async () => {
    await write('libretto.config.mjs', `export default { baseURL: 'http://x', modle: 'x', agent: { backend: 'gemini', model: 'm' } }`)
    const message = ((await loadConfig(dir).catch((e: Error) => e)) as Error).message
    expect(message).toContain('modle: unknown key')
    expect(message).toContain('agent.backend')
  })

  it('rejects maxBudgetUsd under copilot at runtime, in agent and in overrides', async () => {
    await write('libretto.config.mjs', `export default { baseURL: 'http://x', agent: { backend: 'copilot', model: 'm', maxBudgetUsd: 1 }, triage: { maxBudgetUsd: 2 } }`)
    const message = ((await loadConfig(dir).catch((e: Error) => e)) as Error).message
    expect(message).toContain('agent.maxBudgetUsd: not allowed with backend "copilot"')
    expect(message).toContain('triage.maxBudgetUsd: not allowed with backend "copilot"')
  })

  it('names the file when there is no default export or the import fails', async () => {
    await write('libretto.config.mjs', `export const x = 1`)
    await expect(loadConfig(dir)).rejects.toThrow(/libretto\.config\.mjs: no default export/)
    await write('broken.config.mjs', `export default {`)
    await expect(loadConfig(dir, 'broken.config.mjs')).rejects.toThrow(/broken\.config\.mjs: failed to import/)
  })
})
