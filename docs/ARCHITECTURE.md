# Libretto: architecture

## Problem

Libretto turns markdown specs into committed Playwright Test code, runs it, and when a test fails, diagnoses and repairs it with an AI agent. The design needs to hold several constraints at once. Two agent SDKs with different run loops, tool naming, permission models, and limits must sit behind one seam (`AgentRunner`). The agent gets no vendor built-ins, only Playwright MCP plus Libretto tools. Secrets must reach the browser but never the prompt, the transcript, or git. `run` must never touch AI. A failure must map back to a specific spec step. The four commands talk only through files (`.libretto/generated/**`, `last-run.json`, `triage.json`), so each one can run alone and can run again safely. The repo is greenfield, so the only outside contracts are the two SDKs, `@playwright/test`, and Playwright MCP.

## Usage (caller's view)

### README quickstart

```sh
pnpm add -D libretto @playwright/test
pnpm add -D @anthropic-ai/claude-agent-sdk     # or: @github/copilot-sdk
```

```ts
// libretto.config.ts
import { defineConfig } from 'libretto'

export default defineConfig({
  baseURL: 'http://localhost:3000',
  agent: { backend: 'claude', model: 'claude-sonnet-5-5', maxTurns: 40, maxBudgetUsd: 2 },
  generate: { model: 'claude-opus-5-5', maxBudgetUsd: 5 },
  triage: { model: 'claude-opus-5-5' },
})
```

```ts
// With Copilot, the budget keys don't exist. This is a type error, not a silent no-op:
export default defineConfig({
  baseURL: 'http://localhost:3000',
  agent: { backend: 'copilot', model: 'gpt-5', maxTurns: 30 },
  generate: { maxBudgetUsd: 5 },   // ✗ 'maxBudgetUsd' does not exist in type CopilotLimits
})
```

```sh
pnpm dev &                 # you start the app; Libretto never does
libretto generate          # explores the app, writes .libretto/generated/**, only for stale specs
libretto run               # playwright test over generated files; writes .libretto/last-run.json
libretto triage            # after a red run: verdict per failure in .libretto/triage.json
libretto fix               # proposes repairs for test-broken failures, asks y/N, then regenerates
```

Add `.libretto/drafts/`, `.libretto/state/`, `.libretto/last-run.json`, and `.libretto/triage.json` to `.gitignore`. Commit `.libretto/generated/`.

### Call site 1: a CI job that runs, then triages only on red

```ts
import { run, triage } from 'libretto'

const result = await run({ playwrightArgs: ['--workers=4'] })
for (const w of result.staleWarnings) console.warn(`${w.spec}: ${w.staleness}, run \`libretto generate\``)

if (result.failures.length > 0) {
  const { records, live } = await triage({ specs: result.failures.map((f) => f.spec) })
  if (!live) console.warn('baseURL unreachable; verdicts are from recorded artifacts only')
  for (const r of records) {
    if (r.verdict.kind === 'app-broken') core.error(`${r.failure}: ${r.verdict.evidence}`)
  }
  process.exitCode = 1
}
```

### Call site 2: `fix` with the caller's own approval policy

```ts
import { fix, type FixProposal } from 'libretto'

// `confirm` is required. The API has no "apply without asking" default.
const report = await fix({
  confirm: async (p: FixProposal) =>
    p.kind === 'regenerate' || (await askReviewerInSlack(p.diff, p.summary)),
})
console.log(report.applied.length, 'applied;', report.generated.written.length, 'tests rewritten')
```

### Call site 3: a fake backend in the user's (or our own) vitest suite

```ts
import { generate, type AgentRunner, type AgentTask, type AgentResult } from 'libretto'

/** Submits a canned draft through the task's own submit tool, exactly as a real agent would. */
const scripted = (draft: unknown): AgentRunner => ({
  backend: 'scripted',
  async run<R>(task: AgentTask<R>): Promise<AgentResult<R>> {
    const parsed = task.submit.input.parse(draft)
    const verdict = await task.submit.accept(parsed)
    const usage = { turns: 1, costUsd: 0 }
    return verdict.ok
      ? { status: 'submitted', value: verdict.value, usage }
      : { status: 'unsubmitted', reason: 'ended', lastText: verdict.feedback, usage }
  },
})

