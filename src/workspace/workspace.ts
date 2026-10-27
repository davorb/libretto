import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'
import { parseHeader, renderHeader, sha256 } from './header.js'
import { runRecordSchema, triageLogSchema } from './records.js'
import type { AppHash, AppSpec, Spec, SpecHash, SpecId } from '../spec/index.js'
import type { FailureId, FailureRecord, GeneratedStamp, RunRecord, TriageLog } from './records.js'

/**
 * - `fresh`: header specHash and appHash equal the current ones and bodyHash matches the body.
 * - `missing`: no generated file.
 * - `spec-changed`: header specHash differs (spec or a fixture in its chain changed).
 * - `app-changed`: only `app.md` differs. Stale for `generate`; `run` warns.
 * - `hand-edited`: bodyHash mismatch or header unreadable. Takes precedence over the
 *   others, because it is the state that needs a warning when overwritten.
 *
 * Precedence: hand-edited > missing > spec-changed > app-changed > fresh.
 */
export type Staleness = 'fresh' | 'missing' | 'spec-changed' | 'app-changed' | 'hand-edited'

/** A complete generated file body (no header), ready to write. Produced only by `generate/draft.ts`. */
export interface RenderedTest {
  readonly spec: SpecId
  readonly specHash: SpecHash
  readonly appHash: AppHash
  readonly body: string
}

/**
 * Owner of `.libretto/` and the only writer of anything under `specs/` or
 * `.libretto/generated/`. Every write is atomic (temp file + rename), so a crash
 * never leaves a half-written test or record.
 *
 * Layout:
 *   .libretto/generated/<id>.generated.spec.ts   committed
 *   .libretto/state/<fixture>.json               storageState, gitignored
 *   .libretto/drafts/<id>.generated.spec.ts      generate-time drafts, gitignored
 *   .libretto/playwright.config.ts               wrapper config, rewritten every run
 *   .libretto/last-run.json, triage.json         gitignored
 */
export interface Workspace {
  readonly root: string
  readonly specsDir: string
  readonly dir: string
  readonly generatedDir: string
  readonly draftsDir: string
  readonly stateDir: string

  generatedFile(id: SpecId): string
  draftFile(id: SpecId): string
  /** Where a fixture's setup test saves, and dependents load, storageState. */
  stateFile(fixture: SpecId): string

  staleness(spec: Spec, app: AppSpec): Promise<Staleness>
  /** The stamp of the current generated file, or null if missing/unreadable. Used by `fix` to detect handled verdicts. */
  stamp(id: SpecId): Promise<GeneratedStamp | null>
  /** Adds the header. Returns the prior staleness so the caller can warn on `hand-edited`. */
  writeGenerated(test: RenderedTest, specFile: string): Promise<{ replaced: Staleness }>
  writeDraft(test: RenderedTest, specFile: string): Promise<string>
  writeSpec(spec: Spec, markdown: string): Promise<void>

  readLastRun(): Promise<RunRecord | null>
  /**
   * Merges one run into the record: entries for `ran` are dropped, then `failures` are
   * added, `latest` is replaced. Entries for tests not in `ran` are untouched. Called
   * once by the reporter at `onEnd`; the write is atomic.
   */
  mergeLastRun(run: RunRecord['latest'], ran: readonly FailureId[], failures: readonly FailureRecord[], flaky: readonly FailureId[]): Promise<void>
  /** Empty log when the file is missing. */
  readTriage(): Promise<TriageLog>
  writeTriage(log: TriageLog): Promise<void>
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, content)
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

async function readRecord<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  const text = await readIfExists(file)
  if (text === null) return null
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}). Delete it to start fresh.`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`${file} does not match the expected format. Delete it to start fresh.\n${issues}`)
  }
  return parsed.data
}

function classify(text: string, specHash: SpecHash, appHash: AppHash): Staleness {
  const parsed = parseHeader(text)
  if (!parsed || sha256(parsed.body) !== parsed.header.bodyHash) return 'hand-edited'
  if (parsed.header.specHash !== specHash) return 'spec-changed'
  if (parsed.header.appHash !== appHash) return 'app-changed'
  return 'fresh'
}

export function openWorkspace(root: string, specsDir: string): Workspace {
  const dir = path.join(root, '.libretto')
  const generatedDir = path.join(dir, 'generated')
  const draftsDir = path.join(dir, 'drafts')
  const stateDir = path.join(dir, 'state')
  const lastRunFile = path.join(dir, 'last-run.json')
  const triageFile = path.join(dir, 'triage.json')

  const generatedFile = (id: SpecId) => path.join(generatedDir, `${id}.generated.spec.ts`)
  const draftFile = (id: SpecId) => path.join(draftsDir, `${id}.generated.spec.ts`)
  const withHeader = (test: RenderedTest, specFile: string) =>
    renderHeader(test.spec, specFile, test.specHash, test.appHash, test.body)

  async function staleness(spec: Spec, app: AppSpec): Promise<Staleness> {
    const text = await readIfExists(generatedFile(spec.id))
    return text === null ? 'missing' : classify(text, spec.hash, app.hash)
  }

  return {
    root,
    specsDir,
    dir,
    generatedDir,
    draftsDir,
    stateDir,
    generatedFile,
    draftFile,
    stateFile: (fixture) => path.join(stateDir, `${fixture}.json`),
    staleness,

    async stamp(id) {
      const text = await readIfExists(generatedFile(id))
      const parsed = text === null ? null : parseHeader(text)
      if (!parsed) return null
      const { specHash, appHash, bodyHash } = parsed.header
      return { specHash, appHash, bodyHash }
    },

    async writeGenerated(test, specFile) {
      const file = generatedFile(test.spec)
      const prior = await readIfExists(file)
      const replaced = prior === null ? 'missing' : classify(prior, test.specHash, test.appHash)
      await atomicWrite(file, withHeader(test, specFile))
      return { replaced }
    },

    async writeDraft(test, specFile) {
      const file = draftFile(test.spec)
      await atomicWrite(file, withHeader(test, specFile))
      return file
    },

    writeSpec: (spec, markdown) => atomicWrite(spec.file, markdown),

    readLastRun: () => readRecord(lastRunFile, runRecordSchema),

    async mergeLastRun(run, ran, failures, flaky) {
      const prior = await readRecord(lastRunFile, runRecordSchema)
      const dropped = new Set<string>(ran)
      const kept = Object.entries(prior?.failures ?? {}).filter(([id]) => !dropped.has(id))
      const merged: RunRecord = {
        latest: run,
        flaky: [...new Set([...(prior?.flaky ?? []).filter((id) => !dropped.has(id)), ...flaky])],
        failures: { ...Object.fromEntries(kept), ...Object.fromEntries(failures.map((f) => [f.id, f])) },
      }
      await atomicWrite(lastRunFile, JSON.stringify(merged, null, 2) + '\n')
    },

    async readTriage() {
      return (await readRecord(triageFile, triageLogSchema)) ?? { records: {} }
    },

    writeTriage: (log) => atomicWrite(triageFile, JSON.stringify(log, null, 2) + '\n'),
  }
}
