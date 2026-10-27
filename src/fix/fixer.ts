import { z } from 'zod'
import type { AgentTask, Submission } from '../agent/index.js'
import type { Project } from '../project/index.js'
import type { Spec, SpecId, Suite } from '../spec/index.js'
import type { TriageRecord } from '../workspace/index.js'

/**
 * A repair, shown to `confirm` before anything changes. Neither variant edits a
 * generated file: `regenerate` re-runs generation with the verdict as a hint, and
 * `edit-spec` patches markdown and then regenerates (SPEC).
 */
export type FixProposal =
  | {
      readonly kind: 'regenerate'
      readonly spec: SpecId
      /** Verdict evidence from every `generated-code-wrong` failure in this spec, joined. Becomes the generation hint. */
      readonly reason: string
    }
  | {
      readonly kind: 'edit-spec'
      readonly spec: SpecId
      readonly file: string
      readonly before: string
      readonly after: string
      /** Unified diff of before → after, for display. */
      readonly diff: string
      readonly summary: string
    }

/** Validated edit, the value of `propose_spec_edit`. */
export interface SpecEdit {
  readonly markdown: string
  readonly summary: string
}

export const specEditInput = z.object({
  markdown: z.string().min(1),
  summary: z.string().min(1),
})

/**
 * `propose_spec_edit`. `accept` runs `suite.withEdit(spec.id, markdown)`. Issues are
 * returned to the agent. It also rejects edits that change the title, change `uses`,
 * drop a scenario that was not failing, or add an `{{env.X}}` that is not set (the
 * agent can't know the value, so it can't make one up).
 */
export function proposeSpecEdit(suite: Suite, spec: Spec): Submission<z.infer<typeof specEditInput>, SpecEdit> {
  throw new Error('not implemented')
}

/**
 * The agent sees app.md, the spec, the generated test, and every `spec-wrong` verdict
 * for this spec. It gets live Playwright MCP to confirm what the app does now, and edits
 * the spec to describe that. Without baseURL, `fix` refuses spec-wrong proposals (it
 * would be guessing) and reports them.
 */
export function specEditTask(project: Project, spec: Spec, verdicts: readonly TriageRecord[]): AgentTask<SpecEdit> {
  throw new Error('not implemented')
}

/**
 * Pure: which triage records still need action. A record is handled (skipped) when the
 * current files no longer match what it diagnosed:
 * - spec-wrong: current spec.hash ≠ record.generated.specHash (the spec was already edited)
 * - generated-code-wrong: current generated stamp.bodyHash ≠ record.generated.bodyHash (already regenerated)
 * No "resolved" flag is stored, because the files are the source of truth (idempotent re-runs).
 */
export function pendingRecords(
  records: readonly TriageRecord[],
  current: (spec: SpecId) => { specHash: string | null; bodyHash: string | null },
): readonly TriageRecord[] {
  throw new Error('not implemented')
}
