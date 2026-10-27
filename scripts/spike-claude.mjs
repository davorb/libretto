// Backend spike: one agent task against Playwright MCP, on the Claude runner.
//
// Proves, end to end: the SDK loads and authenticates (CLI login, no API key), built-ins
// are off, Playwright MCP attaches, a secret is typed by name and never seen by the
// model, and the task ends through a Submission. Run after `pnpm build`:
//
//   SPIKE_SECRET=hunter2-very-secret node scripts/spike-claude.mjs
//
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { ClaudeRunner, Secrets } from '../dist/index.js'

const SECRET_NAME = 'SPIKE_SECRET'
if (!process.env[SECRET_NAME]) {
  console.error(`Set ${SECRET_NAME} first.`)
  process.exit(2)
}

// A one-page app: a password form that says "unlocked" only for the right value.
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const ok = url.searchParams.get('password') === process.env[SECRET_NAME]
  res.setHeader('content-type', 'text/html')
  res.end(`<!doctype html><title>Spike</title>
    <h1>${ok ? 'unlocked' : 'locked'}</h1>
    <form method="get">
      <label>Password <input name="password" type="password"></label>
      <button type="submit">Unlock</button>
    </form>`)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${server.address().port}/`

const { secrets } = Secrets.fromEnv([SECRET_NAME], process.env)
const outputDir = mkdtempSync(path.join(tmpdir(), 'libretto-spike-'))
const events = []
let sawSecretInTranscript = false
const secretValue = process.env[SECRET_NAME]

const submit = {
  name: 'submit_result',
  description: 'Report what the page heading says after you submit the form. Call exactly once.',
  input: z.object({ heading: z.string(), typedSecretByName: z.boolean() }),
  async accept(input) {
    if (input.heading !== 'unlocked') return { ok: false, feedback: `Heading was "${input.heading}", expected "unlocked". Did you type the secret by its bare name?` }
    return { ok: true, value: input }
  },
}

const task = {
  label: 'spike',
  system: 'You are driving a browser through Playwright MCP tools. Use only the tools provided. Be brief.',
  prompt: [
    `Open ${baseURL} . There is a password form. Secrets available by name: ${SECRET_NAME}.`,
    `To enter the secret, call browser_type with text set to exactly "${SECRET_NAME}" (the bare name); the browser substitutes the value.`,
    'Submit the form, read the <h1> heading, then call submit_result with the heading text and whether you typed the secret by name.',
  ].join(' '),
  tools: [],
  submit,
  browser: { baseURL, secrets, storageState: null, headless: true, outputDir },
  profile: { model: 'claude-sonnet-5-5', maxTurns: 15, maxBudgetUsd: 1 },
  cwd: process.cwd(),
  onEvent: (e) => {
    events.push(e)
    const s = JSON.stringify(e)
    if (s.includes(secretValue)) sawSecretInTranscript = true
    console.log('[event]', s.slice(0, 200))
  },
}

const started = Date.now()
try {
  const result = await new ClaudeRunner().run(task)
  console.log('\nresult:', JSON.stringify(result, null, 2))
  console.log('elapsed s:', ((Date.now() - started) / 1000).toFixed(1))
  console.log('secret value seen in any event:', sawSecretInTranscript)
  console.log('playwright tool calls:', events.filter((e) => e.type === 'tool-call' && e.server === 'playwright').map((e) => e.tool).join(' '))
  process.exitCode = result.status === 'submitted' && !sawSecretInTranscript ? 0 : 1
} catch (error) {
  console.error('FAILED:', error)
  process.exitCode = 1
} finally {
  server.close()
}
