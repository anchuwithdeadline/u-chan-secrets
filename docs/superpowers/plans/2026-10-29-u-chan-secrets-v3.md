# U-Chan Secrets V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver guided diagnosis, honest login outcomes, temporary grants, and a trusted native management window without exposing credentials.

**Architecture:** Extend the existing privileged service and authenticated IPC. Reuse native helpers, JSON storage, the existing CLI, and five MCP tools. Deliver and verify each stage separately; do not introduce a browser dashboard or policy framework.

**Tech Stack:** TypeScript, Node.js 24+, Playwright, Zod, Vitest, existing C# and Cocoa/JXA platform helpers; no new dependencies by default.

**Spec:** `docs/superpowers/specs/2026-10-29-u-chan-secrets-v3-design.md` (approved).

**Execution status:** Tasks 1–7 implemented locally on `feat/v3-usability`, with independent review findings fixed through regression tests. Actual privileged-service and macOS runtime checks remain pending; no installation, publication, push, or merge was performed. See [validation](../research/2026-10-29-v3-validation.md).

## Global Constraints

- Windows and macOS only; macOS remains hardcore only.
- Timed approvals accept an integer duration from 1 to 1,440 minutes. Omitted policy remains permanent for existing clients.
- A once grant permits one attempt after successful preflight; reservation survives failure and restart.
- Grant expiry/revocation cannot invalidate sessions already transferred into Chrome.
- Keep existing required MCP parameters and `ok`/`message` response fields.
- Doctor is read-only, bounded, secret-free; exit 0 for all required passes, 1 for any required failure, 2 for unknown required checks without failures.
- Preserve existing comments, unrelated files, and current credential isolation requirements. Back up protected state only into administrator-owned storage.
- Follow red/green tests before production changes. Run the complete test suite and build before each stage completion claim.
- No push, package publication, privileged installation, or live service replacement is included in local implementation completion.

## Review Focus

1. Desktop UI runs under the wrong identity or exposes prompt material: Task 1 tests actual child identity and refuses insecure fallback.
2. An old service ignores temporary policy: Tasks 2 and 5 test missing capabilities and fail closed before requesting approval.
3. Concurrent IPC requests or process crashes reuse a once grant: Task 5 tests real shared-store ordering and restart persistence.
4. Login fields disappear on an error/challenge page: Task 4 reports unconfirmed authentication and tests approved success conditions.
5. Update/reinstall destroys grant state, exposes backups, or runs user-writable code: Tasks 1 and 5 test state preservation, ownership, and downgrade refusal.

## File responsibilities

- `src/core/types.ts`: grant/success-condition/result types and API interfaces.
- `src/core/doctor.ts`: existing Playwright check plus safe diagnostic report composition; retain Windows-only inspection guard.
- `src/service/doctor.ts` (new): service-side read-only checks using protected platform configuration.
- `src/platform/windows/doctor.ts`, `src/platform/darwin/doctor.ts` (new): fixed-command registration and permissions probes; no arbitrary subprocess runner exposed through IPC.
- `src/core/allowlist.ts`: strict policy validation and atomic persisted entries.
- `src/service/grants.ts` (new): single queue, reservation, expiry clock, protected schema/backup lifecycle.
- `src/core/service.ts`, `src/service/control.ts`, `src/service/main.ts`: service enforcement and wiring.
- `src/core/login-filler.ts`, `src/service/isolated-login.ts`: outcome classification, success-condition evaluation, cancellation, final authorization check.
- `src/ipc/{protocol,client,server}.ts`, `src/mcp/server.ts`, `src/cli.ts`: validated additive transport/CLI interfaces.
- `src/service/manage.ts` (new): management snapshot/action loop using service-controlled native helpers.
- Existing platform prompt/assets/lifecycle files: protected UI, management view, installation summary, upgrade safeguards.
- Existing Vitest suites plus `test/grants.test.ts`, `test/manage.test.ts`, and platform doctor tests: regression checks.
- `docs/attack-checklist.md`, `README.md`, `SECURITY.md`: user behavior, verification limits, compatibility, and security evidence.

