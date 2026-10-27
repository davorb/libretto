import { openProject, type CommandOptions } from '../project/index.js'
import type { Spec, SpecId } from '../spec/index.js'
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
  const project = await openProject(options)
  const { suite, workspace, log } = project
  const selected = suite.select(options.specs ?? [])
  const specs = [...new Map(selected.flatMap((s) => [...suite.fixtureChain(s), s]).map((s) => [s.id, s])).values()]

  const staleWarnings: { spec: SpecId; staleness: Exclude<Staleness, 'fresh'> }[] = []
  const runnable: Spec[] = []
  for (const spec of specs) {
    const staleness = await workspace.staleness(spec, suite.app)
    if (staleness === 'missing') log.warn(`${spec.id} has no generated test. Run \`libretto generate ${spec.id}\`.`)
    else {
      runnable.push(spec)
      if (staleness !== 'fresh') log.warn(`${spec.id} is ${staleness}. Run \`libretto generate ${spec.id}\`.`)
    }
    if (staleness !== 'fresh') staleWarnings.push({ spec: spec.id, staleness })
  }

  const wrapper = await writeWrapperConfig(project, { kind: 'suite', specs: runnable })
  const startedAt = Date.now()
  const exitCode = await spawnPlaywright(project, wrapper, runnable.map((s) => workspace.generatedFile(s.id)), options.playwrightArgs ?? [])
  const record = await workspace.readLastRun()
  if (!record || Date.parse(record.latest.startedAt) < startedAt - 1000) {
    throw new Error(`Playwright exited with ${exitCode} without recording results in ${workspace.dir}/last-run.json (interrupted, or no test ran)`)
  }
  const failures = Object.values(record.failures).filter((f) => f.runId === record.latest.runId)
  return { runId: record.latest.runId, exitCode, passed: record.latest.passed, failures, staleWarnings }
}

// Package-internal (used by generate). The public index re-exports only `run` and its types.
export { runDraft, prepareStorageState, FixtureNotReadyError, type DraftResult } from './playwright.js'
