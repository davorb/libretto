/** `auth/login`: posix path relative to the specs dir, no `.md`. Fixtures are `fixtures/<name>`. */
export type SpecId = string & { readonly __brand: 'SpecId' }

/** Merkle hash: sha256 of the spec's normalized source plus the hashes of its direct `uses`, in order. */
export type SpecHash = string & { readonly __brand: 'SpecHash' }

export type Section = 'steps' | 'expect'

/** Address of one bullet. Shared by the renderer (test.step titles) and the reporter (failure → step). */
export interface StepRef {
  readonly scenario: string
  readonly section: Section
  /** 1-based, as shown to humans. */
  readonly index: number
}

export interface Step {
  readonly ref: StepRef
  /** Bullet text verbatim, placeholders intact: `Enter … password {{env.ALICE_PASSWORD}}`. */
  readonly text: string
  /** Env names referenced by this bullet. */
  readonly envRefs: readonly string[]
}

export interface Scenario {
  readonly name: string
  readonly steps: readonly Step[]
  readonly expect: readonly Step[]
}

/**
 * A validated spec. Only `loadSuite` constructs one, so holding a `Spec` means its
 * `uses` resolved, the graph is acyclic, and `hash` is current.
 */
export interface Spec {
  readonly id: SpecId
  /** Fixtures live under `specs/fixtures/` and become Playwright setup projects. */
  readonly kind: 'scenario' | 'fixture'
  /** Absolute path of the markdown file. */
  readonly file: string
  readonly title: string
  readonly tags: readonly string[]
  /** Direct fixture dependency. At most one (compose by chaining). */
  readonly uses: SpecId | null
  /** A fixture file without `## Scenario:` headings has one implicit scenario named by its title. */
  readonly scenarios: readonly Scenario[]
  /** Union of the steps' `envRefs`, deduped and sorted. */
  readonly envRefs: readonly string[]
  readonly source: string
  readonly hash: SpecHash
}

/**
 * `specs/app.md`: fed verbatim to every agent task. Its hash is stamped on every
 * generated file separately from the spec hash, so an edit marks the suite
 * `app-changed` (see `Staleness`) and the reason is visible, not folded into `SpecHash`.
 */
export interface AppSpec {
  readonly file: string
  readonly source: string
  /** sha256 of the normalized source. */
  readonly hash: AppHash
}

export type AppHash = string & { readonly __brand: 'AppHash' }

export interface SpecIssue {
  readonly file: string
  readonly line: number | null
  readonly message: string
}

/** Every issue in the suite, reported together. */
export class SpecError extends Error {
  override readonly name = 'SpecError'
  constructor(readonly issues: readonly SpecIssue[]) {
    super(issues.map((i) => `${i.file}${i.line ? `:${i.line}` : ''}: ${i.message}`).join('\n'))
  }
}

export interface Suite {
  readonly app: AppSpec
  readonly specs: ReadonlyMap<SpecId, Spec>
  /**
   * Resolves CLI-style selectors (`auth/login`, `specs/auth/login.md`, `auth`, or none
   * for all) to specs. Throws `SpecError` naming any selector that matched nothing.
   */
  select(selectors: readonly string[]): readonly Spec[]
  /** The spec's fixture chain, outermost first (`[fixtures/base, fixtures/logged-in]`). Excludes the spec itself. */
  fixtureChain(spec: Spec): readonly Spec[]
  /**
   * The suite as it would be with `id`'s markdown replaced. Returns issues instead of
   * throwing, so `propose_spec_edit.accept` can return them to the agent. This is the
   * only way to get a `Spec` for edited markdown.
   */
  withEdit(id: SpecId, markdown: string): Suite | readonly SpecIssue[]
}
