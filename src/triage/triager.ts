import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { MissingSecretsError, Secrets, secretUsageInstructions } from '../agent/index.js'
import type { AgentResult, AgentTask, BrowserTarget, Submission } from '../agent/index.js'
import type { Project } from '../project/index.js'
import type { Spec } from '../spec/index.js'
import { parseHeader } from '../workspace/index.js'
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
  return {
    name: 'submit_verdict',
    description:
      'Submit your final verdict, once. kind is app-broken, test-broken, or inconclusive. ' +
      'cause (spec-wrong or generated-code-wrong) is required for test-broken and forbidden otherwise. ' +
      'evidence says what you observed that decides it.',
    input: verdictInput,
    async accept(input) {
      if (input.kind === 'test-broken') {
        if (input.cause === undefined) {
          return { ok: false, feedback: 'A test-broken verdict needs a cause: "spec-wrong" or "generated-code-wrong".' }
        }
        return { ok: true, value: { kind: 'test-broken', cause: input.cause, evidence: input.evidence } }
      }
      if (input.cause !== undefined) {
        return { ok: false, feedback: `cause applies only to test-broken. Resubmit the ${input.kind} verdict without a cause.` }
      }
      return { ok: true, value: { kind: input.kind, evidence: input.evidence } }
    },
  }
}

/**
 * Pure. The single mapping from agent outcome to verdict (SPEC):
 * - submitted → the value
 * - turn-cap | budget-cap → inconclusive, evidence 'budget exhausted'
 * - ended → inconclusive, evidence 'agent ended without a verdict: <lastText>'
 * - aborted → never reaches here (the command stops and writes nothing for this failure)
 */
export function verdictFrom(result: Exclude<AgentResult<Verdict>, { status: 'unsubmitted'; reason: 'aborted' }>): Verdict {
  if (result.status === 'submitted') return result.value
  switch (result.reason) {
    case 'turn-cap':
    case 'budget-cap':
      return { kind: 'inconclusive', evidence: 'budget exhausted' }
    case 'ended':
      return { kind: 'inconclusive', evidence: `agent ended without a verdict: ${result.lastText}` }
    case 'aborted':
      throw new Error('verdictFrom received an aborted result; the caller must stop instead')
  }
}

const SYSTEM = `You triage one failed end-to-end test. The test was generated from a markdown spec that describes the app's behavior. Decide why it failed and submit exactly one verdict.

Verdicts:
- app-broken: the app no longer does what the spec says. The spec is still right and the generated code expresses it correctly.
- test-broken with cause spec-wrong: the app legitimately changed and the spec no longer matches it. The app works; the spec describes old behavior.
- test-broken with cause generated-code-wrong: the spec is right and the app does it, but the generated code is wrong, for example a brittle or incorrect locator or a bad wait.
- inconclusive: you cannot tell from the evidence.

When browser tools are available, probe the live app to check what it really does. Use the evidence tools (view_screenshot, read_dom, read_trace) to inspect what the test saw when it failed. Do not guess: ground the verdict in what you observed, and put that in the evidence.
End by calling submit_verdict once.`

const TRACE_TAIL = 15

function quoteStep(spec: Spec, failure: FailureRecord): string {
  const { step } = failure
  if (step === null) return 'The failure happened outside any step.'
  const scenario = spec.scenarios.find((s) => s.name === step.scenario)
  const text = scenario?.[step.section][step.index - 1]?.text
  const label = `${step.section === 'steps' ? 'Steps' : 'Expect'} ${step.index}`
  return text === undefined
    ? `${label} of scenario "${step.scenario}" (no longer found in the spec).`
    : `${label} of scenario "${step.scenario}": ${text}`
}

async function generatedBody(project: Project, spec: Spec): Promise<string> {
  try {
    const text = await readFile(project.workspace.generatedFile(spec.id), 'utf8')
    return parseHeader(text)?.body ?? text
  } catch {
    return '(generated file unavailable)'
  }
}

