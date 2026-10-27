import { access, readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'
import { z } from 'zod'
import type { LibrettoTool } from '../agent/index.js'
import type { FailureRecord } from '../workspace/index.js'

/** One action from the Playwright trace, flattened for the prompt. */
export interface TraceAction {
  readonly index: number
  readonly title: string
  readonly durationMs: number
  readonly error: string | null
  /** The `test.step` title it ran under, if any. */
  readonly step: string | null
}

/**
 * Reads the recorded evidence for one failure. Missing files (trace wiped by a later
 * `playwright test`) become nulls, not errors. The prompt says what is absent.
 */
export interface FailureEvidence {
  readonly actions: readonly TraceAction[] | null
  readonly screenshots: readonly string[]
  readonly dom: { readonly html: string; readonly aria: string } | null
}

const TraceEvent = z.looseObject({
  type: z.string(),
  callId: z.string().optional(),
  parentId: z.string().optional(),
  apiName: z.string().optional(),
  title: z.string().optional(),
  class: z.string().optional(),
  method: z.string().optional(),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
  error: z.unknown().optional(),
})
type TraceEvent = z.infer<typeof TraceEvent>

const DomSnapshot = z.object({ html: z.string(), aria: z.string() })

/**
 * Trace format assumptions. Inferred from real `trace.zip` files and Playwright's
 * source, not from a public spec, so they may drift between Playwright versions.
 * - The zip holds one or more `*.trace` entries (`test.trace`, `0-trace.trace`, ...),
 *   each NDJSON. Other entries (network, resources, stacks) are ignored.
 * - `before` events carry `callId`, `startTime` (ms), a title (`title`, else `apiName`,
 *   else `class.method`), and sometimes `parentId`. `after` events carry `callId`,
 *   `endTime`, and `error` (an object with `message`, or a string) on failure.
 * - A `test.step` is a `before` with `apiName === 'test.step'` or `class: 'Test'` and
 *   `method: 'step'`. Steps are not reported as actions, they label the actions inside.
 *   Enclosing step: follow `parentId` to the nearest step; without a parent link, fall
 *   back to the latest step whose time window contains the action's start.
 * - Lines that are not JSON objects with a string `type` are skipped.
 */
function parseTrace(files: readonly string[]): readonly TraceAction[] {
  const before = new Map<string, TraceEvent>()
  const after = new Map<string, TraceEvent>()
  for (const text of files) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let json: unknown
      try {
        json = JSON.parse(line)
      } catch {
        continue
      }
      const event = TraceEvent.safeParse(json)
      if (!event.success || event.data.callId === undefined) continue
      if (event.data.type === 'before') before.set(event.data.callId, event.data)
      else if (event.data.type === 'after') after.set(event.data.callId, event.data)
    }
  }

  const isStep = (e: TraceEvent) => e.apiName === 'test.step' || (e.class === 'Test' && e.method === 'step')
  const titleOf = (e: TraceEvent) => e.title ?? e.apiName ?? (e.class && e.method ? `${e.class}.${e.method}` : 'unknown')
  const steps = [...before.entries()].filter(([, e]) => isStep(e))

  const enclosingStep = (e: TraceEvent): string | null => {
    for (let parent = e.parentId; parent !== undefined; parent = before.get(parent)?.parentId) {
      const p = before.get(parent)
      if (p && isStep(p)) return titleOf(p)
    }
    const start = e.startTime ?? 0
    let found: TraceEvent | null = null
    for (const [id, s] of steps) {
      const sStart = s.startTime ?? 0
      const sEnd = after.get(id)?.endTime ?? Infinity
      if (sStart <= start && start <= sEnd && (!found || sStart >= (found.startTime ?? 0))) found = s
    }
    return found ? titleOf(found) : null
  }

  return [...before.entries()]
    .filter(([, e]) => !isStep(e))
    .sort(([, a], [, b]) => (a.startTime ?? 0) - (b.startTime ?? 0))
    .map(([id, e], index) => {
      const end = after.get(id)
      return {
        index,
        title: titleOf(e),
        durationMs: end?.endTime !== undefined && e.startTime !== undefined ? Math.max(0, end.endTime - e.startTime) : 0,
        error: errorMessage(end?.error),
        step: enclosingStep(e),
      }
    })
}

