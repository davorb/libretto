import path from 'node:path'
import { MissingSecretsError, Secrets, secretUsageInstructions, type AgentTask, type Submission } from '../agent/index.js'
import type { Project } from '../project/index.js'
import { stepTitle, type Spec, type SpecId } from '../spec/index.js'
import type { RenderedTest, Staleness } from '../workspace/index.js'
import { checkDraft, renderTest, testDraftInput, type TestDraft } from './draft.js'
import { FixtureNotReadyError, prepareStorageState, runDraft } from '../run/index.js'

/** Per-spec result, aggregated into GenerateReport by `generateSpecs`. */
export type SpecGeneration =
  | { readonly status: 'written'; readonly spec: SpecId; readonly replaced: Staleness }
  | { readonly status: 'fresh'; readonly spec: SpecId }
  | {
      readonly status: 'failed'
      readonly spec: SpecId
      readonly reason: 'turn-cap' | 'budget-cap' | 'ended' | 'aborted' | 'fixture-not-ready' | 'missing-secrets'
      readonly detail: string
    }

/**
 * The `write_test` submission for one spec. `accept`:
 * 1. `checkDraft` → reject with the list of problems
 * 2. `renderTest`
 * 3. `secrets.findLeak(body)` → reject naming the env var (value never echoed)
 * 4. `runDraft(...)` → on failure reject with the failing step title, error, and trimmed output
 * 5. ok → value is the RenderedTest. The caller writes it; the agent never writes files.
 */
export function writeTestSubmission(
  project: Project,
  spec: Spec,
  secrets: Secrets,
  storageState: string | null,
): Submission<TestDraft, RenderedTest> {
  return {
    name: 'write_test',
    description:
      'Submit the test code for this spec. Libretto renders the file, runs it once against the live app, and either accepts it or returns what to fix. ' +
      'Provide `helpers` (optional top-level code, no imports) and, per scenario, one code string per Steps bullet and per Expect bullet, in order.',
    input: testDraftInput,
    async accept(draft) {
      const problems = checkDraft(spec, draft)
      if (problems.length > 0) {
        return { ok: false, feedback: `The draft was not accepted. Fix these and call write_test again:\n${problems.map((p) => `- ${p}`).join('\n')}` }
      }

      const rendered = renderTest(spec, project.suite.app, draft, {
        storageStateIn: storageState,
        storageStateOut: spec.kind === 'fixture' ? project.workspace.stateFile(spec.id) : null,
      })

      const leaked = secrets.findLeak(rendered.body)
      if (leaked !== null) {
        return {
          ok: false,
          feedback: `The draft contains the value of the secret ${leaked}. Never write a secret value into code. Use process.env.${leaked} and call write_test again.`,
        }
      }

      const result = await runDraft(project, rendered, path.relative(project.config.root, spec.file), storageState)
      if (result.passed) return { ok: true, value: rendered }

      const { scenario, step, error } = result.failure
      const where = step === null ? `scenario ${JSON.stringify(scenario)} (outside any step)` : `scenario ${JSON.stringify(scenario)}, ${stepTitle(step.section, step.index, stepText(spec, step.scenario, step.section, step.index))}`
      const feedback = [
        `The draft ran against the app and failed in ${where}.`,
        `Error: ${error.message}`,
        `Test output (trimmed):\n${tail(result.output, OUTPUT_LIMIT)}`,
        'Use the browser to check the page, fix the code, and call write_test again.',
      ].join('\n\n')
      return { ok: false, feedback: secrets.redact(feedback) }
    },
  }
}

const OUTPUT_LIMIT = 4000

function tail(text: string, limit: number): string {
  const t = text.trim()
  return t.length <= limit ? t : `…${t.slice(t.length - limit)}`
}

function stepText(spec: Spec, scenario: string, section: 'steps' | 'expect', index: number): string {
  return spec.scenarios.find((s) => s.name === scenario)?.[section][index - 1]?.text ?? ''
}

const SYSTEM = `You write Playwright test code for Libretto from a plain-language spec. You explore the real app with the browser tools, then submit the code once through the write_test tool. You never write files; Libretto renders the file and runs your code against the app before accepting it.

Rules for the code you write:
- Locate elements by role first (getByRole with a name). Use getByLabel, getByPlaceholder, or getByText next. Use getByTestId only when nothing else identifies the element.
- Never use waitForTimeout or fixed sleeps. Rely on Playwright's auto-waiting and on web-first assertions.
- Assert with web-first expect, for example await expect(locator).toBeVisible() or toHaveText(...). Do not assert on values you read earlier with isVisible() or textContent().
- Navigate with relative URLs such as page.goto('/login'). The baseURL comes from the config. Never write an absolute URL.
- Write exactly one code block per bullet. A Steps bullet becomes the body of one step, and an Expect bullet becomes one assertion block. Use await. The variables \`page\` and \`expect\` are in scope.
- Do not write imports, test(...), or test.describe(...). Libretto emits those.
- Shared helpers (small functions, locator factories) go in \`helpers\`, as top-level code without imports.
- A secret appears in the spec as {{env.NAME}}. In code, write process.env.NAME. Never write the value.
- Scenario names must match the spec's exactly, in the same order.

The write_test input has these fields:
- helpers: string, optional. Top-level code placed before the tests. No imports.
- scenarios: array, at least one. Each has:
  - name: string, the spec's scenario name verbatim.
  - steps: string[], one code block per Steps bullet, in order.
  - expect: string[], one code block per Expect bullet, in order.

If write_test rejects the draft, read the feedback, fix the code, and call it again.`

