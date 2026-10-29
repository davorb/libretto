import { afterEach, describe, expect, it, vi } from 'vitest'
import { consoleLogger } from './index.js'

function capture() {
  const lines: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk))
    return true
  })
  return lines
}
afterEach(() => vi.restoreAllMocks())

describe('consoleLogger', () => {
  it('writes info, warn and error to stderr only', () => {
    const lines = capture()
    const stdout = vi.spyOn(process.stdout, 'write')
    const log = consoleLogger({ verbose: false })
    log.info('hello')
    log.warn('careful')
    log.error('boom')
    expect(lines).toEqual(['hello\n', 'warn: careful\n', 'error: boom\n'])
    expect(stdout).not.toHaveBeenCalled()
  })

  it('prints agent events only when verbose, labelled by task', () => {
    const lines = capture()
    const quiet = consoleLogger({ verbose: false })
    quiet.agent('triage a', { type: 'text', text: 'thinking' })
    expect(lines).toEqual([])

    const loud = consoleLogger({ verbose: true })
    loud.agent('triage a', { type: 'turn', turn: 2 })
    loud.agent('triage a', { type: 'text', text: 'thinking' })
    loud.agent('triage a', { type: 'tool-call', server: 'playwright', tool: 'browser_click', input: { ref: 'e1' } })
    loud.agent('triage a', { type: 'tool-result', server: 'libretto', tool: 'read_spec', ok: false, reason: 'No spec named x' })
    expect(lines).toEqual([
      '[triage a] turn 2\n',
      '[triage a] thinking\n',
      '[triage a] playwright.browser_click {"ref":"e1"}\n',
      '[triage a] libretto.read_spec failed: No spec named x\n',
    ])
  })
})
