import type { Scenario, SpecIssue } from './types.js'

/** Output of parsing one file in isolation: `uses` still names, no hash. Never leaves the spec module. */
export interface ParsedSpec {
  readonly title: string
  readonly tags: readonly string[]
  /** Raw names from frontmatter (`logged-in`), not yet resolved to `SpecId`. */
  readonly uses: readonly string[]
  readonly scenarios: readonly Scenario[]
}

const ENV_REF = /\{\{env\.([A-Z_][A-Z0-9_]*)\}\}/g

/**
 * Pure: markdown to `ParsedSpec` or issues with line numbers.
 *
 * Grammar (everything else is prose for the agent):
 * - optional YAML frontmatter with `tags: string[]`, `uses: string[]`
 * - `# Title` (required, first heading)
 * - `## Scenario: <name>` (zero headings allowed only for fixtures: one implicit scenario)
 * - within a scenario, a `Steps:` or `Expect:` line (or `### Steps` / `### Expect`)
 *   followed by `- ` bullets. Every scenario needs at least one Expect bullet.
 * - `{{env.NAME}}` anywhere in a bullet. `{{env.lower}}` and other `{{…}}` forms are issues.
 *
 * Issues: duplicate scenario names (they become test titles), empty Steps/Expect,
 * malformed placeholders, and frontmatter of the wrong type.
 */
export function parseSpecSource(file: string, source: string, kind: 'scenario' | 'fixture'): ParsedSpec | readonly SpecIssue[] {
  void ENV_REF
  throw new Error('not implemented')
}
