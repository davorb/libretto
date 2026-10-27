# Module map

Every module is a directory with an `index.ts` barrel. Cross-module imports go through `../<module>/index.js` only. An eslint `no-restricted-imports` pattern (`../*/!(index).js`) fails the build on a deep import. For consumers, `package.json#exports` exposes `.`, `./test`, and `./reporter`, so nothing else resolves.

| Module | Owns |
| --- | --- |
| `agent/` | The only AI seam: `AgentRunner`, `AgentTask<R>`, `LibrettoTool`, `Submission`, `Secrets`, and both SDK adapters. Internal: `harness.ts` (neutral tool wrapping, outcome box, result mapping) and `playwright-mcp.ts` (the one MCP launch spec, the only caller of `unseal`). |
| `config/` | `defineConfig` (backend-generic types), loading and Zod-parsing `libretto.config.ts`, resolving per-command `AgentProfile`s. |
| `spec/` | Markdown grammar, `Suite` (resolved `uses`, cycle rejection, Merkle hashes, selectors, `withEdit`), and the step-title encoding shared by the renderer and reporter. |
| `workspace/` | The `.libretto/` layout, the generated-file header, staleness, atomic writes, and the record schemas (`RunRecord`, `TriageLog`, `Verdict`) that commands exchange. The only writer of `specs/` and `.libretto/`. |
| `project/` | `openProject`: config + suite + workspace + agent, loaded once per command. `RunContext` (the AI-free subset). |
| `log/` | `Logger` and the console implementation. |
| `generate/` | `libretto generate`: ordering (fixtures first), the `write_test` submission, the draft schema and pure renderer, and the generation prompt. |
| `run/` | `libretto run`: the wrapper Playwright config, spawning `playwright test`, `runDraft` and `prepareStorageState` for generate, and the `libretto/reporter` that writes `last-run.json`. Takes only `RunContext`. |
| `test/` | `libretto/test`: the import for generated code, with an auto fixture that attaches the DOM snapshot on failure. |
| `triage/` | `libretto triage`: evidence loading (trace, screenshots, DOM), evidence tools, `submit_verdict`, reachability probe, and `verdictFrom`. |
| `fix/` | `libretto fix`: pending-record derivation, proposals, `propose_spec_edit`, confirm-then-apply, and one regeneration pass. |
| `cli/` | The `libretto` bin. Parses argv, calls the public API, prints, and sets the exit code. |
| `index.ts` | The public API. Re-exports only what the Usage section shows. |

Dependency direction (no cycles): `cli → index → {generate, run, triage, fix} → project → {config, spec, workspace, agent, log}`. `fix → generate → run`. `config → agent` (types only). `workspace → spec` (types only). `agent` depends on nothing in the repo.

## Call chains

### `libretto generate [spec...]`

1. `cli/main.ts` `main` → `generate({ specs, force })`
2. `generate/index.ts` `generate` → `project/index.ts` `openProject` → `config/load.ts` `loadConfig`, `spec/suite.ts` `loadSuite`, `workspace/workspace.ts` `openWorkspace`
3. `generate/index.ts` `generateSpecs`: topological order, fixtures first → for each spec, `generate/generator.ts` `generateOne`:
   - `workspace.staleness(spec)`. If `fresh`, skip.
   - `Secrets.fromEnv(spec.envRefs)` (`agent/secrets.ts`)
   - `run/playwright.ts` `prepareStorageState(chain)`, which spawns the fixture setup projects
   - `writeTestSubmission` + `generationTask` → `project.agent.run(task)`
     - `agent/claude.ts` or `agent/copilot.ts` `run` → `agent/harness.ts` `openSession` → `agent/playwright-mcp.ts` `playwrightMcp`
     - the agent explores, then calls `write_test` → `accept`: `generate/draft.ts` `checkDraft`, `renderTest` → `secrets.findLeak` → `run/playwright.ts` `runDraft` (writes `.libretto/drafts/…`, spawns Playwright)
   - submitted → `workspace.writeGenerated` (header added, atomic, warns on `hand-edited`)
4. `cli/main.ts` prints the `GenerateReport`.

### `libretto run [spec...]`

1. `cli/main.ts` → `run({ specs, playwrightArgs })`
2. `run/index.ts` `run` → `openProject` → `suite.select` + fixture chains → `workspace.staleness` for each spec → `staleWarnings`
3. `run/playwright.ts` `writeWrapperConfig({ kind: 'suite' })` → `.libretto/playwright.config.ts`
4. `run/playwright.ts` `spawnPlaywright`, which runs `playwright test -c .libretto/playwright.config.ts`
   - in Playwright's process: `run/reporter.ts` `LibrettoReporter` → `workspace.parseHeader` + `spec.parseStepTitle` → `workspace.mergeLastRun` (per-test merge, so a partial run keeps earlier failures)
5. `run/index.ts` → `workspace.readLastRun` → `RunReport`. The CLI exits with Playwright's code.

No file in this chain imports `agent/`.

### `libretto triage [spec...]`

1. `cli/main.ts` → `triage({ specs, force })`
2. `triage/index.ts` `triage` → `openProject` → `workspace.readLastRun`, `workspace.readTriage` → skip already-triaged failures and failures whose spec/generated hash moved since the run → `triage/triager.ts` `probe(baseURL)`
3. for each failure, `triage/triager.ts` `triageOne`:
   - `triage/artifacts.ts` `loadEvidence` → `evidenceTools`
   - `triageTask` (with `browser: null` when not live) + `submitVerdict` → `project.agent.run(task)` → `agent/*` as above
   - `verdictFrom(result)` → `TriageRecord` (with an artifacts-only prefix when not live)
   - `triage/index.ts` → `workspace.writeTriage` after each failure
4. `cli/main.ts` prints the verdicts.

### `libretto fix [spec...]`

1. `cli/main.ts` → `fix({ specs, confirm: ttyConfirm | approveAll })`
2. `fix/index.ts` `fix` → `openProject` → `workspace.readTriage` → `fix/fixer.ts` `pendingRecords` (compares against `workspace.stamp` and `spec.hash`)
3. group by spec:
   - spec-wrong → `fixer.ts` `specEditTask` + `proposeSpecEdit` (`accept` → `suite.withEdit`) → `project.agent.run` → `edit-spec` proposal
   - otherwise → `regenerate` proposal (no agent)
4. `confirm(proposal)` → `workspace.writeSpec` for approved edits
5. reload the suite → `generate/index.ts` `generateSpecs(approved, { force, hints })`, which follows the generate chain from step 3 on
6. `cli/main.ts` prints the `FixReport`.
