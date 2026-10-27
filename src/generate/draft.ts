import { z } from 'zod'
import type { AppSpec, Spec } from '../spec/index.js'
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
  throw new Error('not implemented')
}

/**
 * Pure. Draft + spec → file body (the workspace adds the header).
 *
 *   import { test, expect } from 'libretto/test'
 *   test.use({ storageState: '<workspace.stateFile(chain innermost)>' })   // if uses
 *   <helpers>
 *   test.describe('<spec.title>', () => {
 *     test('<scenario.name>', async ({ page }) => {
 *       await test.step(stepTitle('steps', 1, text), async () => { <code> })
 *       …
 *     })
 *   })
 *
 * A fixture renders as a single setup test that ends with
 * `await page.context().storageState({ path: '<workspace.stateFile(spec.id)>' })`.
 */
export function renderTest(spec: Spec, app: AppSpec, draft: TestDraft, paths: { storageStateIn: string | null; storageStateOut: string | null }): RenderedTest {
  throw new Error('not implemented')
}