function traceSummary(actions: readonly { index: number; title: string; error: string | null }[] | null): string {
  if (actions === null) return 'The trace is unavailable.'
  if (actions.length === 0) return 'The trace holds no actions.'
  const tail = actions.slice(-TRACE_TAIL)
  const lines = tail.map((a) => `${a.index}. ${a.title}${a.error === null ? '' : ` ERROR: ${a.error}`}`)
  return `Last ${tail.length} of ${actions.length} actions:\n${lines.join('\n')}`
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, '_')

/**
 * Builds the triage task. The prompt has app.md, the spec, the failing step (by StepRef,
 * quoted from the spec), the error, a trace summary, the generated test body, and the
 * three verdict definitions. `live === false` → `browser: null` and the prompt says to
 * judge from artifacts only.
 * Secrets: the spec's envRefs are sealed so live probing can log in. They are never in the prompt.
 */
export async function triageTask(project: Project, spec: Spec, failure: FailureRecord, live: boolean): Promise<AgentTask<Verdict>> {
  const evidence = await loadEvidence(failure)
  const { baseURL } = project.config

  let secrets = Secrets.none
  if (live) {
    try {
      const sealed = Secrets.fromEnv(spec.envRefs, process.env)
      secrets = sealed.secrets
      if (sealed.short.length > 0) project.log.warn(`Secrets too short to redact: ${sealed.short.join(', ')}.`)
    } catch (error) {
      if (!(error instanceof MissingSecretsError)) throw error
      project.log.warn(`${error.message} Triaging without secrets; live login probes may fail.`)
    }
  }

  const browser: BrowserTarget | null = live
    ? {
        baseURL,
        secrets,
        storageState: null,
        headless: true,
        outputDir: path.join(project.workspace.dir, 'agent-output', safeName(failure.id)),
      }
    : null

  const mode = live
    ? `The app is live at ${baseURL}. Probe it through the browser tools.\n${secretUsageInstructions(secrets)}`.trimEnd()
    : `The app at ${baseURL} is unreachable. There are no browser tools. Judge from the recorded artifacts only, and say in your evidence that you could not probe the app.`

  const prompt = [
    `## app.md\n${project.suite.app.source}`,
    `## Spec ${spec.id}\n${spec.source}`,
    `## Failure\nScenario: ${failure.scenario} (project ${failure.project})\nFailing step: ${quoteStep(spec, failure)}\nError:\n${failure.error.message}`,
    `## Trace\n${traceSummary(evidence.actions)}`,
    `## Generated test body\n${await generatedBody(project, spec)}`,
    `## Environment\n${mode}`,
  ].join('\n\n')

  return {
    label: `triage ${failure.id}`,
    system: SYSTEM,
    prompt,
    tools: evidenceTools(evidence),
    submit: submitVerdict(),
    browser,
    profile: project.config.profiles.triage,
    cwd: project.config.root,
    ...(project.signal ? { signal: project.signal } : {}),
    onEvent: (event) => project.log.agent(`triage ${failure.id}`, event),
  }
}

/**
 * One failure → one record. When `live` is false the triager, not the agent, prefixes
 * the evidence with "[artifacts only: <baseURL> unreachable] " (SPEC: "says so in the verdict").
 */
export async function triageOne(project: Project, failure: FailureRecord, live: boolean): Promise<TriageRecord | 'aborted'> {
  const spec = project.suite.specs.get(failure.spec)
  if (spec === undefined) throw new Error(`Failure ${failure.id} names unknown spec ${failure.spec}.`)
  const task = await triageTask(project, spec, failure, live)
  const result = await project.agent.run(task)
  if (result.status === 'unsubmitted' && result.reason === 'aborted') return 'aborted'
  const verdict = verdictFrom(result)
  const prefixed: Verdict = live
    ? verdict
    : { ...verdict, evidence: `[artifacts only: ${project.config.baseURL} unreachable] ${verdict.evidence}` }
  return {
    failure: failure.id,
    runId: failure.runId,
    spec: failure.spec,
    generated: failure.generated,
    verdict: prefixed,
    live,
    model: project.config.profiles.triage.model,
    usage: result.usage,
    at: new Date().toISOString(),
  }
}

const PROBE_TIMEOUT_MS = 3000

/** GET baseURL with a short timeout; any HTTP response counts as reachable. */
export async function probe(baseURL: string, signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(baseURL, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}
