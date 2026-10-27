import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseSpecSource, type ParsedSpec } from './parse.js'
import { SpecError } from './types.js'
import type { AppHash, AppSpec, Spec, SpecHash, SpecId, SpecIssue, Suite } from './types.js'

interface SourceFile {
  readonly file: string
  readonly source: string
}

/**
 * Reads `specsDir`, parses every `.md`, and returns a validated `Suite` or throws one
 * `SpecError` carrying every issue.
 *
 * 1. walk `**\/*.md`. `app.md` is the AppSpec (missing → issue). `fixtures/**` are fixtures.
 * 2. `parseSpecSource` each, collecting issues.
 * 3. resolve `uses: [name]` → `fixtures/<name>`. Unknown name → issue. More than one
 *    entry → issue ("compose by making one fixture use the other"). A scenario can't be
 *    used, only a fixture.
 * 4. cycle check over `uses`. The issue names the full cycle `a → b → a`.
 * 5. hash in topological order: `sha256(normalize(source) + '\0' + (uses ? hash(uses) : ''))`.
 *    `normalize` = LF line endings, trimmed trailing whitespace, so editor noise does not mark a spec stale.
 */
export async function loadSuite(specsDir: string): Promise<Suite> {
  const root = path.resolve(specsDir)
  let paths: string[]
  try {
    paths = await walkMarkdown(root)
  } catch {
    throw new SpecError([{ file: root, line: null, message: 'Specs directory not found or unreadable.' }])
  }
  const files = new Map<SpecId, SourceFile>()
  let app: AppSpec | null = null
  for (const file of paths) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    const source = await readFile(file, 'utf8')
    if (rel === 'app.md') app = { file, source, hash: sha256(normalize(source)) as AppHash }
    else files.set(rel.slice(0, -'.md'.length) as SpecId, { file, source })
  }
  if (app === null) {
    throw new SpecError([{ file: path.join(root, 'app.md'), line: null, message: 'Missing app.md. It describes the app for every agent task.' }])
  }
  const built = buildSuite(root, app, files)
  if (built instanceof SuiteImpl) return built
  throw new SpecError(built)
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkMarkdown(full)))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out.sort()
}

function normalize(source: string): string {
  return source
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trimEnd())
    .join('\n')
    .trimEnd()
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const FIXTURE_PREFIX = 'fixtures/'

