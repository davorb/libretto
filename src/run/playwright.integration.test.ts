import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunContext } from '../project/index.js'
import type { AppHash, Spec, SpecHash, SpecId } from '../spec/index.js'
import { openWorkspace, type FailureId } from '../workspace/index.js'
import { renderHeader } from '../workspace/header.js'
import { loadSuite } from '../spec/index.js'
import { run } from './index.js'
import { runDraft, spawnPlaywright, writeWrapperConfig } from './playwright.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const staleBuild = () =>
  ['run/reporter', 'run/playwright', 'test/index'].some((m) => {
    const out = path.join(repo, 'dist', `${m}.js`)
    return !existsSync(out) || statSync(out).mtimeMs < statSync(path.join(repo, 'src', `${m}.ts`)).mtimeMs
  })

// SPAWNS PLAYWRIGHT AND CHROMIUM. The wrapper loads the built reporter and `libretto/test` from dist/, so this builds first when dist is stale.
describe('spawns Playwright: wrapper config, reporter, and libretto/test end to end', () => {
  let root: string
  beforeAll(async () => {
    if (staleBuild()) {
      try {
        execFileSync('pnpm', ['build'], { cwd: repo, stdio: 'pipe' })
      } catch {
        // tsc still emits when another module has type errors; the check below decides.
      }
    }
    if (staleBuild()) throw new Error('dist/ is stale and `pnpm build` did not refresh it')
    root = await mkdtemp(path.join(os.tmpdir(), 'libretto-it-'))
  }, 120_000)
  afterAll(() => rm(root, { recursive: true, force: true }))

  it('records a failing step with a trace and a DOM snapshot in last-run.json', async () => {
    const workspace = openWorkspace(root, path.join(root, 'specs'))
    const id = 'auth/login' as SpecId
    const body = `import { test, expect } from 'libretto/test'

test('valid credentials', async ({ page }) => {
  await test.step('Steps 1: Open the page', async () => {
    await page.setContent('<h1>Hello</h1>')
  })
  await test.step('Expect 1: Numbers match', async () => {
    expect(1).toBe(2)
  })
})
`
    const file = workspace.generatedFile(id)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, renderHeader(id, 'specs/auth/login.md', 'sh' as SpecHash, 'ah' as AppHash, body))
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}')

    const ctx = {
      config: { root, baseURL: 'http://localhost:1', specsDir: workspace.specsDir, playwrightConfig: null },
      workspace,
      log: { info() {}, warn() {}, error() {}, agent() {} },
      signal: undefined,
      suite: {},
    } as unknown as RunContext
    const spec = { id, kind: 'scenario', uses: null } as Spec
    const wrapper = await writeWrapperConfig(ctx, { kind: 'suite', specs: [spec] })
    const code = await spawnPlaywright(ctx, wrapper, [file], [])

    expect(code).toBe(1)
    const record = await workspace.readLastRun()
    const failures = Object.values(record?.failures ?? {})
    expect(failures).toHaveLength(1)
    const failure = failures[0]!
    expect(failure.id).toBe('auth/login::scenarios::valid credentials' as FailureId)
    expect(failure.step).toEqual({ scenario: 'valid credentials', section: 'expect', index: 1 })
    expect(failure.error.message).toContain('toBe')
    expect(existsSync(failure.artifacts.trace!)).toBe(true)
    expect(JSON.parse(await readFile(failure.artifacts.domSnapshot!, 'utf8')).html).toContain('<h1>Hello</h1>')
    expect(failure.artifacts.screenshots.length).toBeLessThanOrEqual(1)
  }, 60_000)

  it('runDraft reports a pass, and a failure with scenario, step, and error', async () => {
    const workspace = openWorkspace(root, path.join(root, 'specs'))
    const ctx = {
      config: { root, baseURL: 'http://localhost:1', specsDir: workspace.specsDir, playwrightConfig: null },
      workspace,
      log: { info() {}, warn() {}, error() {}, agent() {} },
      signal: undefined,
      suite: {},
    } as unknown as RunContext
    const draft = (assertion: string) => ({
      spec: 'drafty/one' as SpecId,
      specHash: 'sh' as SpecHash,
      appHash: 'ah' as AppHash,
      body: `import { test, expect } from 'libretto/test'
test('draft scenario', async ({ page }) => {
  await test.step('Steps 1: Do it', async () => {
    await page.setContent('<h1>Hi</h1>')
    ${assertion}
  })
})
`,
    })
    expect(await runDraft(ctx, draft("await expect(page.locator('h1')).toHaveText('Hi')"), 'specs/drafty/one.md', null)).toEqual({ passed: true })

    const failed = await runDraft(ctx, draft('expect(1).toBe(2)'), 'specs/drafty/one.md', null)
    if (failed.passed) throw new Error('expected the draft to fail')
    expect(failed.failure.scenario).toBe('draft scenario')
    expect(failed.failure.step).toEqual({ scenario: 'draft scenario', section: 'steps', index: 1 })
    expect(failed.failure.error.message).toContain('Expected: 2')
    expect(failed.output).toContain('1 failed')
    expect(existsSync(path.join(root, '.libretto/last-run.json'))).toBe(true)
  }, 60_000)

  it('run() executes a fixture chain before its scenario and reports the failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'libretto-run-it-'))
    try {
      const files: Record<string, string> = {
        'libretto.config.mjs': "export default { baseURL: 'http://localhost:1', agent: { backend: 'claude', model: 'm' } }",
        'package.json': '{"type":"module"}',
        'specs/app.md': '# App\n',
        'specs/fixtures/base.md': '# Base\nSteps:\n- set up\n',
        'specs/auth/login.md': '---\nuses: [base]\n---\n# Login\n## Scenario: bad password\nSteps:\n- go\nExpect:\n- ok\n',
      }
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
        await writeFile(path.join(dir, rel), content)
      }
      const suite = await loadSuite(path.join(dir, 'specs'))
      const workspace = openWorkspace(dir, path.join(dir, 'specs'))
      const render = (id: string, body: string) => ({ spec: id as SpecId, specHash: suite.specs.get(id as SpecId)!.hash, appHash: suite.app.hash, body })
      const statePath = workspace.stateFile('fixtures/base' as SpecId)
      await workspace.writeGenerated(
        render('fixtures/base', `import { test } from 'libretto/test'
test('Base', async ({ page }) => {
  await test.step('Steps 1: set up', async () => {
    await page.context().storageState({ path: ${JSON.stringify(statePath)} })
  })
})
`),
        'specs/fixtures/base.md',
      )
      await workspace.writeGenerated(
        render('auth/login', `import { test, expect } from 'libretto/test'
test('bad password', async ({ page }) => {
  await test.step('Steps 1: go', async () => {
    await page.setContent('<p>x</p>')
  })
  await test.step('Expect 1: ok', async () => {
    expect(1).toBe(2)
  })
})
`),
        'specs/auth/login.md',
      )
      const warnings: string[] = []
      const report = await run({ cwd: dir, specs: ['auth/login'], log: { info() {}, warn: (m) => void warnings.push(m), error() {}, agent() {} } })
      expect(report.exitCode).toBe(1)
      expect(report.passed).toBe(1)
      expect(report.failures).toHaveLength(1)
      expect(report.failures[0]).toMatchObject({ id: 'auth/login::scenarios:fixtures/base::bad password', step: { section: 'expect', index: 1 } })
      expect(report.staleWarnings).toEqual([])
      expect(existsSync(statePath)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
