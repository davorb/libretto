import { openProject, type CommandOptions } from '../project/index.js'
import type { SpecId } from '../spec/index.js'
import { generateSpecs, type GenerateReport } from '../generate/index.js'
import { pendingRecords, proposeSpecEdit, specEditTask, type FixProposal } from './fixer.js'

export interface FixOptions extends CommandOptions {
  /**
   * Required: SPEC says fix "asks before applying", and that holds for every caller.
   * The CLI supplies a TTY y/N prompt, or approve-all under `--yes`.
   */
  readonly confirm: (proposal: FixProposal) => Promise<boolean>
}

export interface FixReport {
  readonly applied: readonly FixProposal[]
  readonly declined: readonly FixProposal[]
  /** Specs where no proposal could be made (agent hit a cap, baseURL down for spec-wrong). */
  readonly unresolved: readonly { readonly spec: SpecId; readonly detail: string }[]
  /** The single regeneration pass over every applied proposal. */
  readonly generated: GenerateReport
}

/**
 * `libretto fix [spec...]`.
 *
 * 1. records = pendingRecords(test-broken records from workspace.readTriage(), current stamps)
 * 2. group by spec. A spec with any spec-wrong → one edit-spec proposal (via the agent;
 *    the spec edit makes it stale, so regeneration covers its generated-code-wrong records
 *    too). Otherwise → one regenerate proposal (no agent call).
 * 3. for each proposal, in spec order: confirm → apply edit-spec via workspace.writeSpec
 * 4. reload the suite (hashes changed), then one generateSpecs(project', approvedIds,
 *    { force: true for regenerate-only specs, hints: reasons })
 * Crash between 3 and 4: the edited spec is stale and its record is pending no more
 * (hash mismatch), so `libretto generate` completes the work. Nothing is lost or repeated.
 */
export async function fix(options: FixOptions): Promise<FixReport> {
  void openProject
  void generateSpecs
  void pendingRecords
  void proposeSpecEdit
  void specEditTask
  throw new Error('not implemented')
}

export type { FixProposal } from './fixer.js'
