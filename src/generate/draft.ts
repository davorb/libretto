import { z } from 'zod'
import type { AppSpec, Spec, Step } from '../spec/index.js'
import { stepTitle } from '../spec/step-title.js'
import type { RenderedTest } from '../workspace/index.js'

/**
 * What the agent submits through `write_test`. It writes step bodies, not files. Libretto
 * owns the file's structure, so step mapping, the header, imports, storageState, and
 * the output path hold by construction.
 */
export const testDraftInput = z.object({
  /** Top-level code placed before the tests: helper functions and locator factories. No imports. */
  helpers: z.string().default(''),
  scenarios: z
    .array(
      z.object({
        name: z.string(),
        /** One code block per `Steps` bullet, in order. Runs inside `async ({ page }) => …`. */
        steps: z.array(z.string()),
        /** One code block per `Expect` bullet, in order. Should use `expect(...)`. */
        expect: z.array(z.string()),
      }),
    )
    .min(1),
})
export type TestDraft = z.infer<typeof testDraftInput>

/**
 * Pure. Problems the agent must fix before rendering, phrased for the agent:
 * - scenario names and order equal the spec's
 * - `steps.length` / `expect.length` equal the bullet counts
 * - `process.env.X` appears for every `{{env.X}}` in that bullet, and no other env names appear
 * - no `import`/`require`, no `test(`/`test.describe(` (the renderer emits those),
 *   no `page.goto` to an absolute URL outside baseURL
 */
export function checkDraft(spec: Spec, draft: TestDraft): readonly string[] {
  const problems: string[] = []
  const names = spec.scenarios.map((s) => s.name)
  const got = draft.scenarios.map((s) => s.name)
  if (names.length !== got.length || names.some((n, i) => n !== got[i])) {
    problems.push(
      `Scenarios must match the spec's names in order: expected ${JSON.stringify(names)}, got ${JSON.stringify(got)}.`,
    )
  }

  const forbidden = (where: string, code: string) => {
    if (/(^|[^\w.$])import\s*(\(|[\w{*'"])/m.test(code) || /\brequire\s*\(/.test(code)) {
      problems.push(`${where}: remove import/require. Libretto writes the imports; use the \`page\` and \`expect\` in scope.`)
    }
    if (/(^|[^\w.$])test\s*(\.\w+)*\s*\(/m.test(code)) {
      problems.push(`${where}: remove test(...)/test.describe(...). Libretto emits those; write only the body.`)
    }
    if (/\.goto\(\s*[`'"]https?:/.test(code)) {
      problems.push(`${where}: page.goto must use a path such as '/login', not an absolute URL. baseURL comes from the config.`)
    }
  }
  forbidden('helpers', draft.helpers)

  const checkBullets = (scenario: string, section: 'steps' | 'expect', bullets: readonly Step[], codes: readonly string[]) => {
    const label = section === 'steps' ? 'Steps' : 'Expect'
    if (bullets.length !== codes.length) {
      problems.push(
        `Scenario ${JSON.stringify(scenario)}: \`${section}\` needs one code block per ${label} bullet (${bullets.length}), got ${codes.length}.`,
      )
    }
    codes.forEach((code, i) => {
      const where = `Scenario ${JSON.stringify(scenario)}, ${label} ${i + 1}`
      forbidden(where, code)
      const bullet = bullets[i]
      if (!bullet) return
      const used = new Set([...code.matchAll(/process\.env(?:\.([A-Za-z_]\w*)|\[\s*['"]([A-Za-z_]\w*)['"]\s*\])/g)].map((m) => m[1] ?? m[2]!))
      for (const name of bullet.envRefs) {
        if (!used.has(name)) problems.push(`${where}: the bullet references {{env.${name}}}, so use process.env.${name}.`)
      }
      for (const name of used) {
        if (!bullet.envRefs.includes(name)) problems.push(`${where}: process.env.${name} is not referenced by this bullet; remove it.`)
      }
    })
  }

  for (const scenario of spec.scenarios) {
    const d = draft.scenarios.find((s) => s.name === scenario.name)
    if (!d) continue
    checkBullets(scenario.name, 'steps', scenario.steps, d.steps)
    checkBullets(scenario.name, 'expect', scenario.expect, d.expect)
  }
  return problems
}

/**
 * Pure. Draft + spec → file body (the workspace adds the header).
 *
 *   import { test, expect } from 'libretto/test'
 *   test.use({ storageState: '<storageStateIn>' })   // if uses
 *   <helpers>
 *   test.describe('<spec.title>', () => {
 *     test('<scenario.name>', async ({ page }) => {
 *       await test.step(stepTitle('steps', 1, text), async () => { <code> })
 *       …
 *     })
 *   })
 *
 * A fixture renders as a single setup test that ends with
 * `await page.context().storageState({ path: '<storageStateOut>' })`. The caller passes
 * both relative to the project root, so committed files carry no machine path.
 * A fixture with several scenarios renders each as a test and saves the state at the
 * end of the last one.
 */
export function renderTest(spec: Spec, app: AppSpec, draft: TestDraft, paths: { storageStateIn: string | null; storageStateOut: string | null }): RenderedTest {
  const lines: string[] = [`import { test, expect } from 'libretto/test'`]
  if (paths.storageStateIn !== null) {
    lines.push(`test.use({ storageState: ${JSON.stringify(paths.storageStateIn)} })`)
  }
  if (draft.helpers.trim()) lines.push('', draft.helpers.trim())
  lines.push('', `test.describe(${JSON.stringify(spec.title)}, () => {`)

  spec.scenarios.forEach((scenario, si) => {
    const d = draft.scenarios.find((s) => s.name === scenario.name)
    const block = (steps: readonly Step[], codes: readonly string[] | undefined) =>
      steps.map((step, i) => {
        const title = stepTitle(step.ref.section, step.ref.index, step.text)
        return [
          `    await test.step(${JSON.stringify(title)}, async () => {`,
          indent(codes?.[i] ?? '', 6),
          `    })`,
        ].filter((l) => l !== '')
      })
    const body = [...block(scenario.steps, d?.steps), ...block(scenario.expect, d?.expect)].flat()
    if (spec.kind === 'fixture' && si === spec.scenarios.length - 1 && paths.storageStateOut !== null) {
      body.push(`    await page.context().storageState({ path: ${JSON.stringify(paths.storageStateOut)} })`)
    }
    lines.push(`  test(${JSON.stringify(scenario.name)}, async ({ page }) => {`, ...body, `  })`)
    if (si < spec.scenarios.length - 1) lines.push('')
  })
  lines.push('})', '')

  return { spec: spec.id, specHash: spec.hash, appHash: app.hash, body: lines.join('\n') }
}

function indent(code: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return code
    .trim()
    .split('\n')
    .map((l) => (l.trim() ? pad + l : ''))
    .join('\n')
}
