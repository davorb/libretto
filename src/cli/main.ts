#!/usr/bin/env node
/**
 * The `libretto` bin. A thin shell over the public API: parse argv (`node:util` parseArgs),
 * call one command, print its report, set the exit code. No logic that a library caller
 * would also need lives here.
 *
 *   libretto generate [spec...] [--force]
 *   libretto run      [spec...] [-- <playwright args>]
 *   libretto triage   [spec...] [--force]
 *   libretto fix      [spec...] [--yes]
 *   common: --config <path>  --verbose
 *
 * Exit codes:
 *   generate: 0 if nothing failed, 1 if any spec failed
 *   run:      Playwright's exit code
 *   triage:   0 when verdicts were written (an app-broken verdict is a result, not a CLI error)
 *   fix:      0, or 1 if any proposal was unresolved
 *   any:      2 for SpecError / config errors / AgentSetupError (printed in full, no stack)
 *
 * `fix` without a TTY and without `--yes` declines every proposal and says why. It
 * never applies silently.
 */
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { fix, generate, run, triage, type CommandOptions, type FixProposal, type FixReport, type GenerateReport, type RunReport, type TriageReport } from '../index.js'
import { consoleLogger } from '../log/index.js'

const USAGE = `usage:
  libretto generate [spec...] [--force]
  libretto run      [spec...] [-- <playwright args>]
  libretto triage   [spec...] [--force]
  libretto fix      [spec...] [--yes]
common: --config <path>  --verbose
`

const out = (line = '') => void process.stdout.write(`${line}\n`)
const err = (line: string) => void process.stderr.write(`${line}\n`)

function printGenerate(report: GenerateReport): void {
  for (const w of report.written) out(`written  ${w.spec}${w.replaced === 'missing' ? '' : ` (was ${w.replaced})`}`)
  for (const id of report.fresh) out(`fresh    ${id}`)
  for (const f of report.failed) out(`failed   ${f.spec}: ${f.reason}${f.detail ? ` - ${f.detail}` : ''}`)
  out(`${report.written.length} written, ${report.fresh.length} fresh, ${report.failed.length} failed`)
}

function printRun(report: RunReport): void {
  for (const w of report.staleWarnings) out(`stale: ${w.spec} is ${w.staleness}`)
  out(`${report.passed} passed, ${report.failures.length} failed (playwright exit code ${report.exitCode})`)
  for (const f of report.failures) out(`  FAIL ${f.spec} › ${f.scenario}: ${f.error.message.split('\n')[0] ?? ''}`)
}

function printTriage(report: TriageReport): void {
  for (const r of report.records) {
    const { verdict } = r
    const kind = verdict.kind === 'test-broken' ? `test-broken (${verdict.cause})` : verdict.kind
    const scenario = r.failure.split('::').slice(2).join('::')
    out(`${r.spec} › ${scenario}: ${kind} - ${verdict.evidence}`)
  }
  for (const s of report.skipped) out(`skipped ${s.failure}: ${s.reason}`)
  if (!report.live) out('note: the app was not reachable, verdicts use recorded artifacts only')
  out(`${report.records.length} triaged, ${report.skipped.length} skipped`)
}

function printFix(report: FixReport): void {
  for (const p of report.applied) out(`applied   ${p.kind} ${p.spec}`)
  for (const p of report.declined) out(`declined  ${p.kind} ${p.spec}`)
  for (const u of report.unresolved) out(`unresolved ${u.spec}: ${u.detail}`)
  if (report.applied.length > 0) {
    out('regeneration:')
    printGenerate(report.generated)
  }
  if (report.applied.length + report.declined.length + report.unresolved.length === 0) out('nothing to fix')
}

/** Prints the proposal (diff for edit-spec) and reads y/N from stdin. */
async function ttyConfirm(proposal: FixProposal): Promise<boolean> {
  if (proposal.kind === 'edit-spec') {
    out(`\nEdit ${proposal.spec}: ${proposal.summary}`)
    out(proposal.diff)
  } else {
    out(`\nRegenerate ${proposal.spec}: ${proposal.reason}`)
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('Apply? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const split = argv.indexOf('--')
  const own = split < 0 ? argv : argv.slice(0, split)
  const passthrough = split < 0 ? [] : argv.slice(split + 1)

  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(own)
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    err(USAGE)
    return 2
  }
  const { values, positionals } = parsed
  const [command, ...specs] = positionals
  if (values.help) {
    out(USAGE)
    return 0
  }
  if (command === undefined || !['generate', 'run', 'triage', 'fix'].includes(command)) {
    err(command === undefined ? 'missing command' : `unknown command: ${command}`)
    err(USAGE)
    return 2
  }
  if (passthrough.length > 0 && command !== 'run') {
    err('arguments after `--` are only accepted by `run`')
    err(USAGE)
    return 2
  }

  const common: CommandOptions = {
    specs,
    log: consoleLogger({ verbose: values.verbose === true }),
    ...(values.config === undefined ? {} : { config: values.config }),
  }

  try {
    switch (command) {
      case 'generate': {
        const report = await generate({ ...common, force: values.force === true })
        printGenerate(report)
        return report.failed.length > 0 ? 1 : 0
      }
      case 'run': {
        const report = await run({ ...common, playwrightArgs: passthrough })
        printRun(report)
        return report.exitCode
      }
      case 'triage': {
        printTriage(await triage({ ...common, force: values.force === true }))
        return 0
      }
      default: {
        const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
        if (values.yes !== true && !interactive) {
          err('no TTY and no --yes: declining every proposal. Re-run in a terminal, or pass --yes to apply without asking.')
        }
        const confirm = values.yes === true ? async () => true : interactive ? ttyConfirm : async () => false
        const report = await fix({ ...common, confirm })
        printFix(report)
        return report.unresolved.length > 0 ? 1 : 0
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      err(error.message)
      if (values.verbose === true && error.stack) err(error.stack)
    } else {
      err(String(error))
    }
    return 2
  }
}

function parse(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      force: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      config: { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
