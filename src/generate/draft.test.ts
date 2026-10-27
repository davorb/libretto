import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { AppHash, AppSpec, Scenario, Spec, SpecHash, SpecId, Step } from '../spec/index.js'
import { checkDraft, renderTest, type TestDraft } from './draft.js'

const step = (scenario: string, section: 'steps' | 'expect', index: number, text: string, envRefs: string[] = []): Step => ({
  ref: { scenario, section, index },
  text,
  envRefs,
})

const login: Scenario = {
  name: 'valid credentials',
  steps: [
    step('valid credentials', 'steps', 1, 'Open the login page'),
    step('valid credentials', 'steps', 2, 'Enter password {{env.ALICE_PASSWORD}}', ['ALICE_PASSWORD']),
  ],
  expect: [step('valid credentials', 'expect', 1, 'The text "Welcome, "alice"" is visible')],
}

const spec = (over: Partial<Spec> = {}): Spec => ({
  id: 'auth/login' as SpecId,
  kind: 'scenario',
  file: '/x/specs/auth/login.md',
  title: "Login's page",
  tags: [],
  uses: 'fixtures/logged-in' as SpecId,
  scenarios: [login],
  envRefs: ['ALICE_PASSWORD'],
  source: '',
  hash: 'sh' as SpecHash,
  ...over,
})
const app: AppSpec = { file: '/x/specs/app.md', source: '', hash: 'ah' as AppHash }

const good: TestDraft = {
  helpers: 'const heading = (page: any) => page.getByRole("heading")',
  scenarios: [
    {
      name: 'valid credentials',
      steps: ["await page.goto('/login')", "await page.getByLabel('Password').fill(process.env.ALICE_PASSWORD!)"],
      expect: ['await expect(page.getByText(\'Welcome, "alice"\')).toBeVisible()'],
    },
  ],
}
const with1 = (patch: Partial<TestDraft['scenarios'][number]>, helpers = ''): TestDraft => ({
  helpers,
  scenarios: [{ ...good.scenarios[0]!, ...patch }],
})

describe('checkDraft', () => {
  it('accepts a correct draft', () => {
    expect(checkDraft(spec(), good)).toEqual([])
  })

  it('reports scenario name mismatch', () => {
    const p = checkDraft(spec(), with1({ name: 'other' }))
    expect(p.join('\n')).toMatch(/Scenarios must match.*valid credentials.*other/)
  })

  it('reports bullet count mismatches naming the scenario', () => {
    const p = checkDraft(spec(), with1({ steps: ['await page.goto("/")'], expect: [] }))
    expect(p).toHaveLength(2)
    expect(p[0]).toContain('"valid credentials"')
    expect(p[0]).toMatch(/steps.*Steps bullet \(2\), got 1/)
    expect(p[1]).toMatch(/expect.*Expect bullet \(1\), got 0/)
  })

  it('reports missing and extra env names', () => {
    const p = checkDraft(spec(), with1({ steps: ["await page.goto('/')", "await page.fill('x', process.env.OTHER!)"] }))
    expect(p.some((m) => m.includes('Steps 2') && m.includes('process.env.ALICE_PASSWORD'))).toBe(true)
    expect(p.some((m) => m.includes('Steps 2') && m.includes('process.env.OTHER is not referenced'))).toBe(true)
  })

  it('reports import, require, test(), and absolute goto', () => {
    const p = checkDraft(
      spec(),
      with1(
        {
          steps: [
            "import { x } from 'y'\nawait page.goto('https://example.com/login')",
            "const a = require('a'); process.env.ALICE_PASSWORD",
          ],
          expect: ["test.describe('x', () => {})"],
        },
        "import fs from 'fs'",
      ),
    )
    const all = p.join('\n')
    expect(all).toMatch(/helpers: remove import/)
    expect(all).toMatch(/Steps 1: remove import/)
    expect(all).toMatch(/Steps 1: page\.goto must use a path/)
    expect(all).toMatch(/Steps 2: remove import\/require/)
    expect(all).toMatch(/Expect 1: remove test/)
  })

  it('does not flag test-like words inside identifiers', () => {
    const p = checkDraft(spec(), with1({ expect: ['await expect(latest(page)).toBeVisible()'] }))
    expect(p).toEqual([])
  })
})

const parses = (body: string) => {
  const sf = ts.createSourceFile('t.spec.ts', body, ts.ScriptTarget.ES2022, true)
  return (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics
}

describe('renderTest', () => {
  it('renders a scenario with a uses chain', () => {
    const r = renderTest(spec(), app, good, { storageStateIn: '/x/.libretto/state/fixtures/logged-in.json', storageStateOut: null })
    expect(r).toMatchObject({ spec: 'auth/login', specHash: 'sh', appHash: 'ah' })
    expect(r.body).toBe(`import { test, expect } from 'libretto/test'
test.use({ storageState: "/x/.libretto/state/fixtures/logged-in.json" })

const heading = (page: any) => page.getByRole("heading")

test.describe("Login's page", () => {
  test("valid credentials", async ({ page }) => {
    await test.step("Steps 1: Open the login page", async () => {
      await page.goto('/login')
    })
    await test.step("Steps 2: Enter password {{env.ALICE_PASSWORD}}", async () => {
      await page.getByLabel('Password').fill(process.env.ALICE_PASSWORD!)
    })
    await test.step("Expect 1: The text \\"Welcome, \\"alice\\"\\" is visible", async () => {
      await expect(page.getByText('Welcome, "alice"')).toBeVisible()
    })
  })
})
`)
    expect(r.body).toContain('process.env.ALICE_PASSWORD')
    expect(parses(r.body)).toEqual([])
  })

  it('omits test.use without a storage state and indents multiline code', () => {
    const d = with1({ steps: ["await a()\nawait b()", "process.env.ALICE_PASSWORD"] })
    const r = renderTest(spec({ uses: null }), app, d, { storageStateIn: null, storageStateOut: null })
    expect(r.body).not.toContain('test.use')
    expect(r.body).toContain('      await a()\n      await b()\n')
    expect(parses(r.body)).toEqual([])
  })

  it('renders a fixture that saves storage state last', () => {
    const fx = spec({ id: 'fixtures/logged-in' as SpecId, kind: 'fixture', uses: null, title: 'Logged in' })
    const r = renderTest(fx, app, good, { storageStateIn: null, storageStateOut: '/x/.libretto/state/fixtures/logged-in.json' })
    const lines = r.body.trimEnd().split('\n')
    expect(lines.slice(-3)).toEqual([
      '    await page.context().storageState({ path: "/x/.libretto/state/fixtures/logged-in.json" })',
      '  })',
      '})',
    ])
    expect(parses(r.body)).toEqual([])
  })
})
