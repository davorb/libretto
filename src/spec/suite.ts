import type { Suite } from './types.js'
import { parseSpecSource } from './parse.js'

/**
 * Reads `specsDir`, parses every `.md`, and returns a validated `Suite` or throws one
 * `SpecError` carrying every issue.
 *
 * Steps (pure after the read):
 * 1. glob `**\/*.md`. `app.md` is the AppSpec (missing → issue). `fixtures/**` are fixtures.
 * 2. `parseSpecSource` each, collecting issues.
 * 3. resolve `uses: [name]` → `fixtures/<name>`. Unknown name → issue. More than one
 *    entry → issue ("compose by making one fixture use the other"). A scenario can't be
 *    used, only a fixture.
 * 4. cycle check by DFS over `uses`. The issue names the full cycle `a → b → a`
 *    (SPEC: cycles rejected at parse time).
 * 5. hash in topological order: `sha256(normalize(source) + '\0' + (uses ? hash(uses) : ''))`.
 *    `normalize` = LF line endings, trimmed trailing whitespace, so editor noise does not mark a spec stale.
 */
export async function loadSuite(specsDir: string): Promise<Suite> {
  void parseSpecSource
  throw new Error('not implemented')
}
