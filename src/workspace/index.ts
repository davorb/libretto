/** `.libretto/` layout, generated-file header, and the record files commands exchange. `header.ts` internals stay here except `parseHeader` (the reporter reads headers). */
export type { Staleness, RenderedTest, Workspace } from './workspace.js'
export { openWorkspace } from './workspace.js'
export { parseHeader, type Header } from './header.js'
export type {
  FailureId,
  FailureRecord,
  GeneratedStamp,
  RunId,
  RunRecord,
  TriageLog,
  TriageRecord,
  Verdict,
} from './records.js'
