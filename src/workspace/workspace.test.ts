import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppHash, AppSpec, Spec, SpecHash, SpecId } from '../spec/index.js'
import { parseHeader } from './header.js'
import type { FailureId, FailureRecord, RunId, RunRecord, TriageLog } from './records.js'
import { openWorkspace, type RenderedTest, type Workspace } from './workspace.js'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'libretto-ws-'))
  ws = openWorkspace(root, path.join(root, 'specs'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const id = 'auth/login' as SpecId
const spec = (hash = 'h1'): Spec => ({ id, hash: hash as SpecHash, file: path.join(root, 'specs/auth/login.md') }) as Spec
const app = (hash = 'a1'): AppSpec => ({ file: '', source: '', hash: hash as AppHash })
const rendered = (specHash = 'h1', appHash = 'a1', body = 'test body\n'): RenderedTest => ({
  spec: id,
  specHash: specHash as SpecHash,
  appHash: appHash as AppHash,
  body,
})

async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true })
  return entries.map(String)
}

describe('paths', () => {
  it('follows the documented layout', () => {
    expect(ws.generatedFile(id)).toBe(path.join(root, '.libretto/generated/auth/login.generated.spec.ts'))
    expect(ws.draftFile(id)).toBe(path.join(root, '.libretto/drafts/auth/login.generated.spec.ts'))
    expect(ws.stateFile('fixtures/base' as SpecId)).toBe(path.join(root, '.libretto/state/fixtures/base.json'))
  })
})

