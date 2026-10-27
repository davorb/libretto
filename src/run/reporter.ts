import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FullConfig, FullResult, Reporter, Suite as PwSuite, TestCase, TestResult, TestStep } from '@playwright/test/reporter'
import { parseStepTitle, type StepRef } from '../spec/index.js'
import { openWorkspace, parseHeader, type FailureId, type FailureRecord, type RunId, type Workspace } from '../workspace/index.js'

const ANSI = /\u001b\[[0-9;]*m/g

/** Steps from the root to the deepest failed one. Playwright nests `expect` steps under `test.step`s. */
function failedStepChain(steps: readonly TestStep[]): TestStep[] {
  const failed = steps.find((s) => s.error)
  return failed ? [failed, ...failedStepChain(failed.steps)] : []
}

/** The deepest failed step that Libretto rendered; Playwright's own `expect` and hook steps do not parse. */
function failedStepRef(scenario: string, result: TestResult): StepRef | null {
  for (const step of failedStepChain(result.steps).reverse()) {
    const ref = parseStepTitle(scenario, step.title)
    if (ref) return ref
  }
  return null
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, '_')

/**
 * Playwright reporter shipped as `libretto/reporter`. It runs in Playwright's process,
 * not Libretto's, so it opens the workspace itself from the `workspace` option.
 *
 * - Keeps each test's last attempt; `test.outcome()` then gives the final outcome
 *   ('unexpected' → failure, 'flaky' → flaky). Triage only ever sees post-retry results (SPEC).
 * - For each failure: reads the file's header (`parseHeader`) for spec id and stamp,
 *   finds the deepest failing `test.step` and maps it with `parseStepTitle`, and
 *   collects trace, screenshot, and the `libretto-dom` attachment paths.
 * - `onEnd`: one atomic `workspace.mergeLastRun(latest, ran, failures, flaky)`, where
 *   `ran` is every FailureId this run executed. A partial run replaces only its own
 *   entries. An interrupted run leaves the previous last-run.json intact.
 *
 * Maps Playwright types to `FailureRecord` here; no Playwright type leaves this file.
 */
export default class LibrettoReporter implements Reporter {
  private readonly workspace: Workspace
  private readonly runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}` as RunId
  private startedAt = new Date().toISOString()
  private readonly lastAttempt = new Map<string, { test: TestCase; result: TestResult }>()

  constructor(private readonly options: { workspace: string; specsDir: string; baseURL: string }) {
    this.workspace = openWorkspace(options.workspace, options.specsDir)
  }

  onBegin(_config: FullConfig, _suite: PwSuite): void {
    this.startedAt = new Date().toISOString()
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.lastAttempt.set(test.id, { test, result })
  }

  async onEnd(result: FullResult): Promise<void> {
    if (result.status === 'interrupted') return
    const ran: FailureId[] = []
    const failures: FailureRecord[] = []
    const flaky: FailureId[] = []
    let passed = 0
    for (const { test, result: last } of this.lastAttempt.values()) {
      const outcome = test.outcome()
      if (outcome === 'skipped') continue
      const parsed = parseHeader(await readFile(test.location.file, 'utf8').catch(() => ''))
      if (!parsed) continue
      const project = test.parent.project()?.name ?? ''
      const id = `${parsed.header.spec}::${project}::${test.title}` as FailureId
      ran.push(id)
      if (outcome === 'expected') passed++
      else if (outcome === 'flaky') {
        passed++
        flaky.push(id)
      } else {
        failures.push(await this.failureRecord(id, test, last, project, parsed.header))
      }
    }
    const latest = { runId: this.runId, startedAt: this.startedAt, baseURL: this.options.baseURL, passed }
    await this.workspace.mergeLastRun(latest, ran, failures, flaky)
  }

  private async failureRecord(
    id: FailureId,
    test: TestCase,
    result: TestResult,
    project: string,
    header: NonNullable<ReturnType<typeof parseHeader>>['header'],
  ): Promise<FailureRecord> {
    const error = result.error ?? result.errors[0]
    const attachments = result.attachments
    const trace = attachments.find((a) => a.name === 'trace' && a.path)?.path ?? null
    const screenshots = attachments.filter((a) => a.name === 'screenshot' && a.path).map((a) => a.path as string)
    const dom = attachments.find((a) => a.name === 'libretto-dom')
    let domSnapshot = dom?.path ?? null
    if (dom && !domSnapshot && dom.body) {
      // Body-only attachments live in memory; persist them, since Playwright's outputDir is wiped by the next run.
      domSnapshot = path.join(this.workspace.dir, 'artifacts', this.runId, `${safeName(id)}.dom.json`)
      await mkdir(path.dirname(domSnapshot), { recursive: true })
      await writeFile(domSnapshot, dom.body)
    }
    return {
      id,
      runId: this.runId,
      spec: header.spec,
      scenario: test.title,
      project,
      step: failedStepRef(test.title, result),
      error: {
        message: (error?.message ?? 'Test failed without an error').replace(ANSI, ''),
        stack: error?.stack?.replace(ANSI, '') ?? null,
      },
      artifacts: { trace, screenshots, domSnapshot },
      generated: { specHash: header.specHash, appHash: header.appHash, bodyHash: header.bodyHash },
      retries: result.retry,
    }
  }
}