test('login spec renders one step per bullet', async () => {
  const report = await generate({ cwd: fixtureRepo, specs: ['auth/login'], agent: scripted(loginDraft) })
  expect(report.written.map((w) => w.spec)).toEqual(['auth/login'])
})
```

The fake runs the real `accept`, which renders the file and runs the draft against the app. A fake can't skip the gate a real agent passes through.

## Shape

**Data structures first.** These are the load-bearing types:

- `Spec` (`spec/types.ts`): `id: SpecId` (branded, `auth/login`), `kind: 'scenario' | 'fixture'`, `scenarios: Scenario[]` with `steps`/`expect` of `Step { ref: StepRef, text, envRefs }`, `uses: SpecId | null` (at most one direct fixture; chains compose), `hash: SpecHash`. A `Spec` exists only inside a `Suite`. `loadSuite` is the only constructor, so every `Spec` you hold has resolved `uses`, no cycles, and a computed hash. `hash` is a Merkle hash, `sha256(own source, hashes of direct uses)`, so a change to a fixture makes every dependent stale with no extra bookkeeping (per single source of truth).
- `AgentTask<R>` / `AgentResult<R>` (`agent/types.ts`): every agent job has the same shape. The agent explores through Playwright MCP and optional read-only `LibrettoTool`s, and it ends by calling exactly one terminal `Submission<I, R>` whose `accept` turns input into a typed `R`. That is `write_test` for generate, `submit_verdict` for triage, and `propose_spec_edit` for fix. `AgentResult<R>` is `submitted(value) | unsubmitted(reason)`. The spec's rule "no `submit_verdict` → inconclusive" becomes one pure function (`verdictFrom`) over that union, and "budget exhausted" is `reason: 'turn-cap' | 'budget-cap'`.
- `Submission.accept` returns `{ ok: false, feedback }` to keep the session going. That is where validation lives that Zod can't express: draft shape matches the spec, no secret literals, the draft passes against the live app, and the spec edit parses and keeps the suite acyclic. Rejection text goes back to the agent as a tool reply, and the agent retries inside its turn budget.
- `Secrets` (`agent/secrets.ts`): an opaque class whose values sit in a `#private` field. `toString`, `toJSON`, and `inspect` print names only. The one reader is `unseal()`, which the `agent` barrel does not export. Only `playwright-mcp.ts` calls it, and it puts the values into the MCP child's `env`. A prompt builder can't interpolate a secret because it has no path to the string.
- `RenderedTest` and the header (`workspace/header.ts`): the agent never writes a file and never picks a path. `write_test` takes `{ helpers, scenarios: [{ name, steps: string[], expect: string[] }] }`, one code string per spec bullet. `generate/draft.ts` renders the file: imports from `libretto/test`, one `test()` per scenario, one `test.step('Steps 2: Enter username…')` per bullet, and `test.use({ storageState })` from the fixture chain. The workspace adds the header with the spec hash and a body hash. This makes three invariants true by construction rather than by review: failure-to-step mapping, the write-path restriction the spec puts in the `write_test` handler, and the "DO NOT EDIT" header.
- `RunRecord` / `FailureRecord` / `TriageRecord` (`workspace/records.ts`): the on-disk contracts between commands, defined as Zod schemas next to the only module that reads and writes them. Each record carries the `{ specHash, bodyHash }` of the generated file it ran against. `fix` uses those hashes to tell when a verdict has already been acted on, with no "resolved" flag to keep in sync (per make-operations-idempotent).

**Flow.** `cli/main.ts` → one of `generate | run | triage | fix` (each `index.ts` holds the command, so it is one file) → `openProject` (config + suite + workspace + lazy agent) → the command's worker file → `AgentRunner.run`. `fix` reuses `generateSpecs`. `generate` reuses `runDraft` and `prepareStorageState` from `run`. No call chain needs more than three files to trace (per minimize-reader-load).

**The agent seam.** `ClaudeRunner` and `CopilotRunner` each fit in one file, and each only adapts. `agent/harness.ts` holds everything vendor-neutral, and both runners call it: name validation, Zod parsing of tool input, handler error capture, the first-accepted-submission-wins `OutcomeBox`, event emission, and the final `AgentResult` mapping. `agent/playwright-mcp.ts` builds the one MCP launch spec both use. The runners own only what differs: the run loop, the `tools: []` / `availableTools` lockdown, prefix mapping (`mcp__libretto__x`, `libretto-x`), permission callbacks (allow attached, deny everything else), cancellation, and turn counting. Copilot has no cap, so `CopilotRunner` counts `assistant.turn_start` and calls `session.abort()`. Claude reports `error_max_turns` / `error_max_budget_usd`, and the runner maps them. `ClaudeRunner` also sets `settingSources: []`, so the user's `~/.claude` settings, hooks, and CLAUDE.md never enter a Libretto session. Nothing outside `agent/` sees a vendor type or a prefixed tool name (per boundary-discipline; no wire types on the public API).