## Task 1: establish native and installation prerequisites

**Files:** `src/platform/windows/assets/prompt-src.ts`, `src/platform/windows/prompt.ts`, `src/platform/windows/install.ts`, `src/platform/darwin/prompt.ts`, `src/platform/darwin/prompt-script.ts`, `src/platform/darwin/lifecycle.ts`; matching platform tests and attack checklist.

**Interfaces:** Preserve `ProtectedPrompt.confirm(req)` and `askPassword(req)`. Installer entry points retain their existing signatures.

- [ ] Write failing checks for relayed prompt identity, insecure fallback, preserved settings during reinstall, and service assets resolving through user-writable paths. Add real ownership/identity checks to the manual checklist; source-string tests alone are insufficient evidence.
- [ ] Run targeted platform tests and record expected failures.
- [ ] Correct the Windows relay: current `WTSQueryUserToken` path duplicates the desktop user's token, not the service identity. Use a service-owned process in the intended session with an isolated input desktop; fail closed if protected launch cannot be established. Remove approval-bearing fallback to unprotected user-session messages. Keep prompt output separate from diagnostics.
- [ ] Verify macOS secure-input activation and cleanup. Do not claim keystroke isolation from unit tests alone.
- [ ] Replace installer dependency junctions into user-writable npm trees with validated administrator-owned copies. Resolve and validate runtime/browser/Bitwarden paths. Preserve existing settings, owner identity, grants, and vault state during reinstall; abort partial installation safely.
- [ ] Run targeted tests, complete suite, and build. Record manual checks as passed, failed, or unavailable separately for each OS. Commit scoped prerequisite fixes.

## Task 2: additive protocol, result codes, and capabilities

**Files:** `src/core/types.ts`, `src/ipc/{protocol,client,server}.ts`, `src/mcp/server.ts`, `src/service/main.ts`; `test/ipc.test.ts`, `test/mcp.test.ts`.

**Interfaces:** Add `ResultCode` and optional `ToolResult.code`. Add `ControlApi.capabilities(): Promise<ToolResult>` with validated JSON text `{ protocol: 3, features: string[] }` in `message`; preserve the existing envelope. Define `GrantPolicy = { kind: 'once' } | { kind: 'timed'; minutes: number } | { kind: 'permanent' }` and `SuccessCondition = { url: string } | { selector: string }`. Extend `CoreApi.requestAllow` with optional trailing `{ grant?: GrantPolicy; success?: SuccessCondition }`.

- [ ] Test old request/response shapes, safe code propagation, unknown codes, malformed policy, and an old service returning unknown-method for capabilities.
- [ ] Run tests to verify new behavior fails.
- [ ] Implement validation on both MCP and IPC boundaries and safe fixed codes. Client checks capabilities before sending V3-only options; missing/invalid capabilities reject rather than downgrade the request. Never parse arbitrary strings as trusted policy.
- [ ] Keep the five MCP tool names. Return safe codes in text without exposing privileged control methods as MCP tools.
- [ ] Run protocol/MCP tests, suite, and build. Commit transport changes.

## Task 3: guided doctor and installation summary

**Files:** `src/core/doctor.ts`, new service/platform doctor files, `src/cli.ts`, `src/service/control.ts`, IPC files, platform installation files; doctor, CLI, IPC, and installer tests.

**Interfaces:** `DiagnosticCheck = { id: string; state: 'pass' | 'fail' | 'unknown'; required: boolean; message: string; nextAction: string }`; `DiagnosticReport = { version: 1; checks: DiagnosticCheck[] }`. `ControlApi.diagnose(): Promise<ToolResult>` returns validated report JSON text. Export `runDoctor(deps): Promise<DiagnosticReport>` and `doctorExitCode(report): 0 | 1 | 2`. Dependencies are fixed local probes, not client-supplied commands or paths.