describe('staleness and writeGenerated', () => {
  it('is missing before the first write, and the write reports it', async () => {
    expect(await ws.staleness(spec(), app())).toBe('missing')
    expect(await ws.stamp(id)).toBeNull()
    expect(await ws.writeGenerated(rendered(), 'specs/auth/login.md')).toEqual({ replaced: 'missing' })
  })

  it('is fresh after a write, with the stamp readable', async () => {
    await ws.writeGenerated(rendered(), 'specs/auth/login.md')
    expect(await ws.staleness(spec(), app())).toBe('fresh')
    expect(await ws.stamp(id)).toMatchObject({ specHash: 'h1', appHash: 'a1' })
    const text = await readFile(ws.generatedFile(id), 'utf8')
    expect(parseHeader(text)?.body).toBe('test body\n')
  })

  it('is spec-changed when the spec hash differs, and app-changed when only app differs', async () => {
    await ws.writeGenerated(rendered(), 'f.md')
    expect(await ws.staleness(spec('h2'), app())).toBe('spec-changed')
    expect(await ws.staleness(spec(), app('a2'))).toBe('app-changed')
    expect(await ws.staleness(spec('h2'), app('a2'))).toBe('spec-changed')
  })

  it('detects a hand edit of the body, ahead of every other state', async () => {
    await ws.writeGenerated(rendered(), 'f.md')
    const file = ws.generatedFile(id)
    await writeFile(file, (await readFile(file, 'utf8')).replace('test body', 'edited body'))
    expect(await ws.staleness(spec(), app())).toBe('hand-edited')
    expect(await ws.staleness(spec('h2'), app('a2'))).toBe('hand-edited')
    expect(await ws.stamp(id)).not.toBeNull()
  })

  it('treats a headerless file as hand-edited, with no stamp', async () => {
    await ws.writeGenerated(rendered(), 'f.md')
    await writeFile(ws.generatedFile(id), 'plain\n')
    expect(await ws.staleness(spec(), app())).toBe('hand-edited')
    expect(await ws.stamp(id)).toBeNull()
  })

  it('returns the prior staleness when overwriting, and leaves a fresh file', async () => {
    await ws.writeGenerated(rendered(), 'f.md')
    expect(await ws.writeGenerated(rendered(), 'f.md')).toEqual({ replaced: 'fresh' })
    expect(await ws.writeGenerated(rendered('h2'), 'f.md')).toEqual({ replaced: 'spec-changed' })
    expect(await ws.writeGenerated(rendered('h2', 'a2'), 'f.md')).toEqual({ replaced: 'app-changed' })
    const file = ws.generatedFile(id)
    await writeFile(file, 'mine\n')
    expect(await ws.writeGenerated(rendered('h2', 'a2'), 'f.md')).toEqual({ replaced: 'hand-edited' })
    expect(await ws.staleness(spec('h2'), app('a2'))).toBe('fresh')
  })

  it('writes drafts under drafts/ without touching generated/', async () => {
    const file = await ws.writeDraft(rendered(), 'f.md')
    expect(file).toBe(ws.draftFile(id))
    expect(parseHeader(await readFile(file, 'utf8'))?.header.spec).toBe(id)
    expect(await ws.staleness(spec(), app())).toBe('missing')
  })

  it('writes a spec to its file, creating directories', async () => {
    await ws.writeSpec(spec(), '# Login\n')
    expect(await readFile(spec().file, 'utf8')).toBe('# Login\n')
  })

  it('leaves no temp files behind', async () => {
    await ws.writeGenerated(rendered(), 'f.md')
    await ws.writeGenerated(rendered('h2'), 'f.md')
    await ws.writeDraft(rendered(), 'f.md')
    await ws.writeSpec(spec(), 'x')
    await ws.writeTriage({ records: {} })
    expect((await allFiles(root)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

const fid = (n: string) => `auth/login::chromium::${n}` as FailureId
const failure = (n: string, runId = 'r1'): FailureRecord => ({
  id: fid(n),
  runId: runId as RunId,
  spec: id,
  scenario: n,
  project: 'chromium',
  step: null,
  error: { message: 'boom', stack: null },
  artifacts: { trace: null, screenshots: [], domSnapshot: null },
  generated: { specHash: 'h1' as SpecHash, appHash: 'a1' as AppHash, bodyHash: 'b' },
  retries: 0,
})
const latest = (runId: string, passed = 0): RunRecord['latest'] => ({
  runId: runId as RunId,
  startedAt: '2026-01-01T00:00:00Z',
  baseURL: 'http://x',
  passed,
})

describe('last run', () => {
  it('is null when missing', async () => {
    expect(await ws.readLastRun()).toBeNull()
  })

  it('writes the first run as is', async () => {
    await ws.mergeLastRun(latest('r1'), [fid('a')], [failure('a')], [fid('f')])
    const run = await ws.readLastRun()
    expect(run?.latest.runId).toBe('r1')
    expect(Object.keys(run?.failures ?? {})).toEqual([fid('a')])
    expect(run?.flaky).toEqual([fid('f')])
  })

  it('keeps failures from an earlier run for tests that were not rerun', async () => {
    await ws.mergeLastRun(latest('r1'), [fid('a'), fid('b'), fid('c')], [failure('a'), failure('b')], [])
    await ws.mergeLastRun(latest('r2', 1), [fid('a'), fid('c')], [failure('a', 'r2')], [])
    const run = await ws.readLastRun()
    expect(run?.latest.runId).toBe('r2')
    expect(Object.keys(run?.failures ?? {}).sort()).toEqual([fid('a'), fid('b')])
    expect(run?.failures[fid('a')]?.runId).toBe('r2')
    expect(run?.failures[fid('b')]?.runId).toBe('r1')
  })

  it('drops an entry that passed in the later run', async () => {
    await ws.mergeLastRun(latest('r1'), [fid('a')], [failure('a')], [])
    await ws.mergeLastRun(latest('r2', 1), [fid('a')], [], [])
    expect(Object.keys((await ws.readLastRun())?.failures ?? {})).toEqual([])
  })

  it('rejects a corrupt last-run.json with the path and the offending field', async () => {
    await ws.mergeLastRun(latest('r1'), [], [], [])
    const file = path.join(ws.dir, 'last-run.json')
    await writeFile(file, JSON.stringify({ latest: { runId: 'r1' }, flaky: [], failures: {} }))
    const err = await ws.readLastRun().catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('last-run.json')
    expect((err as Error).message).toContain('latest.startedAt')
    await expect(ws.mergeLastRun(latest('r2'), [], [], [])).rejects.toThrow('last-run.json')
  })

  it('rejects unparseable JSON', async () => {
    await ws.mergeLastRun(latest('r1'), [], [], [])
    await writeFile(path.join(ws.dir, 'last-run.json'), '{nope')
    await expect(ws.readLastRun()).rejects.toThrow('not valid JSON')
  })
})

describe('triage', () => {
  it('is empty when missing and round-trips a log', async () => {
    expect(await ws.readTriage()).toEqual({ records: {} })
    const log: TriageLog = {
      records: {
        [fid('a')]: {
          failure: fid('a'),
          runId: 'r1' as RunId,
          spec: id,
          generated: failure('a').generated,
          verdict: { kind: 'app-broken', evidence: 'e' },
          live: true,
          model: 'm',
          usage: { turns: 1, costUsd: 0.1 },
          at: '2026-01-01T00:00:00Z',
        },
      },
    }
    await ws.writeTriage(log)
    expect(await ws.readTriage()).toEqual(log)
  })
})
