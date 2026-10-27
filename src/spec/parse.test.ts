import { describe, expect, it } from 'vitest'
import { parseSpecSource, type ParsedSpec } from './parse.js'
import type { SpecIssue } from './types.js'

const ok = (source: string, kind: 'scenario' | 'fixture' = 'scenario'): ParsedSpec => {
  const r = parseSpecSource('a.md', source, kind)
  if (!('scenarios' in r)) throw new Error(`unexpected issues: ${JSON.stringify(r)}`)
  return r
}
const issues = (source: string, kind: 'scenario' | 'fixture' = 'scenario'): readonly SpecIssue[] => {
  const r = parseSpecSource('a.md', source, kind)
  if ('scenarios' in r) throw new Error('expected issues')
  return r
}

const LOGIN = `---
tags: [smoke]
uses: [logged-in]
---
# Login

Some prose about login. Steps: are not structural here.

## Scenario: valid credentials
Steps:
- Open the login page
- Enter username \`alice\` and password {{env.ALICE_PASSWORD}}
- Click "Log in"

Expect:
- The text "Welcome, alice" is visible
`

describe('parseSpecSource', () => {
  it('parses frontmatter, title, scenario, steps and expects with refs and env refs', () => {
    const p = ok(LOGIN)
    expect(p.title).toBe('Login')
    expect(p.tags).toEqual(['smoke'])
    expect(p.uses).toEqual(['logged-in'])
    expect(p.usesLine).toBe(3)
    expect(p.scenarios).toHaveLength(1)
    const [s] = p.scenarios
    expect(s?.name).toBe('valid credentials')
    expect(s?.steps.map((x) => x.text)).toEqual([
      'Open the login page',
      'Enter username `alice` and password {{env.ALICE_PASSWORD}}',
      'Click "Log in"',
    ])
    expect(s?.steps[1]).toEqual({
      ref: { scenario: 'valid credentials', section: 'steps', index: 2 },
      text: 'Enter username `alice` and password {{env.ALICE_PASSWORD}}',
      envRefs: ['ALICE_PASSWORD'],
    })
    expect(s?.expect[0]?.ref).toEqual({ scenario: 'valid credentials', section: 'expect', index: 1 })
  })

  it('dedupes env refs within a bullet and accepts heading-style sections', () => {
    const p = ok('# T\n## Scenario: s\n### Steps\n- type {{env.A_1}} then {{env.A_1}} and {{env.B}}\n### Expect\n- done\n')
    expect(p.scenarios[0]?.steps[0]?.envRefs).toEqual(['A_1', 'B'])
    expect(p.scenarios[0]?.expect).toHaveLength(1)
  })

  it('works without frontmatter and handles CRLF', () => {
    const p = ok('# T\r\n## Scenario: s\r\nSteps:\r\n- one\r\nExpect:\r\n- two\r\n')
    expect(p.tags).toEqual([])
    expect(p.uses).toEqual([])
    expect(p.scenarios[0]?.steps[0]?.text).toBe('one')
  })

  it('ignores structure inside code fences', () => {
    const p = ok('# T\n## Scenario: s\nSteps:\n- a\nExpect:\n- b\n```\nSteps:\n- fenced\n```\n## Notes\nplain bullets:\n- not a step\n')
    expect(p.scenarios[0]?.steps.map((x) => x.text)).toEqual(['a'])
  })

  it('ends a scenario at the next H2, so a later Steps line is reported, not silently attached', () => {
    const r = issues('# T\n## Scenario: s\nSteps:\n- a\nExpect:\n- b\n## Notes\nSteps:\n- c\n')
    expect(r).toEqual([expect.objectContaining({ line: 8, message: expect.stringMatching(/outside a `## Scenario:`/) })])
  })

  it('joins indented continuation lines onto the bullet', () => {
    const p = ok('# T\n## Scenario: s\nSteps:\n- a long\n  second line\nExpect:\n- b\n')
    expect(p.scenarios[0]?.steps[0]?.text).toBe('a long second line')
  })

  it('gives a fixture without scenario headings one implicit scenario named by the title', () => {
    const p = ok('# Logged in\nSteps:\n- Open /login\n- Sign in\n', 'fixture')
    expect(p.scenarios.map((s) => s.name)).toEqual(['Logged in'])
    expect(p.scenarios[0]?.steps[1]?.ref).toEqual({ scenario: 'Logged in', section: 'steps', index: 2 })
    expect(p.scenarios[0]?.expect).toEqual([])
  })

  it('reports issues with file and line instead of stopping at the first', () => {
    const r = issues(
      [
        '# T', // 1
        '## Scenario: dup', // 2
        'Steps:', // 3
        '- ok {{env.lower}}', // 4
        '- {{nope}}', // 5
        'Expect:', // 6
        '## Scenario: dup', // 7
        'Steps:', // 8
        '- x', // 9
      ].join('\n'),
    )
    expect(r.every((i) => i.file === 'a.md')).toBe(true)
    const at = (line: number) => r.filter((i) => i.line === line).map((i) => i.message)
    expect(at(4)[0]).toMatch(/Malformed placeholder \{\{env\.lower\}\}/)
    expect(at(5)[0]).toMatch(/Malformed placeholder \{\{nope\}\}/)
    expect(at(6)[0]).toMatch(/no `- ` bullets/)
    expect(at(7)[0]).toMatch(/Duplicate scenario name "dup" \(first at line 2\)/)
    expect(at(7).join()).toMatch(/needs an `Expect:`/)
  })

  it('flags missing title, wrong first heading, and no scenarios', () => {
    expect(issues('just prose\n').map((i) => i.message).join('\n')).toMatch(/Missing a `# Title`/)
    expect(issues('## Scenario: s\nSteps:\n- a\nExpect:\n- b\n').some((i) => i.line === 1 && /level-1/.test(i.message))).toBe(true)
    expect(issues('# T\nprose only\n').map((i) => i.message).join()).toMatch(/No `## Scenario:/)
  })

  it('flags steps outside a scenario, duplicate sections, empty bullets, unterminated placeholders', () => {
    const r = issues('# T\nSteps:\n- a\n## Scenario: s\nSteps:\n- a {{env.X\nSteps:\n- again\n-\nExpect:\n- e\n')
    const msgs = r.map((i) => `${i.line}:${i.message}`)
    expect(msgs.some((m) => m.startsWith('2:') && /outside a `## Scenario:`/.test(m))).toBe(true)
    expect(msgs.some((m) => m.startsWith('6:') && /Unterminated/.test(m))).toBe(true)
    expect(msgs.some((m) => m.startsWith('7:') && /Duplicate `Steps`/.test(m))).toBe(true)
    expect(msgs.some((m) => m.startsWith('9:') && /Empty bullet/.test(m))).toBe(true)
  })

  it('flags frontmatter problems with lines', () => {
    expect(issues('---\ntags: smoke\n---\n# T\n## Scenario: s\nSteps:\n- a\nExpect:\n- b\n')[0]).toMatchObject({ line: 2 })
    expect(issues('---\nx: [\n---\n# T\n', 'fixture').map((i) => i.message).join()).toMatch(/Invalid frontmatter YAML/)
    expect(issues('---\ntags: [a]\n# T\n')[0]).toMatchObject({ line: 1, message: expect.stringMatching(/not closed/) })
    expect(issues('---\n- a\n---\n# T\n').map((i) => i.message).join()).toMatch(/mapping/)
  })

  it('does not require Expect in fixtures but requires some steps', () => {
    expect(() => ok('# F\nSteps:\n- a\n', 'fixture')).not.toThrow()
    expect(issues('# F\nprose only\n', 'fixture')[0]?.message).toMatch(/no `Steps:`/)
  })
})
