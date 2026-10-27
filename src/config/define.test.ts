import { describe, expectTypeOf, it } from 'vitest'
import { defineConfig, type LibrettoConfig } from './define.js'

describe('defineConfig types', () => {
  it('rejects maxBudgetUsd under copilot at compile time and accepts it under claude', () => {
    defineConfig({ baseURL: 'http://x', agent: { backend: 'claude', model: 'm', maxBudgetUsd: 2 }, generate: { maxBudgetUsd: 5 } })
    defineConfig({ baseURL: 'http://x', agent: { backend: 'copilot', model: 'm', maxTurns: 3 }, fix: { maxTurns: 2 } })

    defineConfig({
      baseURL: 'http://x',
      // @ts-expect-error copilot has no budget option
      agent: { backend: 'copilot', model: 'm', maxBudgetUsd: 2 },
    })
    defineConfig({
      baseURL: 'http://x',
      agent: { backend: 'copilot', model: 'm' },
      // @ts-expect-error per-command override follows the backend
      triage: { maxBudgetUsd: 2 },
    })
  })

  it('infers the backend from agent.backend', () => {
    const config = defineConfig({ baseURL: 'http://x', agent: { backend: 'copilot', model: 'm' } })
    expectTypeOf(config).toEqualTypeOf<LibrettoConfig<'copilot'>>()
  })
})