function errorMessage(error: unknown): string | null {
  if (error === undefined || error === null) return null
  if (typeof error === 'string') return error
  if (typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return JSON.stringify(error)
}

async function readTrace(path: string | null): Promise<readonly TraceAction[] | null> {
  if (path === null) return null
  try {
    const zip = unzipSync(new Uint8Array(await readFile(path)), { filter: (f) => f.name.endsWith('.trace') })
    const names = Object.keys(zip).sort()
    if (names.length === 0) return null
    return parseTrace(names.map((n) => strFromU8(zip[n]!)))
  } catch {
    return null
  }
}

async function readDom(path: string | null): Promise<FailureEvidence['dom']> {
  if (path === null) return null
  try {
    const parsed = DomSnapshot.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function loadEvidence(failure: FailureRecord): Promise<FailureEvidence> {
  const { trace, screenshots, domSnapshot } = failure.artifacts
  const present = await Promise.all(screenshots.map(exists))
  return {
    actions: await readTrace(trace),
    screenshots: screenshots.filter((_, i) => present[i]),
    dom: await readDom(domSnapshot),
  }
}

const DEFAULT_DOM_LIMIT = 200

function formatAction(a: TraceAction): string {
  const step = a.step === null ? '' : ` [step: ${a.step}]`
  const status = a.error === null ? '' : ` ERROR: ${a.error}`
  return `${a.index}. ${a.title} (${a.durationMs}ms)${step}${status}`
}

/**
 * Read-only tools over the evidence, so the prompt carries a summary and the agent pulls
 * detail on demand:
 * - `view_screenshot({ index })` → image reply
 * - `read_dom({ format: 'aria' | 'html', offset, limit })` → paged text
 * - `read_trace({ from, to })` → action range with errors
 */
export function evidenceTools(evidence: FailureEvidence): readonly LibrettoTool<any>[] {
  const viewScreenshot: LibrettoTool<{ index: number }> = {
    name: 'view_screenshot',
    description:
      'Shows one screenshot recorded when the test failed, by zero-based index. If none were recorded, the reply says so.',
    input: z.object({ index: z.number().int().min(0) }),
    handler: async ({ index }) => {
      const { screenshots } = evidence
      if (screenshots.length === 0) return 'No screenshots were recorded for this failure.'
      const path = screenshots[index]
      if (path === undefined) return `No screenshot at index ${index}. Valid indexes are 0 to ${screenshots.length - 1}.`
      const png = await readFile(path)
      return { text: `Screenshot ${index} of ${screenshots.length}`, images: [{ base64: png.toString('base64') }] }
    },
  }

  const readDomTool: LibrettoTool<{ format: 'aria' | 'html'; offset?: number | undefined; limit?: number | undefined }> = {
    name: 'read_dom',
    description:
      'Reads the page DOM captured at failure, as an aria snapshot or raw HTML, one page of lines at a time. If no snapshot was recorded, the reply says so.',
    input: z.object({
      format: z.enum(['aria', 'html']),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    }),
    handler: async ({ format, offset = 0, limit = DEFAULT_DOM_LIMIT }) => {
      if (evidence.dom === null) return 'No DOM snapshot was recorded for this failure.'
      const lines = evidence.dom[format].split('\n')
      if (offset >= lines.length) return `[offset ${offset} is past the end; ${lines.length} lines]`
      const end = Math.min(offset + limit, lines.length)
      const next = end < lines.length ? `call again with offset ${end}` : 'end'
      return `${lines.slice(offset, end).join('\n')}\n[lines ${offset + 1}-${end} of ${lines.length}; ${next}]`
    },
  }

  const readTraceTool: LibrettoTool<{ from?: number | undefined; to?: number | undefined }> = {
    name: 'read_trace',
    description:
      'Lists the Playwright actions the test ran, in order, with durations, enclosing steps, and errors. If the trace is gone, the reply says so.',
    input: z.object({
      from: z.number().int().min(0).optional(),
      to: z.number().int().min(0).optional(),
    }),
    handler: async ({ from = 0, to }) => {
      const { actions } = evidence
      if (actions === null) return 'The trace is unavailable: it was missing or unreadable.'
      if (actions.length === 0) return 'The trace holds no actions.'
      const last = Math.min(to ?? actions.length - 1, actions.length - 1)
      const range = actions.filter((a) => a.index >= from && a.index <= last)
      if (range.length === 0) return `No actions in range ${from}-${last}. The trace has ${actions.length} actions (0-${actions.length - 1}).`
      return `${range.map(formatAction).join('\n')}\n[actions ${from}-${last} of ${actions.length}]`
    },
  }

  return [viewScreenshot, readDomTool, readTraceTool]
}
