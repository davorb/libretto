import type { Section, StepRef } from './types.js'

const LABEL: Record<Section, string> = { steps: 'Steps', expect: 'Expect' }
const TITLE = /^(Steps|Expect) ([1-9]\d*): ([\s\S]*)$/

/**
 * The single encoding of a step in generated code: `test.step('Steps 2: Enter username …')`.
 * The renderer writes it and the reporter reads it back. Neither knows the format.
 * The scenario comes from the enclosing `test()` title, which is the scenario name.
 *
 * The prefix is fixed-shape and the bullet text is everything after the first `: `, untouched,
 * so any text round-trips, including text that contains `: ` or looks like another title.
 */
export function stepTitle(section: Section, index: number, text: string): string {
  if (!Number.isInteger(index) || index < 1) throw new RangeError(`step index must be a positive integer, got ${index}`)
  return `${LABEL[section]} ${index}: ${text}`
}

/** Inverse of `stepTitle`. `null` for steps Libretto did not render (Playwright's own hooks, expect polls). */
export function parseStepTitle(scenario: string, title: string): StepRef | null {
  const m = TITLE.exec(title)
  if (!m) return null
  return { scenario, section: m[1] === 'Steps' ? 'steps' : 'expect', index: Number(m[2]) }
}
