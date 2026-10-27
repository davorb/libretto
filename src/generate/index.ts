import { openProject, type CommandOptions, type Project } from '../project/index.js'
import type { SpecId } from '../spec/index.js'
import { generateOne, type SpecGeneration } from './generator.js'

export interface GenerateOptions extends CommandOptions {
  /** Regenerate even fresh specs. */
  readonly force?: boolean
}

export interface GenerateReport {
  readonly written: readonly Extract<SpecGeneration, { status: 'written' }>[]
  readonly fresh: readonly SpecId[]
  readonly failed: readonly Extract<SpecGeneration, { status: 'failed' }>[]
}

/** `libretto generate [spec...]`. */
export async function generate(options: GenerateOptions = {}): Promise<GenerateReport> {
  const project = await openProject(options)
  return generateSpecs(project, project.suite.select(options.specs ?? []).map((s) => s.id), {
    force: options.force ?? false,
    hints: new Map(),
  })
}

/**
 * Package-internal; `fix` calls it after applying proposals.
 *
 * Order: the selected specs plus their fixture chains, topologically, fixtures first,
 * so a dependent's storageState comes from a freshly generated fixture. Sequential
 * (v1). A failed fixture marks its dependents `fixture-not-ready` without spending tokens.
 * Idempotent: a re-run after a crash skips everything already written (it is `fresh`).
 * `force` applies to the selected specs only, never to their fixtures.
 */
export async function generateSpecs(
  project: Project,
  ids: readonly SpecId[],
  opts: { force: boolean; hints: ReadonlyMap<SpecId, string> },
): Promise<GenerateReport> {
  void generateOne
  throw new Error('not implemented')
}
