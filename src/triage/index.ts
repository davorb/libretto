import { openProject, type CommandOptions } from '../project/index.js'
import type { FailureId, RunId, TriageRecord } from '../workspace/index.js'
import { probe, triageOne } from './triager.js'

export interface TriageOptions extends CommandOptions {
  /** Re-triage failures that already have a record for this run. */
  readonly force?: boolean
}

export interface TriageReport {
  readonly runId: RunId
  /** Records produced in this invocation. */
  readonly records: readonly TriageRecord[]
  /** Not triaged, with the reason. No tokens were spent on these. */
  readonly skipped: readonly { readonly failure: FailureId; readonly reason: 'already-triaged' | 'spec-changed-since-run' | 'generated-changed-since-run' }[]
  /** Whether baseURL answered. False means every verdict here is artifacts-only. */
  readonly live: boolean
}

/**
 * `libretto triage [spec...]`. Manual only; nothing calls it automatically.
 *
 * 1. lastRun = workspace.readLastRun() ?? throw "no recorded run; run `libretto run` first"
 * 2. failures = values of lastRun.failures filtered by selectors (entries may come from several runs)
 * 3. log = workspace.readTriage(); skip, with a reason and no agent call, any failure that
 *    - already has a record with the same runId (unless force), or
 *    - ran against a spec or generated body whose hash has since moved (its verdict would
 *      describe a test that no longer exists; regenerate and re-run instead)
 * 4. live = probe(config.baseURL), once per invocation
 * 5. sequentially: record = triageOne(...); log = { records: { ...log.records, [id]: record } }; workspace.writeTriage(log)
 *    after each, so a crash or Ctrl-C keeps finished verdicts and a re-run resumes.
 *    This process is the only writer of triage.json; failures don't share state.
 */
export async function triage(options: TriageOptions = {}): Promise<TriageReport> {
  const project = await openProject(options)
  const { workspace, suite } = project
  const lastRun = await workspace.readLastRun()
  if (lastRun === null) throw new Error('no recorded run; run `libretto run` first')

  const selected = new Set(suite.select(options.specs ?? []).map((s) => s.id))
  const failures = Object.values(lastRun.failures).filter((f) => selected.has(f.spec))

  let log = await workspace.readTriage()
  const skipped: { failure: FailureId; reason: TriageReport['skipped'][number]['reason'] }[] = []
  const todo: typeof failures = []
  for (const failure of failures) {
    const spec = suite.specs.get(failure.spec)
    if (!options.force && log.records[failure.id]?.runId === failure.runId) {
      skipped.push({ failure: failure.id, reason: 'already-triaged' })
    } else if (spec === undefined || spec.hash !== failure.generated.specHash) {
      skipped.push({ failure: failure.id, reason: 'spec-changed-since-run' })
    } else if ((await workspace.stamp(failure.spec))?.bodyHash !== failure.generated.bodyHash) {
      skipped.push({ failure: failure.id, reason: 'generated-changed-since-run' })
    } else {
      todo.push(failure)
    }
  }

  const live = await probe(project.config.baseURL, project.signal)
  if (todo.length > 0 && !live) {
    project.log.warn(`${project.config.baseURL} is unreachable; verdicts use recorded artifacts only.`)
  }

  const records: TriageRecord[] = []
  for (const failure of todo) {
    if (project.signal?.aborted) break
    const record = await triageOne(project, failure, live)
    if (record === 'aborted') break
    records.push(record)
    log = { records: { ...log.records, [failure.id]: record } }
    await workspace.writeTriage(log)
  }
  return { runId: lastRun.latest.runId, records, skipped, live }
}
