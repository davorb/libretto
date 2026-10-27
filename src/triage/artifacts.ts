import type { LibrettoTool } from '../agent/index.js'
import type { FailureRecord } from '../workspace/index.js'

/** One action from the Playwright trace, flattened for the prompt. */
export interface TraceAction {
  readonly index: number
  readonly title: string
  readonly durationMs: number
  readonly error: string | null
  /** The `test.step` title it ran under, if any. */
  readonly step: string | null
}

/**
 * Reads the recorded evidence for one failure. Missing files (trace wiped by a later
 * `playwright test`) become nulls, not errors. The prompt says what is absent.
 * Trace parsing: unzip `trace.zip`, read the `*.trace` NDJSON, keep `before`/`after` action events.
 */
export interface FailureEvidence {
  readonly actions: readonly TraceAction[] | null
  readonly screenshots: readonly string[]
  readonly dom: { readonly html: string; readonly aria: string } | null
}

export async function loadEvidence(failure: FailureRecord): Promise<FailureEvidence> {
  throw new Error('not implemented')
}

/**
 * Read-only tools over the evidence, so the prompt carries a summary and the agent pulls
 * detail on demand:
 * - `view_screenshot({ index })` → image reply
 * - `read_dom({ format: 'aria' | 'html', offset, limit })` → paged text
 * - `read_trace({ from, to })` → action range with errors
 */
export function evidenceTools(evidence: FailureEvidence): readonly LibrettoTool<any>[] {
  throw new Error('not implemented')
}
