import { inspect } from 'node:util'

/** Assigned by the static block below. Declared first so the class body can reference it. */
let readValues: (s: Secrets) => Record<string, string>

/** Values shorter than this are not redacted: they would match everywhere. `fromEnv` warns about them. */
const MIN_REDACTABLE = 4

/**
 * Values for `{{env.NAME}}` placeholders, sealed so they can't reach a prompt, a log,
 * a transcript, or git.
 *
 * Invariants:
 * - Values live in a `#private` field. `toString`, `toJSON`, and `util.inspect` print
 *   names only, so a template literal or `JSON.stringify` of a task leaks nothing.
 * - The only reader is `unseal()` below, which `agent/index.ts` does not export.
 *   Its only caller is `playwright-mcp.ts`, which writes the values to the MCP child's
 *   secrets file.
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
   * `short` lists names whose values are too short to redact; callers warn about them.
   */
  static fromEnv(names: Iterable<string>, env: NodeJS.ProcessEnv): { secrets: Secrets; short: readonly string[] } {
    const values = new Map<string, string>()
    const missing: string[] = []
    const short: string[] = []
    for (const name of new Set(names)) {
      const value = env[name]
      if (value === undefined || value === '') {
        missing.push(name)
        continue
      }
      if (value.length < MIN_REDACTABLE) short.push(name)
      values.set(name, value)
    }
    if (missing.length > 0) throw new MissingSecretsError(missing.sort())
    return { secrets: new Secrets(values), short }
  }

  get names(): readonly string[] {
    return [...this.#values.keys()].sort()
  }

  /**
   * Returns the name of the first secret whose value appears in `text`, or null.
   * Used by `write_test.accept` as a belt-and-braces check: the agent never saw the
   * values, but a draft must never contain one.
   */
  findLeak(text: string): string | null {
    for (const [name, value] of this.#values) {
      if (value.length >= MIN_REDACTABLE && text.includes(value)) return name
    }
    return null
  }

  /**
   * Replaces every occurrence of a value with its `{{env.NAME}}` placeholder. The
   * harness passes every event and every tool reply through this before anything
   * leaves the session, so a value that surfaces in a DOM snapshot or an error message
   * never reaches a log or a transcript. Values shorter than `MIN_REDACTABLE` are
   * left alone (they would match everywhere); `fromEnv` reports those as `short`.
   */
  redact(text: string): string {
    let out = text
    for (const [name, value] of this.#values) {
      if (value.length >= MIN_REDACTABLE) out = out.replaceAll(value, `{{env.${name}}}`)
    }
    return out
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
