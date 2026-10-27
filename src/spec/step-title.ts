import type { Section, StepRef } from './types.js'

/**
 * The single encoding of a step in generated code: `test.step('Steps 2: Enter username …')`.
 * The renderer writes it and the reporter reads it back. Neither knows the format.
 * The scenario comes from the enclosing `test()` title, which is the scenario name.
 */
export function stepTitle(section: Section, index: number, text: string): string {
  throw new Error('not implemented')
}

/** Inverse of `stepTitle`. `null` for steps Libretto did not render (Playwright's own hooks, expect polls). */
export function parseStepTitle(scenario: string, title: string): StepRef | null {
  throw new Error('not implemented')
}
