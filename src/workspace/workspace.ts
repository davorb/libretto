import type { AppHash, AppSpec, Spec, SpecHash, SpecId } from '../spec/index.js'
import type { FailureId, FailureRecord, GeneratedStamp, RunRecord, TriageLog } from './records.js'

/**
 * - `fresh`: header specHash and appHash equal the current ones and bodyHash matches the body.
 * - `missing`: no generated file.
 * - `spec-changed`: header specHash differs (spec or a fixture in its chain changed).
 * - `app-changed`: only `app.md` differs. Stale for `generate`; `run` warns.
 * - `hand-edited`: bodyHash mismatch or header unreadable. Takes precedence over the
 *   others, because it is the state that needs a warning when overwritten.
 *
 * Precedence: hand-edited > missing > spec-changed > app-changed > fresh.
 */
export type Staleness = 'fresh' | 'missing' | 'spec-changed' | 'app-changed' | 'hand-edited'

/** A complete generated file body (no header), ready to write. Produced only by `generate/draft.ts`. */
export interface RenderedTest {
  readonly spec: SpecId
  readonly specHash: SpecHash
  readonly appHash: AppHash
  readonly body: string
}

/**
 * Owner of `.libretto/` and the only writer of anything under `specs/` or
 * `.libretto/generated/`. Every write is atomic (temp file + rename), so a crash
 * never leaves a half-written test or record.
 *
 * Layout:
 *   .libretto/generated/<id>.generated.spec.ts   committed
 *   .libretto/state/<fixture>.json               storageState, gitignored
 *   .libretto/drafts/<id>.generated.spec.ts      generate-time drafts, gitignored
 *   .libretto/playwright.config.ts               wrapper config, rewritten every run
 *   .libretto/last-run.json, triage.json         gitignored
 */
export interface Workspace {
  readonly root: string
  readonly specsDir: string
  readonly dir: string
  readonly generatedDir: string
  readonly draftsDir: string
  readonly stateDir: string

  generatedFile(id: SpecId): string
  draftFile(id: SpecId): string
  /** Where a fixture's setup test saves, and dependents load, storageState. */
  stateFile(fixture: SpecId): string

  staleness(spec: Spec, app: AppSpec): Promise<Staleness>
  /** The stamp of the current generated file, or null if missing/unreadable. Used by `fix` to detect handled verdicts. */
  stamp(id: SpecId): Promise<GeneratedStamp | null>
  /** Adds the header. Returns the prior staleness so the caller can warn on `hand-edited`. */
  writeGenerated(test: RenderedTest, specFile: string): Promise<{ replaced: Staleness }>
  writeDraft(test: RenderedTest, specFile: string): Promise<string>
  writeSpec(spec: Spec, markdown: string): Promise<void>

  readLastRun(): Promise<RunRecord | null>
  /**
   * Merges one run into the record: entries for `ran` are dropped, then `failures` are
   * added, `latest` is replaced. Entries for tests not in `ran` are untouched. Called
   * once by the reporter at `onEnd`; the write is atomic.
   */
  mergeLastRun(run: RunRecord['latest'], ran: readonly FailureId[], failures: readonly FailureRecord[], flaky: readonly FailureId[]): Promise<void>
  /** Empty log when the file is missing. */
  readTriage(): Promise<TriageLog>
  writeTriage(log: TriageLog): Promise<void>
}

export function openWorkspace(root: string, specsDir: string): Workspace {
  throw new Error('not implemented')
}
