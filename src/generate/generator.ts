import type { AgentTask, Secrets, Submission } from '../agent/index.js'
import type { Project } from '../project/index.js'
import type { Spec, SpecId } from '../spec/index.js'
import type { RenderedTest, Staleness } from '../workspace/index.js'
import { checkDraft, renderTest, testDraftInput, type TestDraft } from './draft.js'
import { runDraft } from '../run/index.js'

/** Per-spec result, aggregated into GenerateReport by `generateSpecs`. */
export type SpecGeneration =
  | { readonly status: 'written'; readonly spec: SpecId; readonly replaced: Staleness }
  | { readonly status: 'fresh'; readonly spec: SpecId }
  | {
      readonly status: 'failed'
      readonly spec: SpecId
      readonly reason: 'turn-cap' | 'budget-cap' | 'ended' | 'aborted' | 'fixture-not-ready' | 'missing-secrets'
      readonly detail: string
    }

/**
 * The `write_test` submission for one spec. `accept`:
 * 1. `checkDraft` → reject with the list of problems
 * 2. `renderTest`
 * 3. `secrets.findLeak(body)` → reject naming the env var (value never echoed)
 * 4. `runDraft(...)` → on failure reject with the failing step title, error, and trimmed output
 * 5. ok → value is the RenderedTest. The caller writes it; the agent never writes files.
 */
export function writeTestSubmission(
  project: Project,
  spec: Spec,
  secrets: Secrets,
  storageState: string | null,
): Submission<TestDraft, RenderedTest> {
  void checkDraft
  void renderTest
  void testDraftInput
  void runDraft
  throw new Error('not implemented')
}

/**
 * Prompt for generating one spec. The system prompt carries Libretto's rules for
 * generated code: role-based locators first, no sleeps, web-first assertions, how to
 * type a secret by name. The user prompt carries `app.md`, the fixture chain's sources
 * (as "already done before this test starts"), the spec source, an optional `hint`
 * (verdict evidence from `fix`), and the exact `write_test` contract.
 * Secrets appear by name only; the prompt builders never receive a `Secrets` value.
 */
export function generationTask(
  project: Project,
  spec: Spec,
  submit: Submission<TestDraft, RenderedTest>,
  browser: { storageState: string | null; secrets: Secrets },
  hint: string | null,
): AgentTask<RenderedTest> {
  throw new Error('not implemented')
}

/**
 * One spec, end to end:
 *   workspace.staleness(spec, suite.app) → (fresh && !force) → { fresh }
 *     (`app-changed` counts as stale: app.md is input to every generation)
 *   secrets = Secrets.fromEnv(spec.envRefs, process.env)   (MissingSecretsError → failed)
 *     (fixtures' own refs are consumed by their setup tests in the Playwright child, not by the agent)
 *   storageState = prepareStorageState(ctx, suite.fixtureChain(spec))     (FixtureNotReadyError → failed)
 *   result = project.agent.run(generationTask(...))
 *   submitted → workspace.writeGenerated(value) ; warn if replaced === 'hand-edited' (SPEC: names the file)
 *   unsubmitted → failed with result.reason, generated file untouched
 */
export async function generateOne(project: Project, spec: Spec, opts: { force: boolean; hint: string | null }): Promise<SpecGeneration> {
  throw new Error('not implemented')
}
