import type { AgentEvent } from '../agent/index.js'

/** Where every command reports progress. The CLI uses `consoleLogger`; library callers pass their own. */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  /** Agent transcript events, labelled by task (`triage auth/login::chromium::valid credentials`). */
  agent(label: string, event: AgentEvent): void
}

function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'turn':
      return `turn ${event.turn}`
    case 'text':
      return event.text
    case 'tool-call':
      return `${event.server}.${event.tool} ${JSON.stringify(event.input) ?? ''}`.trimEnd()
    case 'tool-result':
      return `${event.server}.${event.tool} ${event.ok ? 'ok' : `failed: ${event.reason}`}`
  }
}

/** Writes to stderr (stdout stays clean for machine output). Agent transcript lines print only when `verbose`. */
export function consoleLogger(options: { verbose: boolean }): Logger {
  const write = (line: string) => void process.stderr.write(`${line}\n`)
  return {
    info: (message) => write(message),
    warn: (message) => write(`warn: ${message}`),
    error: (message) => write(`error: ${message}`),
    agent: (label, event) => {
      if (options.verbose) write(`[${label}] ${describeEvent(event)}`)
    },
  }
}
