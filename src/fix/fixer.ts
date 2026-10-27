import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { MissingSecretsError, Secrets, secretUsageInstructions } from '../agent/index.js'
import type { AgentTask, BrowserTarget, Submission } from '../agent/index.js'
import type { Project } from '../project/index.js'
import type { Spec, SpecId, Suite } from '../spec/index.js'
import { parseHeader } from '../workspace/index.js'
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

const ENV_REF = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/**
 * `propose_spec_edit`. `accept` runs `suite.withEdit(spec.id, markdown)`. Issues are
 * returned to the agent. It also rejects edits that change the title, change `uses`,
 * drop a scenario that was not failing, or add an `{{env.X}}` that is not set (the
 * agent can't know the value, so it can't make one up).
 *
 * `failing` names the scenarios with a `spec-wrong` verdict; only those may be dropped or renamed.
 */
export function proposeSpecEdit(
  suite: Suite,
  spec: Spec,
  failing: ReadonlySet<string> = new Set(),
  env: NodeJS.ProcessEnv = process.env,
): Submission<z.infer<typeof specEditInput>, SpecEdit> {
  return {
    name: 'propose_spec_edit',
    description:
      'Submit the full edited markdown of the spec (the whole file, not a patch) and a one-sentence summary of what changed and why. ' +
      'Keep the title and `uses` as they are. Call once, when the spec describes what the app does now.',
    input: specEditInput,
    async accept(input) {
      const edited = suite.withEdit(spec.id, input.markdown)
      if (Array.isArray(edited)) {
        const list = edited.map((i) => `${i.line === null ? '' : `line ${i.line}: `}${i.message}`).join('\n')
        return { ok: false, feedback: `The edited spec does not parse. Fix these and resubmit:\n${list}` }
      }
      const next = (edited as Suite).specs.get(spec.id)
      if (next === undefined) return { ok: false, feedback: 'The edited spec could not be located after parsing. Resubmit the full file.' }
      if (next.title !== spec.title) {
        return { ok: false, feedback: `Keep the title "# ${spec.title}". Renaming a spec is not part of a repair.` }
      }
      if (next.uses !== spec.uses) {
        return { ok: false, feedback: `Keep \`uses\` as it is (${spec.uses ?? 'none'}). Changing fixtures is not part of a repair.` }
      }
      const names = new Set(next.scenarios.map((s) => s.name))
      const dropped = spec.scenarios.map((s) => s.name).filter((n) => !names.has(n) && !failing.has(n))
      if (dropped.length > 0) {
        return {
          ok: false,
          feedback: `These scenarios were not failing and must stay: ${dropped.map((n) => `"${n}"`).join(', ')}. Only edit the failing scenarios (${[...failing].map((n) => `"${n}"`).join(', ') || 'none'}).`,
        }
      }
      const known = new Set(spec.envRefs)
      const unset = next.envRefs.filter((n) => !known.has(n) && (env[n] === undefined || env[n] === ''))
      if (unset.length > 0) {
        return {
          ok: false,
          feedback: `{{env.${unset.join('}}, {{env.')}}} ${unset.length === 1 ? 'is' : 'are'} not set in this environment, so you cannot introduce ${unset.length === 1 ? 'it' : 'them'}. Describe the step without a new secret, or reuse one the spec already has.`,
        }
      }
      return { ok: true, value: { markdown: input.markdown, summary: input.summary } }
    },
  }
}

const SYSTEM = `You repair one markdown spec for an end-to-end test suite. The app changed on purpose, and a triage verdict says the spec no longer describes what the app does.

Your job is to make the spec describe what the app does now, with the smallest edit that does it. Keep scenario names wherever the behavior they describe still exists. Do not touch scenarios that are not failing. Do not change the title or the \`uses\` line. Keep the spec's style: short imperative bullets under Steps and observable outcomes under Expect.

Use the browser tools to confirm what the app does now before you edit. Never write a secret value into the spec. Reference secrets as {{env.NAME}} only, and only names the spec already uses.
End by calling propose_spec_edit once with the full edited file.`

const safeName = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, '_')

