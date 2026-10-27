import type { AgentEvent } from '../agent/index.js'

/** Where every command reports progress. The CLI uses `consoleLogger`; library callers pass their own. */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  /** Agent transcript events, labelled by task (`triage auth/login::chromium::valid credentials`). */
  agent(label: string, event: AgentEvent): void
}

export function consoleLogger(options: { verbose: boolean }): Logger {
  throw new Error('not implemented')
}