function buildSuite(specsDir: string, app: AppSpec, files: ReadonlyMap<SpecId, SourceFile>): SuiteImpl | readonly SpecIssue[] {
  const issues: SpecIssue[] = []
  const ids = [...files.keys()].sort()
  const parsed = new Map<SpecId, ParsedSpec>()
  for (const id of ids) {
    const { file, source } = files.get(id) as SourceFile
    const kind = id.startsWith(FIXTURE_PREFIX) ? 'fixture' : 'scenario'
    const result = parseSpecSource(file, source, kind)
    if ('scenarios' in result) parsed.set(id, result)
    else issues.push(...result)
  }

  const edges = new Map<SpecId, SpecId>()
  for (const id of ids) {
    const p = parsed.get(id)
    if (!p || p.uses.length === 0) continue
    const file = (files.get(id) as SourceFile).file
    const issue = (message: string) => void issues.push({ file, line: p.usesLine, message })
    if (p.uses.length > 1) {
      issue(`\`uses\` lists ${p.uses.length} fixtures (${p.uses.join(', ')}). Use one, and compose by making one fixture use the other.`)
      continue
    }
    const name = (p.uses[0] as string).trim()
    const target = `${FIXTURE_PREFIX}${name}` as SpecId
    if (files.has(target)) edges.set(id, target)
    else if (files.has(name as SpecId)) issue(`\`uses: [${name}]\` names a scenario spec. Only fixtures under fixtures/ can be used.`)
    else {
      const known = ids.filter((i) => i.startsWith(FIXTURE_PREFIX)).map((i) => i.slice(FIXTURE_PREFIX.length))
      const hint = name.startsWith(FIXTURE_PREFIX) ? ` Drop the \`${FIXTURE_PREFIX}\` prefix.` : ''
      issue(`Unknown fixture "${name}".${hint} Known fixtures: ${known.length > 0 ? known.join(', ') : '(none)'}.`)
    }
  }

  const state = new Map<SpecId, 1 | 2>()
  for (const start of ids) {
    const path_: SpecId[] = []
    let cur: SpecId | undefined = start
    while (cur !== undefined && state.get(cur) !== 2) {
      if (state.get(cur) === 1) {
        const cycle = [...path_.slice(path_.indexOf(cur)), cur]
        const head = cycle[0] as SpecId
        issues.push({
          file: (files.get(head) as SourceFile).file,
          line: parsed.get(head)?.usesLine ?? null,
          message: `Fixture cycle: ${cycle.join(' → ')}.`,
        })
        break
      }
      state.set(cur, 1)
      path_.push(cur)
      cur = edges.get(cur)
    }
    for (const id of path_) state.set(id, 2)
  }

  if (issues.length > 0) return issues

  const hashes = new Map<SpecId, SpecHash>()
  const hashOf = (id: SpecId): SpecHash => {
    const known = hashes.get(id)
    if (known) return known
    const dep = edges.get(id)
    const h = sha256(`${normalize((files.get(id) as SourceFile).source)}\0${dep ? hashOf(dep) : ''}`) as SpecHash
    hashes.set(id, h)
    return h
  }

  const specs = new Map<SpecId, Spec>()
  for (const id of ids) {
    const p = parsed.get(id) as ParsedSpec
    const { file, source } = files.get(id) as SourceFile
    specs.set(id, {
      id,
      kind: id.startsWith(FIXTURE_PREFIX) ? 'fixture' : 'scenario',
      file,
      title: p.title,
      tags: p.tags,
      uses: edges.get(id) ?? null,
      scenarios: p.scenarios,
      envRefs: [...new Set(p.scenarios.flatMap((s) => [...s.steps, ...s.expect].flatMap((st) => st.envRefs)))].sort(),
      source,
      hash: hashOf(id),
    })
  }
  return new SuiteImpl(specsDir, app, files, specs)
}

class SuiteImpl implements Suite {
  constructor(
    private readonly specsDir: string,
    readonly app: AppSpec,
    private readonly files: ReadonlyMap<SpecId, SourceFile>,
    readonly specs: ReadonlyMap<SpecId, Spec>,
  ) {}

  select(selectors: readonly string[]): readonly Spec[] {
    if (selectors.length === 0) return [...this.specs.values()]
    const picked = new Set<SpecId>()
    const misses: SpecIssue[] = []
    for (const selector of selectors) {
      const matched = this.match(selector)
      if (matched.length === 0) misses.push({ file: selector, line: null, message: 'Selector matched no spec.' })
      for (const id of matched) picked.add(id)
    }
    if (misses.length > 0) throw new SpecError(misses)
    return [...this.specs.values()].filter((s) => picked.has(s.id))
  }

  private match(selector: string): SpecId[] {
    const candidates = new Set<string>()
    const clean = (s: string) => s.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/\.md$/, '')
    candidates.add(clean(selector))
    const rel = path.relative(this.specsDir, path.resolve(selector))
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) candidates.add(clean(rel.split(path.sep).join('/')))
    const out: SpecId[] = []
    for (const id of this.specs.keys()) {
      for (const c of candidates) if (c !== '' && (id === c || id.startsWith(`${c}/`))) out.push(id)
    }
    return out
  }

  fixtureChain(spec: Spec): readonly Spec[] {
    const chain: Spec[] = []
    for (let id = spec.uses; id !== null; ) {
      const fixture = this.specs.get(id) as Spec
      chain.unshift(fixture)
      id = fixture.uses
    }
    return chain
  }

  withEdit(id: SpecId, markdown: string): Suite | readonly SpecIssue[] {
    const existing = this.files.get(id)
    if (!existing) return [{ file: id, line: null, message: 'Unknown spec. withEdit replaces an existing spec.' }]
    const files = new Map(this.files)
    files.set(id, { file: existing.file, source: markdown })
    return buildSuite(this.specsDir, this.app, files)
  }
}
