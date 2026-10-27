import { z } from 'zod'
import type { AppHash, SpecHash, SpecId, StepRef } from '../spec/index.js'

/**
 * On-disk contracts between commands. `run` writes RunRecord, `triage` reads it and
 * writes TriageLog, `fix` reads both. Zod schemas parse on read (files are a boundary:
 * a user can hand-edit or an old version may have written them).
 */

/** `${specId}::${project}::${scenario}`. Stable across runs for the same test. */
export type FailureId = string & { readonly __brand: 'FailureId' }
export type RunId = string & { readonly __brand: 'RunId' }

/** Identity of the generated file a test ran from, read from its header. */
export interface GeneratedStamp {
  readonly specHash: SpecHash
  readonly appHash: AppHash
  readonly bodyHash: string
}

export interface FailureRecord {
  readonly id: FailureId
  /** The run that produced this entry. Entries from different runs coexist after a partial run. */
  readonly runId: RunId
  readonly spec: SpecId
  readonly scenario: string
  readonly project: string
  /** Null when the failure is outside any rendered step (e.g. a fixture setup or a timeout in a hook). */
  readonly step: StepRef | null
  readonly error: { readonly message: string; readonly stack: string | null }
  /** Absolute paths. Playwright's `outputDir` is wiped by the next run, and so is this record. */
  readonly artifacts: {
    readonly trace: string | null
    readonly screenshots: readonly string[]
    /** Attached by `libretto/test`'s auto fixture: page HTML plus aria snapshot. */
    readonly domSnapshot: string | null
  }
  readonly generated: GeneratedStamp
  /** Retries Playwright already spent. Triage reads only final outcomes. */
  readonly retries: number
}

/**
 * Merged per test, not replaced per run. `libretto run auth/login` touches only the
 * entries for tests it ran: passed ones are removed, failed ones replaced. Failures
 * from an earlier, wider run stay triageable. `latest` names the most recent run.
 */
export interface RunRecord {
  readonly latest: { readonly runId: RunId; readonly startedAt: string; readonly baseURL: string; readonly passed: number }
  readonly flaky: readonly FailureId[]
  readonly failures: Readonly<Record<FailureId, FailureRecord>>
}

/** SPEC's Verdict, unchanged. */
export type Verdict =
  | { readonly kind: 'app-broken'; readonly evidence: string }
  | { readonly kind: 'test-broken'; readonly evidence: string; readonly cause: 'spec-wrong' | 'generated-code-wrong' }
  | { readonly kind: 'inconclusive'; readonly evidence: string }

export interface TriageRecord {
  readonly failure: FailureId
  readonly runId: RunId
  readonly spec: SpecId
  /** Copied from the FailureRecord. `fix` compares it to the current files to skip handled verdicts. */
  readonly generated: GeneratedStamp
  readonly verdict: Verdict
  /** False when baseURL was unreachable and only recorded artifacts were used. */
  readonly live: boolean
  readonly model: string
  readonly usage: { readonly turns: number; readonly costUsd: number | null }
  readonly at: string
}

/** Keyed by FailureId so re-triage replaces a record instead of appending a duplicate. */
export interface TriageLog {
  readonly records: Readonly<Record<FailureId, TriageRecord>>
}

const failureId = z.string().transform((s) => s as FailureId)
const runId = z.string().transform((s) => s as RunId)
const specId = z.string().transform((s) => s as SpecId)
const specHash = z.string().transform((s) => s as SpecHash)
const appHash = z.string().transform((s) => s as AppHash)

const stampSchema = z.object({ specHash, appHash, bodyHash: z.string() })

const stepRefSchema = z.object({
  scenario: z.string(),
  section: z.enum(['steps', 'expect']),
  index: z.number().int().min(1),
})

const failureRecordSchema = z.object({
  id: failureId,
  runId,
  spec: specId,
  scenario: z.string(),
  project: z.string(),
  step: stepRefSchema.nullable(),
  error: z.object({ message: z.string(), stack: z.string().nullable() }),
  artifacts: z.object({
    trace: z.string().nullable(),
    screenshots: z.array(z.string()),
    domSnapshot: z.string().nullable(),
  }),
  generated: stampSchema,
  retries: z.number().int().min(0),
})

const verdictSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app-broken'), evidence: z.string() }),
  z.object({
    kind: z.literal('test-broken'),
    evidence: z.string(),
    cause: z.enum(['spec-wrong', 'generated-code-wrong']),
  }),
  z.object({ kind: z.literal('inconclusive'), evidence: z.string() }),
])

const triageRecordSchema = z.object({
  failure: failureId,
  runId,
  spec: specId,
  generated: stampSchema,
  verdict: verdictSchema,
  live: z.boolean(),
  model: z.string(),
  usage: z.object({ turns: z.number(), costUsd: z.number().nullable() }),
  at: z.string(),
})

export const runRecordSchema = z.object({
  latest: z.object({
    runId,
    startedAt: z.string(),
    baseURL: z.string(),
    passed: z.number().int().min(0),
  }),
  flaky: z.array(failureId),
  failures: z.record(z.string(), failureRecordSchema),
}) satisfies z.ZodType<RunRecord>

export const triageLogSchema = z.object({
  records: z.record(z.string(), triageRecordSchema),
}) satisfies z.ZodType<TriageLog>
