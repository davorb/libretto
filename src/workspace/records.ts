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

// TODO: Zod schemas mirroring the interfaces above, with `satisfies z.ZodType<RunRecord>`
// so the interface and schema can't drift (the build fails if they disagree).
export const runRecordSchema: z.ZodType<RunRecord> = undefined as never
export const triageLogSchema: z.ZodType<TriageLog> = undefined as never
