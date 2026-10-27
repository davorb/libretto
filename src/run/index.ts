import { openProject, type CommandOptions } from '../project/index.js'
import type { SpecId } from '../spec/index.js'
import type { FailureRecord, RunId, Staleness } from '../workspace/index.js'
import { spawnPlaywright, writeWrapperConfig } from './playwright.js'

export interface RunOptions extends Omit<CommandOptions, 'agent'> {
  /** Passed through to `playwright test` after Libretto's own args (`--workers=4`, `--headed`). */
  readonly playwrightArgs?: readonly string[]
}

export interface RunReport {
  readonly runId: RunId
  /** Playwright's exit code. The CLI exits with it. */
  readonly exitCode: number
  readonly passed: number
  readonly failures: readonly FailureRecord[]
  /** SPEC: "run warns when a spec changed but its test did not". Missing tests are listed too. */
  readonly staleWarnings: readonly { readonly spec: SpecId; readonly staleness: Exclude<Staleness, 'fresh'> }[]
}

/**
 * `libretto run`. Never calls AI and never edits specs or generated files. It writes only
 * the wrapper config and (via the reporter) last-run.json.
 *
 * 1. openProject; specs = suite.select(selectors) plus their fixture chains
 * 2. workspace.staleness(spec, suite.app) for each → staleWarnings (log.warn each); missing files are skipped, not fatal
 * 3. wrapper = writeWrapperConfig(ctx, { kind: 'suite', specs })
 * 4. exitCode = spawnPlaywright(ctx, wrapper, generatedFiles, playwrightArgs)
 * 5. record = workspace.readLastRun() (merged by the reporter); report.failures = entries whose runId is record.latest.runId
 */
export async function run(options: RunOptions = {}): Promise<RunReport> {
  void openProject
  void spawnPlaywright
  void writeWrapperConfig
  throw new Error('not implemented')
}

// Package-internal (used by generate). The public index re-exports only `run` and its types.
export { runDraft, prepareStorageState, FixtureNotReadyError, type DraftResult } from './playwright.js'