**Invariants encoded in types:**
- `defineConfig<B>` is generic on the backend, so `maxBudgetUsd` exists only when `backend: 'claude'`. `AgentProfile.maxBudgetUsd: number | null` is `null` for Copilot by construction.
- `run` and its helpers take `RunContext = Omit<Project, 'agent'>`, so "run never calls AI" is a compile error to violate, not a convention.
- `FixOptions.confirm` is required, so "asks before applying" holds for every caller, not only the CLI.
- `BrowserTarget | null` on the task: triage passes `null` when `baseURL` is unreachable. The agent then has no browser tools, and the triager stamps `live: false` plus an evidence prefix itself, so it doesn't rely on the agent to say so.
- `Spec` has no public constructor, and `Suite.withEdit` is the only way to get a suite that contains a modified spec.

**Validation at boundaries:** config (Zod over the imported module), spec markdown (`loadSuite` collects every issue with file:line and throws one `SpecError`), JSON records (Zod on read), tool input (Zod in the harness), and agent output (`accept`). Code inside those boundaries trusts its types.

**Interface depth.** The public surface is `defineConfig`, `generate`, `run`, `triage`, `fix`, the `AgentRunner` / `AgentTask` / `LibrettoTool` / `Submission` types (so callers can bring a backend), `ClaudeRunner`, `CopilotRunner`, the report and record types, and two subpaths (`libretto/test` for generated code, `libretto/reporter` for the wrapper config). Behind it sit staleness, Merkle hashing, fixture setup projects and `storageState`, the wrapper Playwright config, draft verification against the live app, trace summarization, secret handling, and both SDKs. A custom backend implements one method, `run<R>(task)`.

**What it deliberately does not do:** abstract Playwright MCP's tool names, start the app, run triage on its own, edit generated files except by regenerating, retry an agent session, or run generation in parallel (v1 is sequential, and per-actor browser state makes parallel generation a later change that needs no lock).

## Synthesis decision

Four candidates were produced independently (pstack arena, 2026-10-27) and scored on vendor containment, interface depth, ownership, invariants in types, idempotency, and reader load. The orchestrator and an independent cross-judge both picked this candidate as the base; the runner-up tied on score. Base ideas kept as the skeleton: one typed `Submission<I,R>` per task with `accept` as the validation gate, the per-bullet renderer, sealed `Secrets`, `RunContext` without an agent, and the wrapper Playwright config with fixture setup projects.

Grafted from the runner-up: `app.md` enters staleness through an `appHash` stamped on every generated file (`Staleness` gains `app-changed`); `last-run.json` is merged per test so a partial run keeps earlier failures triageable; `triage` skips, with a reason, failures whose spec or generated body changed since the run; the harness redacts secret values from every event and tool reply. Grafted from the others: `secretUsageInstructions` lives next to `playwrightMcp` so prompt text and delivery mechanism cannot drift; the Claude subprocess env is stripped of secret names; a stdio shim is the documented fallback if Playwright MCP's `--secrets` does not cover the spike.

Rejected: `endsSession` tools that abort the vendor session from inside a handler (race risk; the `settled` flag plus "end your turn" reply does the same without it); vendor structured output for verdicts; a `fix`/`apply` two-step public API (the required `confirm` callback already puts the question at the type boundary); separate top-level `state/`, `verdict/`, `layout/` modules (shallow); `--reporter` injection (drops user reporters).

## Tradeoffs accepted

- We accept that the agent can't write arbitrary file structure (only `helpers` plus one code string per bullet) in exchange for step mapping, the header, and the path restriction that can't be broken. A spec whose natural test doesn't fit "one block per bullet" has to be rephrased.
- We accept that `write_test` runs the draft against the live app inside `accept` (slower, and generation needs the app up) in exchange for never committing a test that has not passed once. If the app is broken while generating, generation fails, which is correct.
- We accept that a fixture change regenerates every dependent (Merkle hash) in exchange for never running a dependent test against a stale setup.
- We accept that an `app.md` edit marks the whole suite `app-changed` and `generate` regenerates everything, in exchange for never shipping tests built from stale app context. The reason is named per file, and `generate --force` is not needed to pick it up.
- We accept that a scenario spec has at most one direct `uses` entry (compose fixtures by chaining) in exchange for one `storageState` per test, with no state merging.
- We accept that `ToolReply` widens the spec's `Promise<string>` to `string | { text, images }` in exchange for triage being able to show the agent its screenshots.
- We accept that `libretto.config.ts` needs Node ≥ 22.18 (native type stripping) in exchange for no `jiti`/`tsx` dependency.
- We accept sequential `generate` and `triage` in v1 in exchange for log output a human can follow. The state is per-actor already, so concurrency is a loop change later.
- We accept that the record types live in `workspace` instead of their producing command, because the file is the interface between commands, and the module that owns the file owns its schema.

