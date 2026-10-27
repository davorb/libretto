import { describe, expect, it } from 'vitest'
import { runRecordSchema, triageLogSchema } from './records.js'

const generated = { specHash: 'a', appHash: 'b', bodyHash: 'c' }
const failure = {
  id: 'auth/login::chromium::happy',
  runId: 'r1',
  spec: 'auth/login',
  scenario: 'happy',
  project: 'chromium',
  step: { scenario: 'happy', section: 'steps', index: 2 },
  error: { message: 'boom', stack: null },
  artifacts: { trace: null, screenshots: ['/a.png'], domSnapshot: null },
  generated,
  retries: 0,
}

describe('runRecordSchema', () => {
  const run = {
    latest: { runId: 'r1', startedAt: '2026-01-01T00:00:00Z', baseURL: 'http://x', passed: 3 },
    flaky: [],
    failures: { [failure.id]: failure },
  }

  it('parses a valid record and accepts a null step', () => {
    expect(runRecordSchema.parse(run)).toEqual(run)
    const nullStep = { ...run, failures: { [failure.id]: { ...failure, step: null } } }
    expect(runRecordSchema.parse(nullStep).failures[failure.id as never]?.step).toBeNull()
  })

  it('rejects a bad section, naming its path', () => {
    const bad = { ...run, failures: { [failure.id]: { ...failure, step: { scenario: 's', section: 'nope', index: 1 } } } }
    const r = runRecordSchema.safeParse(bad)
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('section')
  })
})

describe('triageLogSchema', () => {
  const record = {
    failure: failure.id,
    runId: 'r1',
    spec: 'auth/login',
    generated,
    verdict: { kind: 'test-broken', evidence: 'e', cause: 'spec-wrong' },
    live: true,
    model: 'm',
    usage: { turns: 2, costUsd: null },
    at: '2026-01-01T00:00:00Z',
  }

  it('parses each verdict kind and rejects an unknown one', () => {
    for (const verdict of [record.verdict, { kind: 'app-broken', evidence: 'e' }, { kind: 'inconclusive', evidence: 'e' }]) {
      expect(triageLogSchema.safeParse({ records: { [failure.id]: { ...record, verdict } } }).success).toBe(true)
    }
    const bad = { records: { [failure.id]: { ...record, verdict: { kind: 'test-broken', evidence: 'e' } } } }
    expect(triageLogSchema.safeParse(bad).success).toBe(false)
  })
})
