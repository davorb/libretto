import { z } from 'zod'
import type { AgentResult, AgentTask, Submission } from '../agent/index.js'
import type { Project } from '../project/index.js'
import type { Spec } from '../spec/index.js'
import type { FailureRecord, TriageRecord, Verdict } from '../workspace/index.js'
import { evidenceTools, loadEvidence } from './artifacts.js'

/**
 * Top-level tool input must be an object (ObjectSchema), so the union is flattened here
 * and `accept` restores it: `cause` is required iff `kind === 'test-broken'`.
 */
export const verdictInput = z.object({
  kind: z.enum(['app-broken', 'test-broken', 'inconclusive']),
  cause: z.enum(['spec-wrong', 'generated-code-wrong']).optional(),
  evidence: z.string().min(1),
})

/** `submit_verdict`. Rejects a test-broken verdict without a cause, and a cause on any other kind. */
export function submitVerdict(): Submission<z.infer<typeof verdictInput>, Verdict> {
  throw new Error('not implemented')
}

/**
 * Pure. The single mapping from agent outcome to verdict (SPEC):
 * - submitted → the value
 * - turn-cap | budget-cap → inconclusive, evidence 'budget exhausted'
 * - ended → inconclusive, evidence 'agent ended without a verdict: <lastText>'
 * - aborted → never reaches here (the command stops and writes nothing for this failure)
 */
export function verdictFrom(result: Exclude<AgentResult<Verdict>, { status: 'unsubmitted'; reason: 'aborted' }>): Verdict {
  throw new Error('not implemented')
}

/**
 * Builds the triage task. The prompt has app.md, the spec, the failing step (by StepRef,
 * quoted from the spec), the error, a trace summary, the generated test body, and the
 * three verdict definitions. `live === false` → `browser: null` and the prompt says to
 * judge from artifacts only.
 * Secrets: the spec's envRefs are sealed so live probing can log in. They are never in the prompt.
 */
export async function triageTask(project: Project, spec: Spec, failure: FailureRecord, live: boolean): Promise<AgentTask<Verdict>> {
  void evidenceTools
  void loadEvidence
  throw new Error('not implemented')
}

/**
 * One failure → one record. When `live` is false the triager, not the agent, prefixes
 * the evidence with "[artifacts only: <baseURL> unreachable] " (SPEC: "says so in the verdict").
 */
export async function triageOne(project: Project, failure: FailureRecord, live: boolean): Promise<TriageRecord | 'aborted'> {
  throw new Error('not implemented')
}

/** GET baseURL with a short timeout; any HTTP response counts as reachable. */
export async function probe(baseURL: string, signal?: AbortSignal): Promise<boolean> {
  throw new Error('not implemented')
}
