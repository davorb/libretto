import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../index.js')>()),
  generate: vi.fn(),
  run: vi.fn(),
  triage: vi.fn(),
  fix: vi.fn(),
}))

import { AgentSetupError, SpecError, fix, generate, run, triage, type FixProposal } from '../index.js'
import { main } from './main.js'

let stdout: string
let stderr: string

beforeEach(() => {
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((stderr += String(chunk)), true))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(generate).mockReset()
  vi.mocked(run).mockReset()
  vi.mocked(triage).mockReset()
  vi.mocked(fix).mockReset()
})

const generated = (over: Record<string, unknown> = {}) =>
  ({ written: [{ status: 'written', spec: 'auth/login', replaced: 'missing' }], fresh: ['cart'], failed: [], ...over }) as never

describe('generate', () => {
  it('prints written and fresh specs, passes selectors, --force and --config, and exits 0', async () => {
    vi.mocked(generate).mockResolvedValue(generated())
    expect(await main(['generate', 'auth', 'cart', '--force', '--config', 'x.config.ts'])).toBe(0)
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ specs: ['auth', 'cart'], force: true, config: 'x.config.ts' }))
    expect(stdout).toContain('written  auth/login')
    expect(stdout).toContain('fresh    cart')
  })

  it('exits 1 and names the failure when any spec failed', async () => {
    vi.mocked(generate).mockResolvedValue(generated({ failed: [{ status: 'failed', spec: 'x', reason: 'turn-cap', detail: 'ran out' }] }))
    expect(await main(['generate'])).toBe(1)
    expect(stdout).toContain('failed   x: turn-cap')
  })

  it('passes a logger so --verbose reaches the agent transcript', async () => {
    vi.mocked(generate).mockResolvedValue(generated())
    await main(['generate', '--verbose'])
    const { log } = vi.mocked(generate).mock.calls[0]![0]!
    log!.agent('t', { type: 'text', text: 'hello agent' })
    expect(stderr).toContain('hello agent')
  })
})

describe('run', () => {
  it('forwards args after -- and exits with Playwright\'s code', async () => {
    vi.mocked(run).mockResolvedValue({
      runId: 'r',
      exitCode: 1,
      passed: 3,
      failures: [{ spec: 'auth/login', scenario: 'valid', error: { message: 'timed out\nmore' } }],
      staleWarnings: [{ spec: 'cart', staleness: 'spec-changed' }],
    } as never)
    expect(await main(['run', 'auth', '--', '--workers=2', '--headed'])).toBe(1)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ specs: ['auth'], playwrightArgs: ['--workers=2', '--headed'] }))
    expect(stdout).toContain('stale: cart is spec-changed')
    expect(stdout).toContain('3 passed, 1 failed')
    expect(stdout).toContain('FAIL auth/login › valid: timed out')
  })

  it('exits 0 when Playwright does', async () => {
    vi.mocked(run).mockResolvedValue({ runId: 'r', exitCode: 0, passed: 2, failures: [], staleWarnings: [] } as never)
    expect(await main(['run'])).toBe(0)
  })
})

