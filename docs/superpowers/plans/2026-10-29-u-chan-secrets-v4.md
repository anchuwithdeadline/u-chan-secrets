# U-Chan Secrets V4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide truthful Windows readiness, conservative guided Codex setup, improved native status, and a protected-approval CLI for login success conditions.

**Architecture:** Reuse the TypeScript thin CLI, protocol-3 diagnostics, existing privileged service and native management window. Keep configuration/browser work in the non-elevated desktop process; the service remains the only credential/approval authority. No native helper or state schema change.

**Tech Stack:** Node >=24, TypeScript, existing MCP SDK/Playwright/WinForms, official installed Codex CLI; no new dependency.

**Spec:** [V4 design](../specs/2026-10-29-u-chan-secrets-v4-design.md).

## Global Constraints

- Windows first; Codex-only automatic configuration; macOS runtime unverified.
- Protocol 3 and state schema 3 remain; package source target is 4.0.0.
- No credentials in CLI/config/AI output; no new privilege-bearing IPC or C# helper.
- Default setup is read-only; explicit flags permit narrow changes; never silently elevate.
- Config/browser application refuses elevated callers; preserve custom/unrelated settings and protected service state.
- Timed grants remain 1–1440 integer minutes; new CLI allow defaults to once; existing success semantics remain.
- The user authorized autonomous work. Native inline execution is the assistant's choice; final independent review remains required. Preserve scratch evidence rather than bulk-deleting it.
- Native V3 rerun and physical npm 2FA remain separate release/install gates.

## Review Focus

- CLI/service mismatch or old service without version must not appear ready; Task 1 pins both cases.
- Custom Codex env/args/settings may contain secrets; Task 2 preserves them, refuses overwrite, and checks zero secret text in output.
- Failure after the first config change must preserve unrelated concurrent edits; Task 2 reports partial changes without whole-file rollback.
- Setup started as administrator must not execute user-owned Codex/npx/Chrome; Task 3 checks no mutating or inspecting client executable is invoked.
- Process/configuration observation is not proof of AI-session ownership; Task 3 never claims active-session verification and tests the separate sharing/restart fields.

## File map

Modify `src/core/doctor.ts`, `src/service/doctor.ts`, `src/service/main.ts`, `src/service/manage.ts` and `src/cli.ts` for metadata/commands. Add `src/client/codex-setup.ts`, `src/client/setup.ts` and `src/client/allow.ts`. Use focused tests under `test/`; retain all V3 suites. Only update the existing Chrome launcher for its background-start option. Documentation/package updates finish the branch.

### Task 1: Installed version and native status

**Files:** modify `src/core/doctor.ts`, `src/service/doctor.ts`, `src/service/main.ts`, `src/service/manage.ts`, `src/cli.ts`; tests `test/doctor-v4.test.ts`, `test/manage.test.ts`.

**Interfaces:** `ServiceDiagnostic` adds optional `serviceVersion?: string`, `browser?: DiagnosticState`, `browserEndpoint?:string`; `DoctorDeps` adds optional `clientVersion?: string`, `clientEndpoint?:string`, `elevation?: () => Promise<DiagnosticState>`. Export `safeVersion(value: unknown): string | undefined` and `safeCdpOrigin(value:unknown):string|undefined`. `diagnoseService(home, vault, platform, cdpEndpoint?: string)` reports browser only when supplied. `checkPlaywrightCdp(procs,selfPid,expectedEndpoint?)` and `checkPlaywrightNow(selfPid?,expectedEndpoint?)` compare actual endpoint values when provided; existing callers remain compatible. Include `src/mcp/server.ts` in endpoint-heuristic wiring.

- [ ] Write tests: exact versions pass; 4.0.0 client/3.0.3 service fail; missing/invalid/secret-looking version is unknown without echo; healthy desktop browser does not hide failed/different service browser; unsafe UAC fails; a different CDP value does not pass merely because a flag exists.
- [ ] Run `rtk proxy npx.cmd vitest run test/doctor-v4.test.ts` and observe the missing behavior fail.
- [ ] Add bounded version validation, optional report metadata/checks and safe fixed messages. Real CLI reads its own package version and uses existing UAC inspection; do not mutate registry.
- [ ] Read actual protected package version in service startup, with unknown fallback; include it in diagnostic/capability data. Probe the same endpoint as the service target.
- [ ] Extend management details with service version/browser and fixed next actions; use `SERVICE_DIAGNOSTIC_TIMEOUT_MS` rather than a five-second aggregate race. No native helper changes.
- [ ] Run focused doctor/management suites and build; commit the independently testable change.

### Task 2: Conservative Codex registration

**Files:** create `src/client/codex-setup.ts`; test `test/codex-setup.test.ts`.

**Interfaces:** export `CodexSetupState = 'ready'|'missing'|'needs_update'|'manual'|'unavailable'`; `CodexSetupOptions` carries `apply`, `replaceExisting`, `endpoint`, `nodePath`, `entryPath`, `configDir`. Export `configureCodex(options, deps?)` returning safe `{state, changed, backupPath?, message}`. Dependencies inject bounded argument-array execution, privilege check and filesystem operations as needed; no raw config is returned.