- [ ] Test all three exit codes, service unreachable with independent local checks continuing, vault locked as a separate state, unauthorized IPC, timeout, and macOS unknown browser-sharing state. Include sentinel secrets in failed probe output and assert they never appear in reports.
- [ ] Run tests and confirm expected failures.
- [ ] Implement ordered probes for support, registration/reachability, IPC caller authorization, protected asset presence/permissions, vault state, CDP reachability, and observable browser sharing. Bound each probe to 5 seconds and the entire doctor call to 30 seconds; terminate timed-out subprocesses.
- [ ] Implement `u-chan doctor [--json]`, strict argument validation, safe report rendering, and the same post-install summary. Summaries may report setup incomplete without hiding whether service creation succeeded. Do not unlock, fetch credentials, modify ACLs, or perform repair.
- [ ] Run doctor/CLI/installer tests, suite, and build. Commit diagnostics.

## Task 4: honest login outcomes and approved success conditions

**Files:** `src/core/{types,allowlist,login-filler,service}.ts`, `src/service/isolated-login.ts`, MCP/IPC validation; login-filler, isolated-login, allowlist, and service tests.

**Interfaces:** Extend `AllowEntry.success?: SuccessCondition`. Extend `FillOutcome` with safe codes and an unconfirmed state. Extend `LoginRunner.run(entry, getCreds, options?)` with service-supplied `signal: AbortSignal` and `beforeTransfer: () => Promise<void>`; these are never accepted from IPC.

- [ ] Test a blank page, fields disappearing on a failed page, CAPTCHA, unsupported multistep form, an unmet configured success condition, a passed approved condition, and failed injection. Test legacy heuristic transfer returns `ok: false` with an explicit authentication-unconfirmed code and transfer notice.
- [ ] Run tests and confirm expected failures.
- [ ] Validate exact HTTPS success URLs against allowed hosts. Permit only one URL or nonempty bounded selector condition; display it in approval. Evaluate inside the isolated browser. A configured condition that fails prevents transfer; legacy/no-condition flows retain filtered transfer with unconfirmed status.
- [ ] Propagate safe result codes and next actions without raw page text, Playwright error details, or invented wrong-password certainty. Preserve synchronous host checks around credential actions.
- [ ] Enforce a 60-second login deadline with actual context cancellation, not a detached `Promise.race`. Reserve enough time to close the isolated context before releasing the queue. Call `beforeTransfer` directly before state export and again before target injection.
- [ ] Run focused login tests, suite, and build. Commit outcomes.

## Task 5: temporary grants and compatible state lifecycle

**Files:** `src/core/{types,allowlist,service}.ts`, new `src/service/grants.ts`, `src/service/{control,main}.ts`, MCP/IPC files, installation/update files; grants, service, control, allowlist, updater, and installer tests.

**Interfaces:** Add `AllowEntry.expiresAt?: string` (canonical UTC ISO timestamp), `remainingUses?: number` (nonnegative safe integer). Add `GrantCoordinator.run<T>(operation: () => Promise<T>): Promise<T>`, `check(entry): void`, and `reserve(domain): Promise<AllowEntry>`. Use one shared coordinator for core/control grant operations. Preflight comes from `LoginRunner.preflight(): Promise<void>` and vault status; no credential retrieval during preflight.

- [ ] Test omitted policy/permanent legacy entries, timed values 1 and 1,440, rejection of 0/1,441/fractions, malformed persisted policy denial, cancellation, and an approval expiring while the user decides.
- [ ] Test concurrent once logins through separate IPC connections using one real temporary store, crash/restart after reservation, preflight failure without consumption, revocation ordering, queue recovery after rejection, and expiry before credentials/export/injection.
- [ ] Test backward wall-clock changes against monotonic elapsed time. Detect rollback beyond a documented 1-second clock tolerance; invalidate timed grants active at detection rather than extending them. Test restart uses persisted UTC expiration without claiming to detect clock changes while stopped.
- [ ] Run focused tests to verify failures.
- [ ] Implement the single queue and consume-on-reservation semantics. Keep the queue held through bounded isolated login. Approval text names one attempt, exact expiry, or permanent access and explains existing Chrome sessions survive revocation. Record fixed safe audit reasons and policy metadata.
- [ ] Before first V3 state mutation, create and verify an administrator-owned pre-V3 backup and schema marker. Existing V3 data must not be restored automatically after crash. Apply ownership before writing sensitive backup contents and abort if verification fails.
- [ ] Test missing/invalid marker, partial backup failure, state-preserving reinstall, and supported downgrade refusal. Refuse V2 targets in V3 tooling after migration. Document historical administrator-run V2 tools as outside enforcement; do not claim the marker controls old code.
- [ ] Show expired/exhausted grants in lists. Require new protected approval for any extension or identity/host/selector/condition change. V1 import routes through the same queue and approval rules.
- [ ] Run focused tests, suite, and build. Commit grants and lifecycle safeguards.

