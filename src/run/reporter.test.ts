import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FullResult, TestCase, TestResult, TestStep } from '@playwright/test/reporter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stepTitle, type AppHash, type SpecHash, type SpecId } from '../spec/index.js'
import { openWorkspace, type FailureId, type RunId, type Workspace } from '../workspace/index.js'
import { renderHeader } from '../workspace/header.js'
import LibrettoReporter from './reporter.js'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'libretto-reporter-'))
  ws = openWorkspace(root, path.join(root, 'specs'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function generatedFile(id: string): Promise<string> {
  const file = ws.generatedFile(id as SpecId)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, renderHeader(id as SpecId, `specs/${id}.md`, 'spec-hash' as SpecHash, 'app-hash' as AppHash, 'body\n'))
  return file
}

const step = (title: string, steps: TestStep[] = [], failed = false): TestStep => ({ title, steps, error: failed ? { message: 'bad' } : undefined }) as unknown as TestStep

function fakeTest(file: string, title: string, outcome: ReturnType<TestCase['outcome']>, project = 'scenarios'): TestCase {
  return { id: `${file}:${title}`, title, location: { file }, parent: { project: () => ({ name: project }) }, outcome: () => outcome } as unknown as TestCase
}

function fakeResult(over: Partial<{ steps: TestStep[]; attachments: object[]; retry: number; message: string }> = {}): TestResult {
  const error = { message: `\u001b[31m${over.message ?? 'expected 1 to be 2'}\u001b[39m`, stack: 'stack' }
  return { retry: over.retry ?? 0, error, errors: [error], steps: over.steps ?? [], attachments: over.attachments ?? [] } as unknown as TestResult
}

async function run(tests: [TestCase, TestResult][], status: FullResult['status'] = 'failed') {
  const reporter = new LibrettoReporter({ workspace: root, specsDir: ws.specsDir, baseURL: 'http://app' })
  reporter.onBegin({} as never, {} as never)
  for (const [t, r] of tests) reporter.onTestEnd(t, r)
  await reporter.onEnd({ status, startTime: new Date(), duration: 1 })
}

describe('LibrettoReporter', () => {
  it('records a failure with FailureId, the deepest Libretto step, header stamp, and artifacts', async () => {
    const file = await generatedFile('auth/login')
    const failing = fakeResult({
      steps: [
        step('Before Hooks'),
        step(stepTitle('steps', 1, 'Open'), []),
        step(stepTitle('expect', 2, 'See it'), [step('Expect "toBe"', [], true)], true),
      ],
      attachments: [
        { name: 'trace', path: '/out/trace.zip', contentType: 'application/zip' },
        { name: 'screenshot', path: '/out/shot.png', contentType: 'image/png' },
        { name: 'libretto-dom', body: Buffer.from('{"html":"<p>"}'), contentType: 'application/json' },
      ],
      retry: 2,
    })
    await run([[fakeTest(file, 'valid credentials', 'unexpected'), failing]])

    const record = await ws.readLastRun()
    const id = 'auth/login::scenarios::valid credentials' as FailureId
    const failure = record?.failures[id]
    expect(failure).toMatchObject({
      id,
      spec: 'auth/login',
      scenario: 'valid credentials',
      project: 'scenarios',
      step: { scenario: 'valid credentials', section: 'expect', index: 2 },
      error: { message: 'expected 1 to be 2', stack: 'stack' },
      generated: { specHash: 'spec-hash', appHash: 'app-hash' },
      retries: 2,
      artifacts: { trace: '/out/trace.zip', screenshots: ['/out/shot.png'] },
    })
    expect(failure?.runId).toBe(record?.latest.runId)
    expect(await readFile(failure!.artifacts.domSnapshot!, 'utf8')).toBe('{"html":"<p>"}')
    expect(record?.latest).toMatchObject({ baseURL: 'http://app', passed: 0 })
  })

  it('uses a null step when the failure is outside any rendered step', async () => {
    const file = await generatedFile('auth/login')
    await run([[fakeTest(file, 's', 'unexpected'), fakeResult({ steps: [step('Before Hooks', [], true)] })]])
    expect((await ws.readLastRun())?.failures['auth/login::scenarios::s' as FailureId]?.step).toBeNull()
  })

  it('keeps only the final attempt, counts passes and flaky, and ignores skipped tests', async () => {
    const file = await generatedFile('auth/login')
    const flaky = fakeTest(file, 'flaky one', 'flaky')
    await run([
      [fakeTest(file, 'ok', 'expected'), fakeResult()],
      [flaky, fakeResult()],
      [flaky, fakeResult()],
      [fakeTest(file, 'skipped', 'skipped'), fakeResult()],
    ], 'passed')
    const record = await ws.readLastRun()
    expect(record?.latest.passed).toBe(2)
    expect(record?.flaky).toEqual(['auth/login::scenarios::flaky one'])
    expect(record?.failures).toEqual({})
  })

  it('merges a partial run: replaces its own entries and leaves the others', async () => {
    const login = await generatedFile('auth/login')
    const cart = await generatedFile('cart/checkout')
    await run([
      [fakeTest(login, 'a', 'unexpected'), fakeResult()],
      [fakeTest(cart, 'b', 'unexpected'), fakeResult()],
    ])
    const first = (await ws.readLastRun())!
    await run([[fakeTest(login, 'a', 'expected'), fakeResult()]], 'passed')
    const second = (await ws.readLastRun())!
    expect(Object.keys(second.failures)).toEqual(['cart/checkout::scenarios::b'])
    expect(second.failures['cart/checkout::scenarios::b' as FailureId]?.runId).toBe(first.latest.runId)
    expect(second.latest.runId).not.toBe(first.latest.runId as RunId)
  })

  it('leaves last-run.json untouched when the run was interrupted', async () => {
    const file = await generatedFile('auth/login')
    await run([[fakeTest(file, 'a', 'unexpected'), fakeResult()]], 'interrupted')
    expect(await ws.readLastRun()).toBeNull()
  })

  it('ignores tests whose file has no libretto header', async () => {
    const file = path.join(root, 'hand-written.spec.ts')
    await writeFile(file, 'test()\n')
    await run([[fakeTest(file, 'a', 'unexpected'), fakeResult()]])
    expect((await ws.readLastRun())?.failures).toEqual({})
  })
})
