import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ACCEPTED, ALREADY_SUBMITTED, openSession } from './harness.js'
import { Secrets } from './secrets.js'
import type { AgentEvent, AgentTask, LibrettoTool, Submission } from './types.js'

const echo: LibrettoTool<{ text: string }> = {
  name: 'echo',
  description: 'echoes',
  input: z.object({ text: z.string() }),
  handler: async ({ text }) => `echo: ${text}`,
}

const boom: LibrettoTool<{ n: number }> = {
  name: 'boom',
  description: 'throws',
  input: z.object({ n: z.number() }),
  handler: async () => {
    throw new Error('kaboom with hunter2-long inside')
  },
}

function submitEven(): Submission<{ n: number }, number> {
  return {
    name: 'submit_even',
    description: 'submit an even number',
    input: z.object({ n: z.number() }),
    accept: async ({ n }) => (n % 2 === 0 ? { ok: true, value: n } : { ok: false, feedback: `${n} is odd` }),
  }
}

function task(overrides: Partial<AgentTask<number>> = {}): AgentTask<number> {
  return {
    label: 't',
    system: 's',
    prompt: 'p',
    tools: [echo, boom],
    submit: submitEven(),
    browser: null,
    profile: { model: 'm', maxTurns: 5, maxBudgetUsd: null },
    cwd: process.cwd(),
    ...overrides,
  }
}

describe('openSession', () => {
  it('rejects malformed and duplicate tool names at setup', () => {
    expect(() => openSession(task({ tools: [{ ...echo, name: 'Bad-Name' }] }), 'x')).toThrow(/Invalid tool name/)
    expect(() => openSession(task({ tools: [echo, { ...boom, name: 'echo' }] }), 'x')).toThrow(/Duplicate/)
    expect(() => openSession(task({ tools: [{ ...echo, name: 'submit_even' }] }), 'x')).toThrow(/Duplicate/)
  })

  it('parses input, captures handler errors, and never throws from invoke', async () => {
    const s = openSession(task(), 'x')
    const [e, b] = s.tools
    expect(await e!.invoke({ text: 'hi' })).toBe('echo: hi')
    expect(await e!.invoke({ nope: 1 })).toMatch(/^Invalid input: text:/)
    expect(await b!.invoke({ n: 1 })).toMatch(/^Tool error: kaboom/)
  })

  it('settles on the first accepted submission and refuses later ones', async () => {
    const s = openSession(task(), 'x')
    const submit = s.tools.find((t) => t.name === 'submit_even')!
    expect(await submit.invoke({ n: 3 })).toBe('3 is odd')
    expect(s.settled).toBe(false)
    expect(await submit.invoke({ n: 4 })).toBe(ACCEPTED)
    expect(s.settled).toBe(true)
    expect(await submit.invoke({ n: 6 })).toBe(ALREADY_SUBMITTED)
    expect(s.finish('turn-cap', { turns: 2, costUsd: 0.1 }, 'ignored')).toEqual({ status: 'submitted', value: 4, usage: { turns: 2, costUsd: 0.1 } })
  })

  it('puts the reply the agent got into each failed tool-result event', async () => {
    const events: AgentEvent[] = []
    const s = openSession(task({ onEvent: (e) => events.push(e) }), 'x')
    const [e, b] = s.tools
    const submit = s.tools.find((t) => t.name === 'submit_even')!
    await e!.invoke({ text: 'hi' })
    await b!.invoke({ n: 1 })
    await submit.invoke({ n: 3 })
    expect(events.filter((ev) => ev.type === 'tool-result')).toEqual([
      { type: 'tool-result', server: 'libretto', tool: 'echo', ok: true },
      { type: 'tool-result', server: 'libretto', tool: 'boom', ok: false, reason: 'Tool error: kaboom with hunter2-long inside' },
      { type: 'tool-result', server: 'libretto', tool: 'submit_even', ok: false, reason: '3 is odd' },
    ])
  })

  it('reports unsubmitted with the stop reason', () => {
    const s = openSession(task(), 'x')
    expect(s.finish('ended', { turns: 1, costUsd: null }, 'gave up')).toEqual({ status: 'unsubmitted', reason: 'ended', lastText: 'gave up', usage: { turns: 1, costUsd: null } })
  })

  it('redacts secret values from events, replies, errors, and lastText', async () => {
    const { secrets } = Secrets.fromEnv(['P'], { P: 'hunter2-long' })
    const events: AgentEvent[] = []
    const s = openSession(
      task({
        browser: { baseURL: 'http://x', secrets, storageState: null, headless: true, outputDir: '/tmp/libretto-test-unused' },
        onEvent: (e) => events.push(e),
      }),
      'x',
    )
    const [e, b] = s.tools
    expect(await e!.invoke({ text: 'pw is hunter2-long' })).toBe('echo: pw is {{env.P}}')
    expect(await b!.invoke({ n: 1 })).toBe('Tool error: kaboom with {{env.P}} inside')
    s.emit({ type: 'text', text: 'I typed hunter2-long' })
    expect(JSON.stringify(events)).not.toContain('hunter2-long')
    expect(s.finish('ended', { turns: 1, costUsd: null }, 'hunter2-long')).toMatchObject({ lastText: '{{env.P}}' })
    await s.cleanup()
  })
})
