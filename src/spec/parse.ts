import { parseDocument } from 'yaml'
import type { Scenario, Section, SpecIssue, Step } from './types.js'

/** Output of parsing one file in isolation: `uses` still names, no hash. Never leaves the spec module. */
export interface ParsedSpec {
  readonly title: string
  readonly tags: readonly string[]
  /** Raw names from frontmatter (`logged-in`), not yet resolved to `SpecId`. */
  readonly uses: readonly string[]
  /** 1-based file line of the `uses:` key, for issues raised after parsing. */
  readonly usesLine: number | null
  readonly scenarios: readonly Scenario[]
}

const ENV_REF = /\{\{env\.([A-Z_][A-Z0-9_]*)\}\}/g
const ANY_PLACEHOLDER = /\{\{[^}]*\}\}/g
const HEADING = /^(#{1,6})\s+(.*?)\s*$/
const SECTION_LINE = /^(Steps|Expect):\s*$/
const SECTION_HEADING = /^(Steps|Expect):?$/
const SCENARIO_HEADING = /^Scenario:\s*(.*)$/
const BULLET = /^-(?:\s+(.*))?$/
const FENCE = /^\s*(```|~~~)/

interface Bullet {
  text: string
  line: number
}

interface Draft {
  name: string | null
  line: number
  steps: Bullet[] | null
  expect: Bullet[] | null
}

const SECTION_LABEL: Record<Section, string> = { steps: 'Steps', expect: 'Expect' }

/**
 * Pure: markdown to `ParsedSpec` or issues with line numbers.
 *
 * Grammar (everything else is prose for the agent):
 * - optional YAML frontmatter with `tags: string[]`, `uses: string[]`
 * - `# Title` (required, first heading)
 * - `## Scenario: <name>` (zero headings allowed only for fixtures: one implicit scenario)
 * - within a scenario, a `Steps:` or `Expect:` line (or `### Steps` / `### Expect`)
 *   followed by `- ` bullets. Every scenario in a scenario file needs at least one Expect bullet.
 * - `{{env.NAME}}` anywhere in a bullet. `{{env.lower}}` and other `{{…}}` forms are issues.
 *
 * Structure ends at the next heading of level 1 or 2. Fenced code blocks are always prose.
 * Issues: duplicate scenario names (they become test titles), empty Steps/Expect,
 * malformed placeholders, and frontmatter of the wrong type.
 */
export function parseSpecSource(file: string, source: string, kind: 'scenario' | 'fixture'): ParsedSpec | readonly SpecIssue[] {
  const issues: SpecIssue[] = []
  const issue = (line: number | null, message: string) => void issues.push({ file, line, message })

  const lines = source.replace(/^﻿/, '').split(/\r\n|\r|\n/)

  let bodyStart = 0
  let tags: string[] = []
  let uses: string[] = []
  let usesLine: number | null = null
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'))
    if (end === -1) {
      issue(1, 'Frontmatter is not closed. Add a closing `---` line.')
      return issues
    }
    bodyStart = end + 1
    const fm = readFrontmatter(lines.slice(1, end), issue)
    tags = fm.tags
    uses = fm.uses
    usesLine = fm.usesOffset === null ? null : fm.usesOffset + 2
  }

  const body: { line: number; text: string; fenced: boolean }[] = []
  let fence: string | null = null
  for (let i = bodyStart; i < lines.length; i++) {
    const text = lines[i] ?? ''
    const m = FENCE.exec(text)
    if (fence === null && m) {
      fence = m[1] ?? null
      body.push({ line: i + 1, text, fenced: true })
    } else if (fence !== null) {
      body.push({ line: i + 1, text, fenced: true })
      if (m && m[1] === fence) fence = null
    } else {
      body.push({ line: i + 1, text, fenced: false })
    }
  }

  const hasScenarioHeadings = body.some((b) => {
    const h = !b.fenced ? HEADING.exec(b.text) : null
    return h?.[1]?.length === 2 && SCENARIO_HEADING.test(h[2] ?? '')
  })

  let title: string | null = null
  let titleLine: number | null = null
  let sawHeading = false
  const drafts: Draft[] = []
  let current = null as Draft | null
  const sink: Bullet[] = []
  const sectionLines = new Map<Bullet[], number>()
  let activeBullets = null as Bullet[] | null
  let hasBullet = false

  const startSection = (section: Section, line: number) => {
    activeBullets = null
    hasBullet = false
    if (current === null) {
      if (kind === 'fixture' && !hasScenarioHeadings) {
        current = { name: null, line: titleLine ?? line, steps: null, expect: null }
        drafts.push(current)
      } else {
        issue(line, `\`${SECTION_LABEL[section]}:\` appears outside a \`## Scenario:\` heading, so it is ignored.`)
        activeBullets = sink
        return
      }
    }
    if (current[section] !== null) {
      issue(line, `Duplicate \`${SECTION_LABEL[section]}\` section in scenario "${current.name ?? title ?? ''}".`)
      activeBullets = sink
      return
    }
    const bullets: Bullet[] = []
    current[section] = bullets
    activeBullets = bullets
    sectionLines.set(bullets, line)
  }
  for (const { line, text, fenced } of body) {
    if (fenced) {
      activeBullets = null
      continue
    }
    const h = HEADING.exec(text)
    if (h) {
      const level = h[1]?.length ?? 0
      const headingText = h[2] ?? ''
      activeBullets = null
      if (!sawHeading) {
        sawHeading = true
        if (level !== 1) {
          issue(line, 'The first heading must be a level-1 title (`# Title`).')
          title = ''
        } else {
          title = headingText
          titleLine = line
          if (headingText === '') issue(line, 'The title is empty.')
          continue
        }
      }
      if (level <= 2) {
        current = null
        const sc = level === 2 ? SCENARIO_HEADING.exec(headingText) : null
        if (sc) {
          const name = (sc[1] ?? '').trim()
          if (name === '') issue(line, 'The scenario has no name. Write `## Scenario: <name>`.')
          current = { name, line, steps: null, expect: null }
          drafts.push(current)
        }
      } else if (level === 3) {
        const sh = SECTION_HEADING.exec(headingText)
        if (sh) startSection(sh[1] === 'Steps' ? 'steps' : 'expect', line)
      }
      continue
    }
    const sl = SECTION_LINE.exec(text)
    if (sl) {
      startSection(sl[1] === 'Steps' ? 'steps' : 'expect', line)
      continue
    }
    if (activeBullets === null) continue
    const b = BULLET.exec(text)
    if (b) {
      const bullet = { text: (b[1] ?? '').trim(), line }
      if (bullet.text === '') issue(line, 'Empty bullet.')
      activeBullets.push(bullet)
      hasBullet = true
    } else if (text.trim() === '') {
      continue
    } else if (/^\s/.test(text) && hasBullet) {
      const last = activeBullets[activeBullets.length - 1]
      if (last) last.text = `${last.text} ${text.trim()}`.trim()
    } else {
      activeBullets = null
    }
  }

  if (title === null) issue(null, 'Missing a `# Title` heading.')
  if (kind === 'scenario' && drafts.length === 0) {
    issue(null, 'No `## Scenario: <name>` headings found. A scenario spec needs at least one.')
  }
  if (kind === 'fixture' && drafts.length === 0) issue(titleLine, 'Fixture has no `Steps:` bullets.')

  const seen = new Map<string, number>()
  const scenarios: Scenario[] = []
  for (const d of drafts) {
    const name = d.name ?? title ?? ''
    if (d.name !== null && d.name !== '') {
      const prior = seen.get(name)
      if (prior !== undefined) issue(d.line, `Duplicate scenario name "${name}" (first at line ${prior}). Names become test titles.`)
      else seen.set(name, d.line)
    }
    for (const section of ['steps', 'expect'] as const) {
      const bullets = d[section]
      if (bullets !== null && bullets.length === 0) {
        issue(sectionLines.get(bullets) ?? d.line, `\`${SECTION_LABEL[section]}\` in "${name}" has no \`- \` bullets.`)
      }
    }
    if (kind === 'scenario' && d.expect === null) {
      issue(d.line, `Scenario "${name}" needs an \`Expect:\` section with at least one bullet.`)
    }
    if (kind === 'fixture' && d.steps === null && d.expect === null) {
      issue(d.line, `Fixture scenario "${name}" has no \`Steps:\` bullets.`)
    }
    const toSteps = (section: Section, bullets: Bullet[] | null): Step[] =>
      (bullets ?? []).map((b, i) => ({
        ref: { scenario: name, section, index: i + 1 },
        text: b.text,
        envRefs: [...new Set([...b.text.matchAll(ENV_REF)].map((m) => m[1] as string))],
      }))
    for (const bullets of [d.steps, d.expect]) for (const b of bullets ?? []) checkPlaceholders(b, issue)
    scenarios.push({ name, steps: toSteps('steps', d.steps), expect: toSteps('expect', d.expect) })
  }

  if (issues.length > 0) return issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  return { title: title ?? '', tags, uses, usesLine, scenarios }
}

function checkPlaceholders(b: Bullet, issue: (line: number | null, message: string) => void): void {
  const rest = b.text.replace(ANY_PLACEHOLDER, (p) => {
    if (!new RegExp(`^${ENV_REF.source}$`).test(p)) {
      issue(b.line, `Malformed placeholder ${p}. Use \`{{env.NAME}}\` with an upper-case name.`)
    }
    return ''
  })
  if (rest.includes('{{')) issue(b.line, 'Unterminated `{{` placeholder. Use `{{env.NAME}}`.')
}

function readFrontmatter(
  fmLines: readonly string[],
  issue: (line: number | null, message: string) => void,
): { tags: string[]; uses: string[]; usesOffset: number | null } {
  const empty = { tags: [], uses: [], usesOffset: null }
  const doc = parseDocument(fmLines.join('\n'))
  if (doc.errors.length > 0) {
    for (const e of doc.errors) issue((e.linePos?.[0].line ?? 1) + 1, `Invalid frontmatter YAML: ${e.message.split('\n')[0]}`)
    return empty
  }
  const value: unknown = doc.toJS()
  if (value === null || value === undefined) return empty
  if (typeof value !== 'object' || Array.isArray(value)) {
    issue(2, 'Frontmatter must be a YAML mapping (`tags: [...]`, `uses: [...]`).')
    return empty
  }
  const keyLine = (key: string) => {
    const i = fmLines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l))
    return i === -1 ? null : i
  }
  const stringList = (key: 'tags' | 'uses'): string[] => {
    const v = (value as Record<string, unknown>)[key]
    if (v === undefined || v === null) return []
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[]
    issue((keyLine(key) ?? 0) + 2, `Frontmatter \`${key}\` must be a list of strings, for example \`${key}: [a, b]\`.`)
    return []
  }
  return { tags: stringList('tags'), uses: stringList('uses'), usesOffset: keyLine('uses') }
}