## Alternatives considered

- **Free-form `write_test({ path, code })` plus a path-guard handler (the spec's literal sketch).** The interface is smaller for the agent, but step mapping, the header, and env handling become things the reporter has to recover by parsing agent-written code. The complexity lands in three places (prompt, validator, reporter) instead of one renderer. It lost on information leakage.
- **Structured output for verdicts, with tools only for side effects.** The spec rules this out for Copilot. The general form, one `Submission<I, R>` per task, does better: it turns three different "how does this task end" mechanisms into one, and it gives the runner a typed result without the runner knowing the task's meaning.
- **A class per command (`new Generator(cfg).generate()`, `new Triager(...)`) wired by a DI container.** This exposes construction order and dependencies to every caller and to the CLI. Plain async functions over `openProject` hide that. Tests swap the one real seam (`agent`) through options.
- **Programmatic Playwright Test invocation instead of spawning `playwright test` with a generated wrapper config.** Playwright has no stable public in-process runner API. The wrapper config keeps the user's `playwright.config` settings and makes our reporter and fixture projects additive.

## Implementation reconciliation

- 2026-10-27, agent module (harness, secrets, playwright-mcp, ClaudeRunner, CopilotRunner), accepted by the Claude spike (`scripts/spike-claude.mjs`: 7 turns, $0.048, secret typed by name, no value in any event).
  - `Secrets.fromEnv` returns `{ secrets, short }` instead of `Secrets`, so callers can warn about values too short to redact. Local to the constructor; the sealed type is unchanged.
  - `Secrets.redact` added; the harness applies it to every event, reply, error, and `lastText`. `Session` gains `redact` and `cleanup`.
  - `McpServerLaunch` gains `cleanup()` (removes the secrets file) and an internal `ready` promise runners await before spawning.
  - `ClaudeRunner` passes no `allowedTools`: the SDK auto-approves bare entries before `canUseTool`, so the callback alone is the gate. The sketch's "allowedTools plus canUseTool as defense in depth" was wrong about the SDK.
  - `CopilotRunner` expresses the allowlist as `availableTools` = custom names + `mcp:playwright-<tool>` over a static `PLAYWRIGHT_TOOLS` list, because Copilot has no whole-server form. Unverified until the Copilot spike.
- 2026-10-27, spec, workspace, config, project, log, draft renderer, test entry, triage evidence (wave 1, five parallel workers; 112 tests). Accepted by the orchestrator after reading each report and a green `pnpm typecheck && pnpm test`.
  - `ParsedSpec` (internal) gains `usesLine` so unknown-fixture and cycle issues carry a file line.
  - Step titles are `Steps N: <text>` / `Expect N: <text>`; the text is everything after the first `: `, so any bullet round-trips.
  - Fixtures need `Steps` only; scenario files need at least one `Expect` bullet per scenario. A `Steps:`/`Expect:` line outside a scenario is an issue, not silently attached.
  - `renderHeader` returns the whole file (header plus body). `writeGenerated.replaced` is the prior file's staleness measured against the new test's hashes.
  - `mergeLastRun` treats `flaky` like `failures`: entries in `ran` are dropped, the rest kept.
  - A fixture with several scenarios renders each as its own test; the storageState save goes at the end of the last one.
  - Trace parsing follows `parentId` to find the enclosing `test.step` and spans several `.trace` files; `test.step` events label actions rather than appearing as actions. Format assumptions are inferred and documented in `artifacts.ts`; confirm on a real trace.
  - `fflate` added for trace.zip reading.
  - `pnpm typecheck` now also compiles tests and scripts (`tsconfig.test.json`), so the `@ts-expect-error` config test is enforced.
- 2026-10-27, run, triage, generate (wave 2a, three parallel workers; 170 tests). Accepted the same way; `run` has a real Chromium integration test.
  - Resolved per-command profiles live at `config.profiles.{generate,triage,fix}` (the sketch's prose said `config.generate`; the type was right).
  - The wrapper config is one `.mjs` per mode (`playwright.config.mjs`, `playwright.fixtures.config.mjs`, `playwright.draft.config.mjs`), so draft and fixture runs never overwrite the suite wrapper.
  - `libretto/test` and `libretto/reporter` resolve from generated files through a `.libretto/node_modules/libretto/` shim written on every `writeWrapperConfig`, re-exporting the built `dist` by absolute URL. No dependence on the user's install layout.
  - Projects: `setup:<fixtureId>` per fixture and `scenarios` or `scenarios:<innermost fixture>` per distinct chain, so each project has one dependency. The user's `projects` are not multiplied in v1; the wrapper keeps the first project's `use` and warns once (from inside Playwright's process, via `console.warn`, since the user config loads there). Known limitation: relative paths in the user's config resolve against `.libretto/`.
  - `libretto/test` attaches `libretto-dom` as an in-memory body; the reporter persists it to `.libretto/artifacts/<runId>/<id>.dom.json` and records that path. Cleaner would be for `libretto/test` to write the file itself; deferred.
  - `run()` throws if `last-run.json` was not updated during the run (interrupted Playwright), instead of reporting stale failures. `missing` specs appear in `staleWarnings` and are skipped.
  - `triage()` probes once per invocation even when everything is skipped, so `live` is always honest. A failure whose spec is no longer in the suite is skipped as `spec-changed-since-run`.
  - `write_test.accept` redacts secret values from `runDraft` output before returning it as feedback.
  - `AgentResult`'s unsubmitted member is now distributed over `StopReason` (`Unsubmitted<Reason>`), so `verdictFrom`'s `Exclude<…, { reason: 'aborted' }>` excludes what it claims to.
- 2026-10-27, fix and cli (wave 2b; 209 tests), then an end-to-end smoke on `examples/login` through the real CLI on Claude: `generate` (5 turns, accepted on the first draft after the accept gate ran it against the app), `run` green on the healthy app, `run` red on the server with the wrong greeting, `triage` → `app-broken` with evidence from the failure screenshot and ARIA snapshot. Accepted.
  - `specEditTask` and `triageTask` are async: both read the generated file.
  - `proposeSpecEdit` takes the set of failing scenario names (to allow dropping only those) and an `env` for the unknown-secret check.
  - `generateSpecs`'s `force` applies to the whole call. `fix` passes `force: true` for the approved batch; edited specs are stale anyway.
  - `probe` is duplicated in `fix/index.ts` because `triage/index.ts` does not export it. Candidate for a shared `net` helper if a third caller appears.
  - The CLI exits 2 for every thrown `Error` (config errors and "no recorded run" are plain `Error`s), prints stacks only under `--verbose`, and adds `-y`, `-v`, `-h`/`--help`.
  - Generated-file headers now name the spec relative to the project root (`specs/auth/login.md`); the first smoke run printed an absolute path.
  - Observed in the smoke: the triage agent judged from recorded artifacts and chose not to probe the live app even though browser tools were attached, and said so in its evidence. Acceptable; the prompt could insist on probing when the verdict hinges on current behavior.

## Open questions and risks

- ~~How does the agent type a `{{env.X}}` value it never sees?~~ Resolved by the Claude spike (2026-10-27): Playwright MCP's `lookupSecret` swaps the value in when the whole `browser_type`/`browser_fill_form` text equals a secret name, and `redactSecrets` scrubs values from every response, so DOM snapshots reach the model already redacted. The spike typed a secret by name, unlocked the page, and no event carried the value. The stdio shim fallback is not needed. Copilot still has to confirm the same flow.
- Can Copilot's `defineTool` return image content? If not, `view_screenshot` on Copilot falls back to a text description from the DOM snapshot, and `ToolReply` keeps its union.
- Should we reject multiple direct `uses:` entries in v1, or merge storage states?
- How should Libretto handle a user `playwright.config` that defines several projects (browsers)? The sketch crosses each user project with Libretto's setup projects. Is a full matrix what users expect?
- SPEC.md's layout comment says `last-run.json` holds "verdicts consumed by `fix`", but the command table puts verdicts in `triage.json`. The sketch follows the table. Confirm?
- Copilot's event names (`assistant.turn_start`) and `availableTools` semantics are unverified. Both are confined to `agent/copilot.ts`.

## Next implementation step

Build `agent/harness.ts` and `agent/claude.ts` against a one-tool `Submission`, and run them end to end with Playwright MCP. That is the backend spike from open question 1, done in production code.