## Task 6: trusted native management window

**Files:** new `src/service/manage.ts`, `src/core/types.ts`, `src/platform/index.ts`, native prompt/helper files, `src/cli.ts`, service control/wiring and IPC; new management tests and platform tests.

**Interfaces:** `ControlApi.manage(): Promise<ToolResult>` starts a bounded service-owned management loop. `ManagementSnapshot` contains only vault state, safe grant labels, recent sanitized audit records, and diagnostic checks. Platform helper `showManagement(snapshot): Promise<{ action: 'close' | 'refresh' | 'lock' | 'unlock' | 'revoke'; domain?: string }>` returns an untrusted requested action, never an approval assertion. Service owns the phrase and validates each target/action anew.

- [ ] Test unknown actions, stale/missing targets, malformed helper output, timeout/close, lock/unlock/revoke routing, bounded snapshot size, and forbidden secret fields. Test management cannot create or extend a grant.
- [ ] Run management tests to verify expected failures.
- [ ] Implement `u-chan manage` and native scrollable status/grants/activity display with Refresh, Lock, Unlock, Revoke, Close. No web listener, editable policy, or secret viewer. Only a trusted installed service launches the helper.
- [ ] Keep the event loop outside the grant queue; take snapshots/actions inside bounded queue operations. Return from one helper invocation before opening a password prompt so shared prompt queues cannot deadlock. Terminate helpers on timeout and release resources on every close/error path.
- [ ] Perform visual review for long domains, many grants, expiration labels, readable action targets, and clear session-revocation limits. Perform actual Windows/macOS identity and input-isolation checks separately.
- [ ] Run management/platform tests, suite, and build. Commit native management changes.

## Task 7: release documentation, integration verification, and native approval investigation

**Files:** `README.md`, `SECURITY.md`, `docs/attack-checklist.md`, package metadata, new `docs/superpowers/research/2026-10-29-native-approval.md`; existing end-to-end suites.

**Interfaces:** No production biometric API. Package becomes 3.0.0 only once implementation stages pass local checks; this does not publish it.

- [ ] Add integration tests for a legacy client/entry, a once grant, expiry, an unconfirmed transfer, doctor partial failure, and management revocation. Run them red before wiring missing behavior, then green.
- [ ] Update user instructions, diagnostics, grant semantics, success conditions, safe upgrade/rollback, and explicit platform verification status. Do not repeat unverified V2 isolation claims as proven.
- [ ] Investigate Windows Hello/Touch ID using official platform documentation and, where available, a disposable proof of concept. Record action binding, replay resistance, privileged verification, automation limits, and why biometric approval does not itself unlock Bitwarden. No production authentication change.
- [ ] Run `rtk npm.cmd test` and `rtk npm.cmd run build`; require all tests/build to pass. Run `rtk git diff --check`. Record manual checks not executable on this host as unavailable, not passed.
- [ ] Review the complete branch against the approved spec and fix actionable issues. Report commits, test counts, remaining native verification, and deployment/publication status separately. Commit only scoped work; no push or live installation.

## Execution and verification boundaries

Recommended execution: native implementation in this session, task by task, because tasks share the same service/transport types and native helper code. Use `superpowers:executing-plans`; do not parallelize edits to these files. Request one independent whole-branch review after implementation as specified by that execution workflow.

Plan self-review: all design stages map to Tasks 1–7. Protocol names and grant/result types are defined before callers; schema and native identity prerequisites precede policy/UI deployment. Biometrics remains research. This Windows host cannot establish macOS runtime evidence, and no local source test establishes a successful production deployment.
