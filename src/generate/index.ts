import { openProject, type CommandOptions, type Project } from '../project/index.js'
import type { Spec, SpecId } from '../spec/index.js'
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
  const selected = new Set(ids)
  const order: Spec[] = []
  const seen = new Set<SpecId>()
  for (const id of ids) {
    const spec = project.suite.specs.get(id)
    if (!spec) throw new Error(`Unknown spec ${id}`)
    for (const s of [...project.suite.fixtureChain(spec), spec]) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      order.push(s)
    }
  }

  const written: Extract<SpecGeneration, { status: 'written' }>[] = []
  const fresh: SpecId[] = []
  const failed: Extract<SpecGeneration, { status: 'failed' }>[] = []
  const broken = new Set<SpecId>()

  for (const spec of order) {
    const brokenFixture = project.suite.fixtureChain(spec).find((f) => broken.has(f.id))
    const result: SpecGeneration = brokenFixture
      ? { status: 'failed', spec: spec.id, reason: 'fixture-not-ready', detail: `Fixture ${brokenFixture.id} failed to generate.` }
      : await generateOne(project, spec, { force: opts.force && selected.has(spec.id), hint: opts.hints.get(spec.id) ?? null })
    switch (result.status) {
      case 'written':
        written.push(result)
        break
      case 'fresh':
        fresh.push(result.spec)
        break
      case 'failed':
        failed.push(result)
        broken.add(spec.id)
        break
    }
  }
  return { written, fresh, failed }
}
