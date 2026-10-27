/**
 * The public API of `libretto`. `package.json#exports` exposes only this file plus
 * `libretto/test` and `libretto/reporter`, so no deep import resolves for a consumer.
 * Inside the repo, an eslint `no-restricted-imports` rule allows `../<module>/index.js`
 * only (see MODULES.md).
 */

// Config
export { defineConfig, type LibrettoConfig, type CommandOverrides } from './config/index.js'

// Commands
export { generate, type GenerateOptions, type GenerateReport } from './generate/index.js'
export { run, type RunOptions, type RunReport } from './run/index.js'
export { triage, type TriageOptions, type TriageReport } from './triage/index.js'
export { fix, type FixOptions, type FixReport, type FixProposal } from './fix/index.js'
export type { CommandOptions } from './project/index.js'
export type { Logger } from './log/index.js'

// Records and domain types callers read
export type { FailureRecord, RunRecord, TriageRecord, Verdict, FailureId, RunId, Staleness } from './workspace/index.js'
export type { SpecId, StepRef } from './spec/index.js'
export { SpecError, type SpecIssue } from './spec/index.js'

// Backend seam: implement AgentRunner to bring a backend, or construct a built-in one with options
export {
  ClaudeRunner,
  CopilotRunner,
  AgentSetupError,
  MissingSecretsError,
  Secrets,
  type ClaudeRunnerOptions,
  type CopilotRunnerOptions,
  type AgentRunner,
  type AgentTask,
  type AgentResult,
  type AgentEvent,
  type AgentProfile,
  type Acceptance,
  type BrowserTarget,
  type LibrettoTool,
  type ObjectSchema,
  type StopReason,
  type Submission,
  type ToolReply,
  type Usage,
} from './agent/index.js'