- [ ] Test default read-only inspection, missing registration creation, simple mismatch requiring explicit replacement, disabled/custom/secret-bearing settings preserved, and a second-command failure with partial changes retained. Assert all unrelated fixture entries/bytes remain untouched by this code and no secret sentinel reaches reports/errors/arguments.
- [ ] Run the suite and observe failure before implementation.
- [ ] Use `codex mcp get NAME --json` internally; classify only recognized stdio configurations. Build additions/removals with argv arrays, never a shell/TOML parser. Reject remote/user-info endpoint input.
- [ ] Back up existing config exclusively under its user's `#0 backup` before mutation; refuse redirected backup directory. Default inspection creates no backup or files.
- [ ] Add missing entries with `--apply`; replace only simple entries with `--replace-existing`. Do not serialize env values into flags and do not restore an entire old config on partial failure.
- [ ] Refuse elevated execution before invoking user-owned Codex. Run tests and commit.

### Task 3: Guided setup CLI and sharing states

**Files:** create `src/client/setup.ts`; modify `src/cli.ts`, `scripts/start-chrome.ps1`; tests `test/setup.test.ts`, `test/cli-lifecycle.test.ts`.

**Interfaces:** export `SetupOptions { apply: boolean; replaceExisting: boolean; startBrowser: boolean }`; export `SetupReport {version:1; state:'needs_attention'|'configured'; sharing:'unobserved'|'mismatch'|'process_configured'; restartRequired:boolean; checks:DiagnosticCheck[]; actions:{id:string;message:string;required:boolean}[]; client:CodexSetupState; changed:boolean; backupPath?:string}`. `runSetup(options,deps)` consumes doctor/configure/browser/privilege dependencies. CLI supports only the spec's flags and concrete Codex client. Exit 1 for attention, 2 for configured/restart required, otherwise 0.

- [ ] Test read-only default, elevated refusal with zero user-client/browser calls, unsafe/different target-origin refusal, browser already healthy/no start, start failure/independent diagnostics, unknown sharing stays explicitly unobserved, matching process configuration never claims active verification, config changes force restart, locked vault stays valid with optional unlock action.
- [ ] Watch focused tests fail.
- [ ] Implement fixed action mapping and state/exit-code rules. Never include raw config or subprocess stderr. Re-run doctor after explicit changes; bound startup polling.
- [ ] Wire CLI `setup` and `--json`; reject unknown/repeated/incomplete flags and replacement without apply before side effects.
- [ ] Launch packaged Windows Chrome only under the desktop user, validate HTTP loopback, and add the background-start option without a scheduled startup task.
- [ ] Run focused suites, all previous CLI/doctor tests and build; commit.

### Task 4: Protected allow proposals from CLI

**Files:** create `src/client/allow.ts`; modify `src/cli.ts`; test `test/cli-allow.test.ts`.

**Interfaces:** export `parseAllowArgs(args:string[]): {domain:string;loginUrl:string;item:string;options:AllowOptions} | null`. Extend CLI connection typing to include `CoreApi.requestAllow`; forward through the existing service client.

- [ ] Test default once, explicit permanent/timed bounds 1 and1440, rejection of 0/1441/fractional/repeated/conflicting/unknown options, HTTPS/user-info rejection, mutually exclusive URL/selector conditions, selectors with spaces, and no IPC on bad args.
- [ ] Watch failures, then implement bounded parsing with existing normalization/policy helpers. A success condition is never invented.
- [ ] Forward exactly one request with explicit policy; preserve protected approval. Explain the unconfirmed limitation when no success evidence was supplied.
- [ ] Run CLI/MCP/grant regression suites and build; commit.

### Task 5: Integration, review and release boundaries

**Files:** `package.json`, `package-lock.json`, README, CHANGELOG, SECURITY and V4 validation report.

- [ ] Bump source to 4.0.0 without modifying runtime dependency ranges or native helpers.
- [ ] Update setup, status and allow examples; document Codex-only automation, advanced-config preservation, administrator split and active-session limitations.
- [ ] Run full tests/build, whitespace checks and clean-worktree package inspection. Run real read-only setup against this host; do not apply configuration that points the user at an unreleased worktree.
- [ ] Independently review the whole branch, including Review Focus and ledger rulings. Fix Critical/Important findings with reproducing tests; record limits honestly.
- [ ] Push a reviewable PR and get Windows/macOS source CI and CodeQL green. Do not merge/release as fully Windows-verified until V3's tightened native gate and matching installed-service/MCP checks pass.
- [ ] Prepare versioned package/release artifacts. Treat physical UAC/2FA as explicit pending gates, not permission that can be simulated or bypassed.

## Self-review and handoff

Each design section maps to a task; every Review Focus case has a named test owner. Metadata additions are optional and keep protocol/state compatibility. Configuration mutation uses the official client boundary; no secrets cross into product status output. The feature can be built inline under the user's autonomous authorization, but source completion is not deployment proof.