/**
 * Prompt for generating one spec. The system prompt carries Libretto's rules for
 * generated code: role-based locators first, no sleeps, web-first assertions, how to
 * type a secret by name. The user prompt carries `app.md`, the fixture chain's sources
 * (as "already done before this test starts"), the spec source, an optional `hint`
 * (verdict evidence from `fix`), and the exact `write_test` contract.
 * Secrets appear by name only; the prompt builders never receive a `Secrets` value.
 */
export function generationTask(
  project: Project,
  spec: Spec,
  submit: Submission<TestDraft, RenderedTest>,
  browser: { storageState: string | null; secrets: Secrets },
  hint: string | null,
): AgentTask<RenderedTest> {
  const chain = project.suite.fixtureChain(spec)
  const contract = spec.scenarios
    .map((s) => `- ${JSON.stringify(s.name)}: steps ${s.steps.length}, expect ${s.expect.length}`)
    .join('\n')
  const secretNote = secretUsageInstructions(browser.secrets)

  const sections = [
    `# About the app (app.md)\n\n${project.suite.app.source.trim()}`,
    ...(chain.length > 0
      ? [
          `# Already done before this test starts\n\nThe browser starts with this already completed (its saved session is loaded). Do not repeat it.\n\n${chain
            .map((f) => `## ${f.id}\n\n${f.source.trim()}`)
            .join('\n\n')}`,
        ]
      : []),
    `# Spec to implement (${spec.id})\n\n${spec.source.trim()}`,
    `# What write_test must contain\n\nScenarios, in this order, with exactly this many code blocks:\n${contract}`,
    ...(hint !== null ? [`# Hint from a previous failure\n\n${hint.trim()}`] : []),
    ...(secretNote !== '' ? [`# Secrets\n\n${secretNote}`] : []),
    `Explore the app at ${project.config.baseURL} with the browser, then call write_test.`,
  ]

  return {
    label: `generate ${spec.id}`,
    system: SYSTEM,
    prompt: sections.join('\n\n'),
    tools: [],
    submit,
    browser: {
      baseURL: project.config.baseURL,
      secrets: browser.secrets,
      storageState: browser.storageState,
      headless: true,
      outputDir: path.join(project.workspace.dir, 'agent-output', spec.id.replaceAll('/', '__')),
    },
    profile: project.config.profiles.generate,
    cwd: project.config.root,
    ...(project.signal ? { signal: project.signal } : {}),
    onEvent: (event) => project.log.agent(`generate ${spec.id}`, event),
  }
}

/**
 * One spec, end to end:
 *   workspace.staleness(spec, suite.app) → (fresh && !force) → { fresh }
 *     (`app-changed` counts as stale: app.md is input to every generation)
 *   secrets = Secrets.fromEnv(spec.envRefs, process.env)   (MissingSecretsError → failed)
 *     (fixtures' own refs are consumed by their setup tests in the Playwright child, not by the agent)
 *   storageState = prepareStorageState(ctx, suite.fixtureChain(spec))     (FixtureNotReadyError → failed)
 *   result = project.agent.run(generationTask(...))
 *   submitted → workspace.writeGenerated(value) ; warn if replaced === 'hand-edited' (SPEC: names the file)
 *   unsubmitted → failed with result.reason, generated file untouched
 */
export async function generateOne(project: Project, spec: Spec, opts: { force: boolean; hint: string | null }): Promise<SpecGeneration> {
  const { workspace, suite, log } = project
  const failed = (reason: Extract<SpecGeneration, { status: 'failed' }>['reason'], detail: string): SpecGeneration => ({
    status: 'failed',
    spec: spec.id,
    reason,
    detail,
  })

  const state = await workspace.staleness(spec, suite.app)
  if (state === 'fresh' && !opts.force) return { status: 'fresh', spec: spec.id }

  let secrets: Secrets
  try {
    const sealed = Secrets.fromEnv(spec.envRefs, process.env)
    secrets = sealed.secrets
    if (sealed.short.length > 0) {
      log.warn(`${spec.id}: ${sealed.short.join(', ')} ${sealed.short.length === 1 ? 'is' : 'are'} too short to redact from transcripts and logs.`)
    }
  } catch (error) {
    if (error instanceof MissingSecretsError) return failed('missing-secrets', error.message)
    throw error
  }

  let storageState: string | null
  try {
    storageState = await prepareStorageState(project, suite.fixtureChain(spec))
  } catch (error) {
    if (error instanceof FixtureNotReadyError) return failed('fixture-not-ready', error.message)
    throw error
  }

  const submit = writeTestSubmission(project, spec, secrets, storageState)
  const result = await project.agent.run(generationTask(project, spec, submit, { storageState, secrets }, opts.hint))
  if (result.status === 'unsubmitted') return failed(result.reason, result.lastText)

  // The header names the spec relative to the project root, so it reads the same on every machine.
  const { replaced } = await workspace.writeGenerated(result.value, path.relative(project.config.root, spec.file))
  if (replaced === 'hand-edited') {
    log.warn(`${spec.id}: overwrote hand edits in ${workspace.generatedFile(spec.id)}. Change the spec instead; generated files are rewritten.`)
  }
  return { status: 'written', spec: spec.id, replaced }
}
