/**
 * The AI seam. Everything vendor-specific lives behind this barrel.
 * Not exported: harness.ts (openSession), playwright-mcp.ts (except
 * `secretUsageInstructions`, which prompt builders need), `unseal`.
 */
export { secretUsageInstructions } from './playwright-mcp.js'
export type {
  Acceptance,
  AgentEvent,
  AgentProfile,
  AgentResult,
  AgentRunner,
  AgentTask,
  BrowserTarget,
  LibrettoTool,
  ObjectSchema,
  PngImage,
  StopReason,
  Submission,
  ToolReply,
  Usage,
} from './types.js'
export { AgentSetupError } from './types.js'
export { Secrets, MissingSecretsError } from './secrets.js'
export { ClaudeRunner, type ClaudeRunnerOptions } from './claude.js'
export { CopilotRunner, type CopilotRunnerOptions } from './copilot.js'

import type { AgentRunner } from './types.js'
import { ClaudeRunner } from './claude.js'
import { CopilotRunner } from './copilot.js'

export type Backend = 'claude' | 'copilot'

/**
 * Backend name to runner. The SDKs are optional peer dependencies, loaded by dynamic
 * import inside each runner's `run`, so constructing a runner never fails and `run`
 * (the command) never loads an SDK at all.
 */
export function createAgentRunner(backend: Backend): AgentRunner {
  switch (backend) {
    case 'claude':
      return new ClaudeRunner()
    case 'copilot':
      return new CopilotRunner()
  }
}
