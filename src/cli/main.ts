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
import { fix, generate, run, triage, type FixProposal } from '../index.js'

export async function main(argv: readonly string[]): Promise<number> {
  void fix
  void generate
  void run
  void triage
  throw new Error('not implemented')
}

/** Prints the proposal (diff for edit-spec) and reads y/N from stdin. */
async function ttyConfirm(proposal: FixProposal): Promise<boolean> {
  throw new Error('not implemented')
}
void ttyConfirm

process.exitCode = await main(process.argv.slice(2))
