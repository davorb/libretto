import type { FullConfig, FullResult, Reporter, Suite as PwSuite, TestCase, TestResult } from '@playwright/test/reporter'

/**
 * Playwright reporter shipped as `libretto/reporter`. It runs in Playwright's process,
 * not Libretto's, so it opens the workspace itself from the `workspace` option.
 *
 * - Buffers per-test final outcomes (`test.outcome()`: 'unexpected' → failure, 'flaky'
 *   → flaky). Triage only ever sees post-retry results (SPEC).
 * - For each failure: reads the file's header (`parseHeader`) for spec id and stamp,
 *   finds the deepest failing `test.step` and maps it with `parseStepTitle`, and
 *   collects trace, screenshot, and the `libretto-dom` attachment paths.
 * - `onEnd`: one atomic `workspace.mergeLastRun(latest, ran, failures, flaky)`, where
 *   `ran` is every FailureId this run executed. A partial run replaces only its own
 *   entries. An interrupted run leaves the previous last-run.json intact.
 *
 * Maps Playwright types to `FailureRecord` here; no Playwright type leaves this file.
 */
export default class LibrettoReporter implements Reporter {
  constructor(private readonly options: { workspace: string; specsDir: string; baseURL: string }) {}

  onBegin(_config: FullConfig, _suite: PwSuite): void {
    throw new Error('not implemented')
  }

  onTestEnd(_test: TestCase, _result: TestResult): void {
    throw new Error('not implemented')
  }

  async onEnd(_result: FullResult): Promise<void> {
    throw new Error('not implemented')
  }
}