/** A failure id is `${specId}::${project}::${scenario}`. */
export function scenarioOf(record: TriageRecord): string {
  const rest = record.failure.slice(record.spec.length + 2)
  const at = rest.indexOf('::')
  return at < 0 ? rest : rest.slice(at + 2)
}

async function generatedBody(project: Project, spec: Spec): Promise<string> {
  try {
    const text = await readFile(project.workspace.generatedFile(spec.id), 'utf8')
    return parseHeader(text)?.body ?? text
  } catch {
    return '(generated file unavailable)'
  }
}

/**
 * The agent sees app.md, the spec, the generated test, and every `spec-wrong` verdict
 * for this spec. It gets live Playwright MCP to confirm what the app does now, and edits
 * the spec to describe that. Without baseURL, `fix` refuses spec-wrong proposals (it
 * would be guessing) and reports them.
 */
export async function specEditTask(project: Project, spec: Spec, verdicts: readonly TriageRecord[]): Promise<AgentTask<SpecEdit>> {
  const { baseURL } = project.config
  const wrong = verdicts.filter((r) => r.verdict.kind === 'test-broken' && r.verdict.cause === 'spec-wrong')

  let secrets = Secrets.none
  try {
    const sealed = Secrets.fromEnv(spec.envRefs, process.env)
    secrets = sealed.secrets
    if (sealed.short.length > 0) project.log.warn(`Secrets too short to redact: ${sealed.short.join(', ')}.`)
  } catch (error) {
    if (!(error instanceof MissingSecretsError)) throw error
    project.log.warn(`${error.message} Proposing the edit for ${spec.id} without secrets; login steps cannot be checked live.`)
  }

  const browser: BrowserTarget = {
    baseURL,
    secrets,
    storageState: null,
    headless: true,
    outputDir: path.join(project.workspace.dir, 'agent-output', `fix-${safeName(spec.id)}`),
  }

  const verdictText = wrong
    .map((r) => `- Scenario "${scenarioOf(r)}" (${r.failure}): ${r.verdict.evidence}`)
    .join('\n')

  const prompt = [
    `## app.md\n${project.suite.app.source}`,
    `## Spec ${spec.id}\n${spec.source}`,
    `## Generated test body\n${await generatedBody(project, spec)}`,
    `## Triage verdicts (spec-wrong)\n${verdictText}`,
    `## Environment\nThe app is live at ${baseURL}. Confirm the current behavior through the browser tools.\n${secretUsageInstructions(secrets)}`.trimEnd(),
    '## Output\nCall `propose_spec_edit` once with `markdown` (the complete edited spec file) and `summary` (one sentence on what changed and why).',
  ].join('\n\n')

  const failing = new Set(wrong.map(scenarioOf))
  return {
    label: `fix ${spec.id}`,
    system: SYSTEM,
    prompt,
    tools: [],
    submit: proposeSpecEdit(project.suite, spec, failing),
    browser,
    profile: project.config.profiles.fix,
    cwd: project.config.root,
    ...(project.signal ? { signal: project.signal } : {}),
    onEvent: (event) => project.log.agent(`fix ${spec.id}`, event),
  }
}

/**
 * Pure: which triage records still need action. A record is handled (skipped) when the
 * current files no longer match what it diagnosed:
 * - spec-wrong: current spec.hash ≠ record.generated.specHash (the spec was already edited)
 * - generated-code-wrong: current generated stamp.bodyHash ≠ record.generated.bodyHash (already regenerated)
 * No "resolved" flag is stored, because the files are the source of truth (idempotent re-runs).
 *
 * Only `test-broken` records are ever pending; `app-broken` and `inconclusive` are not fixable here.
 */
export function pendingRecords(
  records: readonly TriageRecord[],
  current: (spec: SpecId) => { specHash: string | null; bodyHash: string | null },
): readonly TriageRecord[] {
  return records.filter((record) => {
    const { verdict } = record
    if (verdict.kind !== 'test-broken') return false
    const now = current(record.spec)
    return verdict.cause === 'spec-wrong'
      ? now.specHash === record.generated.specHash
      : now.bodyHash === record.generated.bodyHash
  })
}
