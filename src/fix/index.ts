import { openProject, type CommandOptions } from '../project/index.js'
import type { Spec, SpecId } from '../spec/index.js'
import { generateSpecs, type GenerateReport } from '../generate/index.js'
import type { TriageRecord } from '../workspace/index.js'
import { unifiedDiff } from './diff.js'
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

const PROBE_TIMEOUT_MS = 3000

/** GET baseURL with a short timeout; any HTTP response counts as reachable. */
async function reachable(baseURL: string, signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(baseURL, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}

const isSpecWrong = (r: TriageRecord) => r.verdict.kind === 'test-broken' && r.verdict.cause === 'spec-wrong'

/**
 * `libretto fix [spec...]`.
 *
 * 1. records = pendingRecords(test-broken records from workspace.readTriage(), current stamps)
 * 2. group by spec. A spec with any spec-wrong → one edit-spec proposal (via the agent;
 *    the spec edit makes it stale, so regeneration covers its generated-code-wrong records
 *    too). Otherwise → one regenerate proposal (no agent call).
 * 3. for each proposal, in spec order: confirm → apply edit-spec via workspace.writeSpec
 * 4. reload the suite (hashes changed), then one generateSpecs(project', approvedIds,
 *    { force: true, hints: reasons })
 *    `force` is per call, not per id. An edited spec is stale and regenerates anyway, so forcing
 *    the whole batch matches "force for regenerate-only ids" without a second pass.
 * Crash between 3 and 4: the edited spec is stale and its record is pending no more
 * (hash mismatch), so `libretto generate` completes the work. Nothing is lost or repeated.
 */
export async function fix(options: FixOptions): Promise<FixReport> {
  const project = await openProject(options)
  const { suite, workspace, log } = project

  const selected = new Set(suite.select(options.specs ?? []).map((s) => s.id))
  const triaged = Object.values((await workspace.readTriage()).records).filter((r) => selected.has(r.spec))

  const stamps = new Map<SpecId, { specHash: string | null; bodyHash: string | null }>()
  for (const id of new Set(triaged.map((r) => r.spec))) {
    stamps.set(id, { specHash: suite.specs.get(id)?.hash ?? null, bodyHash: (await workspace.stamp(id))?.bodyHash ?? null })
  }
  const pending = pendingRecords(triaged, (id) => stamps.get(id) ?? { specHash: null, bodyHash: null })

  const groups = new Map<SpecId, TriageRecord[]>()
  for (const record of pending) groups.set(record.spec, [...(groups.get(record.spec) ?? []), record])
  const order = [...groups.keys()].sort()

  const needsLive = order.some((id) => groups.get(id)!.some(isSpecWrong))
  const live = needsLive ? await reachable(project.config.baseURL, project.signal) : true
  if (!live) log.warn(`${project.config.baseURL} is unreachable; spec-wrong repairs need the live app and are skipped.`)

  const applied: FixProposal[] = []
  const declined: FixProposal[] = []
  const unresolved: { spec: SpecId; detail: string }[] = []
  const approved: SpecId[] = []
  const hints = new Map<SpecId, string>()

  for (const id of order) {
    if (project.signal?.aborted) break
    const records = groups.get(id)!
    const spec = suite.specs.get(id) as Spec
    let proposal: FixProposal

    if (records.some(isSpecWrong)) {
      if (!live) {
        unresolved.push({ spec: id, detail: `${project.config.baseURL} is unreachable, so the spec cannot be checked against the app.` })
        continue
      }
      const result = await project.agent.run(await specEditTask(project, spec, records))
      if (result.status === 'unsubmitted') {
        if (result.reason === 'aborted') break
        const why = result.reason === 'ended' ? `agent ended without proposing an edit: ${result.lastText}` : 'agent ran out of budget before proposing an edit'
        unresolved.push({ spec: id, detail: why })
        continue
      }
      const { markdown, summary } = result.value
      proposal = {
        kind: 'edit-spec',
        spec: id,
        file: spec.file,
        before: spec.source,
        after: markdown,
        diff: unifiedDiff(spec.source, markdown, spec.file),
        summary,
      }
    } else {
      proposal = { kind: 'regenerate', spec: id, reason: records.map((r) => r.verdict.evidence).join('\n') }
    }

    if (!(await options.confirm(proposal))) {
      declined.push(proposal)
      continue
    }
    if (proposal.kind === 'edit-spec') {
      await workspace.writeSpec(spec, proposal.after)
    } else {
      hints.set(id, proposal.reason)
    }
    applied.push(proposal)
    approved.push(id)
  }

  if (approved.length === 0) return { applied, declined, unresolved, generated: { written: [], fresh: [], failed: [] } }

  const reloaded = await openProject(options)
  const generated = await generateSpecs(reloaded, approved, { force: true, hints })
  return { applied, declined, unresolved, generated }
}

export type { FixProposal } from './fixer.js'