describe('triage', () => {
  it('prints a line per verdict, skipped reasons, and the not-live note; exits 0 even for app-broken', async () => {
    vi.mocked(triage).mockResolvedValue({
      runId: 'r',
      live: false,
      records: [
        { spec: 'auth/login', failure: 'auth/login::chromium::valid', verdict: { kind: 'app-broken', evidence: 'dashboard 500s' } },
        { spec: 'cart', failure: 'cart::chromium::add', verdict: { kind: 'test-broken', cause: 'spec-wrong', evidence: 'renamed' } },
      ],
      skipped: [{ failure: 'cart::chromium::old', reason: 'already-triaged' }],
    } as never)
    expect(await main(['triage'])).toBe(0)
    expect(stdout).toContain(' APP BUG  auth/login › valid\n    The app is broken; the test is right. Fix the app.\n    dashboard 500s')
    expect(stdout).toContain(' TEST BUG  cart › add\n    The app changed on purpose; the spec is out of date.')
    expect(stdout).toContain('skipped cart::chromium::old: already triaged (pass --force to redo)')
    expect(stdout).toContain('not reachable')
    expect(stdout).toContain('2 triaged: 1 app bug, 1 test bug, 0 unsure; 1 skipped')
    expect(stdout).not.toContain('\x1b[')
  })

  it('colors the verdict badge when color is forced', async () => {
    vi.stubEnv('FORCE_COLOR', '1')
    vi.mocked(triage).mockResolvedValue({
      runId: 'r',
      live: true,
      records: [{ spec: 'a', failure: 'a::chromium::s', verdict: { kind: 'app-broken', evidence: 'e' } }],
      skipped: [],
    } as never)
    try {
      await main(['triage'])
    } finally {
      vi.unstubAllEnvs()
    }
    expect(stdout).toMatch(/\x1b\[7m\x1b\[1m\x1b\[31m APP BUG /)
  })

  it('wraps long evidence under the verdict', async () => {
    vi.mocked(triage).mockResolvedValue({
      runId: 'r',
      live: true,
      records: [{ spec: 'a', failure: 'a::chromium::s', verdict: { kind: 'inconclusive', evidence: 'word '.repeat(60).trim() } }],
      skipped: [],
    } as never)
    await main(['triage'])
    const evidence = stdout.split('\n').filter((l) => l.startsWith('    word'))
    expect(evidence.length).toBeGreaterThan(1)
    for (const line of evidence) expect(line.length).toBeLessThanOrEqual(100)
  })
})

describe('fix', () => {
  const proposal: FixProposal = { kind: 'regenerate', spec: 'cart' as never, reason: 'brittle' }
  const report = (over: Record<string, unknown> = {}) =>
    ({ applied: [proposal], declined: [], unresolved: [], generated: generated(), ...over }) as never

  it('--yes approves every proposal', async () => {
    vi.mocked(fix).mockImplementation(async (options) => {
      expect(await options.confirm(proposal)).toBe(true)
      return report()
    })
    expect(await main(['fix', '--yes'])).toBe(0)
    expect(stdout).toContain('applied   regenerate cart')
    expect(stdout).toContain('regeneration:')
  })

  it('declines everything and says so without a TTY and without --yes', async () => {
    const isTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      vi.mocked(fix).mockImplementation(async (options) => {
        expect(await options.confirm(proposal)).toBe(false)
        return report({ applied: [], declined: [proposal] })
      })
      expect(await main(['fix'])).toBe(0)
      expect(stderr).toContain('no TTY')
      expect(stdout).toContain('declined  regenerate cart')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true })
    }
  })

  it('exits 1 when a proposal is unresolved', async () => {
    vi.mocked(fix).mockResolvedValue(report({ applied: [], unresolved: [{ spec: 'a', detail: 'unreachable' }] }))
    expect(await main(['fix', '--yes'])).toBe(1)
    expect(stdout).toContain('unresolved a: unreachable')
  })
})

describe('errors and usage', () => {
  it('exits 2 for an unknown command and prints usage', async () => {
    expect(await main(['bogus'])).toBe(2)
    expect(stderr).toContain('unknown command: bogus')
    expect(stderr).toContain('usage:')
  })

  it('exits 2 for no command and for an unknown flag', async () => {
    expect(await main([])).toBe(2)
    expect(await main(['generate', '--nope'])).toBe(2)
    expect(stderr).toContain('usage:')
    expect(generate).not.toHaveBeenCalled()
  })

  it('rejects -- on commands other than run', async () => {
    expect(await main(['generate', '--', '--x'])).toBe(2)
  })

  it('prints SpecError, AgentSetupError and config errors as messages without stacks, exit 2', async () => {
    vi.mocked(generate).mockRejectedValueOnce(new SpecError([{ file: 'a.md', line: 3, message: 'bad heading' }]))
    expect(await main(['generate'])).toBe(2)
    expect(stderr).toContain('a.md:3: bad heading')

    stderr = ''
    vi.mocked(triage).mockRejectedValueOnce(new AgentSetupError('claude', 'claude SDK not installed'))
    expect(await main(['triage'])).toBe(2)
    expect(stderr).toContain('claude SDK not installed')

    stderr = ''
    vi.mocked(run).mockRejectedValueOnce(new Error('No libretto.config.ts found'))
    expect(await main(['run'])).toBe(2)
    expect(stderr).toBe('No libretto.config.ts found\n')
    expect(stderr).not.toContain(' at ')
  })
})
