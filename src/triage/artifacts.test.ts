import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FailureRecord } from '../workspace/index.js'
import { evidenceTools, loadEvidence, type FailureEvidence } from './artifacts.js'

const TRACE = [
  { type: 'context-options', version: 8 },
  { type: 'before', callId: 'call@1', apiName: 'test.step', title: 'log in', class: 'Test', method: 'step', startTime: 100 },
  { type: 'before', callId: 'call@2', parentId: 'call@1', apiName: 'page.fill', title: 'Fill "#user"', startTime: 110 },
  { type: 'after', callId: 'call@2', endTime: 150 },
  { type: 'before', callId: 'call@3', apiName: 'locator.click', title: 'Click "Sign in"', startTime: 160 },
  { type: 'after', callId: 'call@3', endTime: 5160, error: { name: 'TimeoutError', message: 'waiting for button' } },
  { type: 'after', callId: 'call@1', endTime: 5200 },
]
  .map((e) => JSON.stringify(e))
  .join('\n')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artifacts-test-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function failure(artifacts: Partial<FailureRecord['artifacts']>): Promise<FailureRecord> {
  return { artifacts: { trace: null, screenshots: [], domSnapshot: null, ...artifacts } } as FailureRecord
}

async function writeTrace(files: Record<string, string> = { 'test.trace': TRACE }): Promise<string> {
  const path = join(dir, 'trace.zip')
  const entries = Object.fromEntries(Object.entries(files).map(([n, c]) => [n, strToU8(c)]))
  await writeFile(path, zipSync({ ...entries, 'resources/x.png': strToU8('ignored') }))
  return path
}

describe('loadEvidence', () => {
  it('pairs before/after events and attaches the enclosing step', async () => {
    const { actions } = await loadEvidence(await failure({ trace: await writeTrace() }))
    expect(actions).toEqual([
      { index: 0, title: 'Fill "#user"', durationMs: 40, error: null, step: 'log in' },
      { index: 1, title: 'Click "Sign in"', durationMs: 5000, error: 'waiting for button', step: 'log in' },
    ])
  })

  it('infers the step from time containment when there is no parentId', async () => {
    const trace = [
      { type: 'before', callId: 's', apiName: 'test.step', title: 'outer', startTime: 0 },
      { type: 'before', callId: 'a', title: 'inside', startTime: 5 },
      { type: 'after', callId: 'a', endTime: 6 },
      { type: 'after', callId: 's', endTime: 10 },
      { type: 'before', callId: 'b', title: 'outside', startTime: 20 },
      { type: 'after', callId: 'b', endTime: 21 },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n')
    const { actions } = await loadEvidence(await failure({ trace: await writeTrace({ 'test.trace': trace }) }))
    expect(actions?.map((a) => a.step)).toEqual(['outer', null])
  })

  it('returns null actions for a missing, non-zip, or trace-less file', async () => {
    expect((await loadEvidence(await failure({ trace: join(dir, 'nope.zip') }))).actions).toBeNull()
    expect((await loadEvidence(await failure({ trace: null }))).actions).toBeNull()
    const junk = join(dir, 'junk.zip')
    await writeFile(junk, 'not a zip')
    expect((await loadEvidence(await failure({ trace: junk }))).actions).toBeNull()
    expect((await loadEvidence(await failure({ trace: await writeTrace({}) }))).actions).toBeNull()
  })

  it('keeps only screenshots that exist', async () => {
    const real = join(dir, 'a.png')
    await writeFile(real, 'png')
    const { screenshots } = await loadEvidence(await failure({ screenshots: [join(dir, 'gone.png'), real] }))
    expect(screenshots).toEqual([real])
  })

  it('parses the DOM snapshot and returns null when missing or malformed', async () => {
    const path = join(dir, 'dom.json')
    await writeFile(path, JSON.stringify({ html: '<p>hi</p>', aria: '- heading' }))
    expect((await loadEvidence(await failure({ domSnapshot: path }))).dom).toEqual({ html: '<p>hi</p>', aria: '- heading' })
    expect((await loadEvidence(await failure({ domSnapshot: join(dir, 'gone.json') }))).dom).toBeNull()
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{oops')
    expect((await loadEvidence(await failure({ domSnapshot: bad }))).dom).toBeNull()
    await writeFile(bad, JSON.stringify({ html: 1 }))
    expect((await loadEvidence(await failure({ domSnapshot: bad }))).dom).toBeNull()
  })
})

describe('evidenceTools', () => {
  const absent: FailureEvidence = { actions: null, screenshots: [], dom: null }

  function tool(evidence: FailureEvidence, name: string) {
    const t = evidenceTools(evidence).find((x) => x.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t
  }

  it('exposes three object-schema tools with descriptions', () => {
    const tools = evidenceTools(absent)
    expect(tools.map((t) => t.name)).toEqual(['view_screenshot', 'read_dom', 'read_trace'])
    for (const t of tools) expect(t.description.length).toBeGreaterThan(20)
  })

  it('view_screenshot returns the PNG as base64', async () => {
    const path = join(dir, 's.png')
    await writeFile(path, Buffer.from([1, 2, 3]))
    const t = tool({ ...absent, screenshots: [path] }, 'view_screenshot')
    expect(await t.handler({ index: 0 })).toEqual({ text: 'Screenshot 0 of 1', images: [{ base64: 'AQID' }] })
    expect(await t.handler({ index: 4 })).toContain('Valid indexes are 0 to 0')
  })

  it('view_screenshot says when there are none', async () => {
    expect(await tool(absent, 'view_screenshot').handler({ index: 0 })).toBe('No screenshots were recorded for this failure.')
  })

  it('read_dom pages with a trailer', async () => {
    const aria = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n')
    const t = tool({ ...absent, dom: { html: '<a>\n<b>', aria } }, 'read_dom')
    const first = (await t.handler({ format: 'aria' })) as string
    expect(first.endsWith('[lines 1-200 of 450; call again with offset 200]')).toBe(true)
    expect(first).toContain('line 200\n')
    expect(first).not.toContain('line 201')
    const last = (await t.handler({ format: 'aria', offset: 400, limit: 200 })) as string
    expect(last).toContain('line 450')
    expect(last.endsWith('[lines 401-450 of 450; end]')).toBe(true)
    expect(await t.handler({ format: 'aria', offset: 900 })).toBe('[offset 900 is past the end; 450 lines]')
    expect(await t.handler({ format: 'html' })).toBe('<a>\n<b>\n[lines 1-2 of 2; end]')
  })

  it('read_dom says when there is no snapshot', async () => {
    expect(await tool(absent, 'read_dom').handler({ format: 'html' })).toBe('No DOM snapshot was recorded for this failure.')
  })

  it('read_trace lists a range with errors marked', async () => {
    const { actions } = await loadEvidence(await failure({ trace: await writeTrace() }))
    const t = tool({ ...absent, actions }, 'read_trace')
    expect(await t.handler({})).toBe(
      [
        '0. Fill "#user" (40ms) [step: log in]',
        '1. Click "Sign in" (5000ms) [step: log in] ERROR: waiting for button',
        '[actions 0-1 of 2]',
      ].join('\n'),
    )
    expect(await t.handler({ from: 1, to: 1 })).toContain('1. Click')
    expect(await t.handler({ from: 1, to: 1 })).not.toContain('0. Fill')
    expect(await t.handler({ from: 5 })).toContain('No actions in range 5-1')
  })

  it('read_trace says when the trace is gone', async () => {
    expect(await tool(absent, 'read_trace').handler({})).toBe('The trace is unavailable: it was missing or unreadable.')
  })
})
