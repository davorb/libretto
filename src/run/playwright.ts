import type { RunContext } from '../project/index.js'
import type { Spec, SpecId } from '../spec/index.js'
import type { FailureRecord, RenderedTest } from '../workspace/index.js'

/**
 * Everything Libretto knows about invoking Playwright Test. The only module that spawns
 * `playwright test`. Takes `RunContext`, so it has no agent.
 */

export type WrapperMode =
  | { readonly kind: 'suite'; readonly specs: readonly Spec[] }
  | { readonly kind: 'draft'; readonly file: string; readonly storageState: string | null }
  | { readonly kind: 'fixtures'; readonly chain: readonly Spec[] }

/**
 * Writes `.libretto/playwright.config.ts` (or a per-draft variant) and returns its path.
 * Deterministic from inputs, so rewriting it on every call is idempotent.
 *
 * The wrapper imports the user's playwright.config (if any) and overrides only what
 * Libretto must own:
 * - `testDir` = generated (or drafts) dir, `testMatch` = `**\/*.generated.spec.ts`
 * - `use.baseURL` = config.baseURL
 * - `use.trace = 'retain-on-failure'`, `use.screenshot = 'only-on-failure'`: triage depends on them
 * - `reporter` = user's reporters + `['libretto/reporter', { workspace: root }]` (suite mode only)
 * - `projects`: for each user project P (or one default): a setup project `P:setup:<fixture>`
 *   per fixture, with `dependencies` mirroring `uses` chains, plus `P` matching scenario
 *   files. TODO(open question): confirm the P × fixtures matrix is what users expect.
 */
export async function writeWrapperConfig(ctx: RunContext, mode: WrapperMode): Promise<string> {
  throw new Error('not implemented')
}

/**
 * Spawns `node <@playwright/test cli> test -c <wrapper> [files] [...extraArgs]` with
 * inherited stdio. Resolves with Playwright's exit code. `ctx.signal` → SIGTERM to the child.
 */
export async function spawnPlaywright(ctx: RunContext, wrapper: string, files: readonly string[], extraArgs: readonly string[]): Promise<number> {
  throw new Error('not implemented')
}

export type DraftResult =
  | { readonly passed: true }
  | { readonly passed: false; readonly failure: Pick<FailureRecord, 'scenario' | 'step' | 'error'>; readonly output: string }

/**
 * Used by `write_test.accept`: writes the draft to `.libretto/drafts/`, runs it once
 * (no retries, one worker, `list` reporter captured), and reports the first failure in
 * a form the agent can act on. Never touches `.libretto/generated/` or `last-run.json`.
 */
export async function runDraft(ctx: RunContext, draft: RenderedTest, specFile: string, storageState: string | null): Promise<DraftResult> {
  throw new Error('not implemented')
}

/**
 * Runs the generated setup tests for `chain` (outermost first) so `generate` can start
 * an agent from the innermost fixture's storageState. Returns that state file's path,
 * or null for an empty chain.
 * Throws `FixtureNotReadyError` when a fixture in the chain is not `fresh` or its setup fails:
 * the dependent spec can't be generated against a broken setup.
 */
export async function prepareStorageState(ctx: RunContext, chain: readonly Spec[]): Promise<string | null> {
  throw new Error('not implemented')
}

export class FixtureNotReadyError extends Error {
  override readonly name = 'FixtureNotReadyError'
  constructor(
    readonly fixture: SpecId,
    readonly why: 'not-generated' | 'stale' | 'setup-failed',
  ) {
    super(`Fixture ${fixture} is ${why}`)
  }
}
