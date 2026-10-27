import { inspect } from 'node:util'

/** Assigned by the static block below. Declared first so the class body can reference it. */
let readValues: (s: Secrets) => Record<string, string>

/**
 * Values for `{{env.NAME}}` placeholders, sealed so they can't reach a prompt, a log,
 * a transcript, or git.
 *
 * Invariants:
 * - Values live in a `#private` field. `toString`, `toJSON`, and `util.inspect` print
 *   names only, so a template literal or `JSON.stringify` of a task leaks nothing.
 * - The only reader is `unseal()` below, which `agent/index.ts` does not export.
 *   Its only caller is `playwright-mcp.ts`, which puts the values in the MCP child's env.
 */
export class Secrets {
  readonly #values: ReadonlyMap<string, string>

  private constructor(values: ReadonlyMap<string, string>) {
    this.#values = values
  }

  static readonly none: Secrets = new Secrets(new Map())

  /**
   * Seals exactly the names a spec references. Throws `MissingSecretsError` listing
   * every unset name, so the user fixes them in one pass instead of one per run.
   */
  static fromEnv(names: Iterable<string>, env: NodeJS.ProcessEnv): Secrets {
    // TODO: collect missing names; throw MissingSecretsError(missing) if any; else seal.
    throw new Error('not implemented')
  }

  get names(): readonly string[] {
    return [...this.#values.keys()]
  }

  /**
   * Returns the name of the first secret whose value appears in `text`, or null.
   * Used by `write_test.accept` as a belt-and-braces check: the agent never saw the
   * values, but a draft must never contain one.
   */
  findLeak(text: string): string | null {
    throw new Error('not implemented')
  }

  /**
   * Replaces every occurrence of a value with its `{{env.NAME}}` placeholder. The
   * harness passes every event and every tool reply through this before anything
   * leaves the session, so a value that surfaces in a DOM snapshot or an error message
   * never reaches a log or a transcript. Values of fewer than 4 chars are not
   * redacted (they would match everywhere); `fromEnv` warns about those.
   */
  redact(text: string): string {
    throw new Error('not implemented')
  }

  toString(): string {
    return `Secrets(${this.names.join(', ')})`
  }

  toJSON(): { names: readonly string[] } {
    return { names: this.names }
  }

  [inspect.custom](): string {
    return this.toString()
  }

  // A static block can read `#values`; the class itself exposes no reader.
  static {
    readValues = (s) => Object.fromEntries(s.#values)
  }
}

/** Package-internal. Not re-exported from `agent/index.ts`. Only `playwright-mcp.ts` calls it. */
export function unseal(secrets: Secrets): Record<string, string> {
  return readValues(secrets)
}

export class MissingSecretsError extends Error {
  override readonly name = 'MissingSecretsError'
  constructor(readonly missing: readonly string[]) {
    super(`Missing environment variables referenced by specs: ${missing.join(', ')}`)
  }
}
