# V5 Login Reliability and Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support selectable Chrome/Edge desktop destinations and confirm login in the browser the user actually uses.

**Architecture:** Preserve the service-owned isolated Chromium runtime and five public MCP tools. Add a small user-side browser preference, a shared Windows launcher/identity probe, and one reusable success evaluator for private and destination verification. Keep protocol/schema 3 with additive V5 capabilities and reject V5 login requests against services lacking verified-transfer support.

**Tech Stack:** Existing Node >=24, TypeScript, Playwright, Windows PowerShell, Vitest; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-v5-login-reliability-edge-design.md` (approved).

## Global Constraints

- Windows is the verified release target; macOS native runtime remains unverified.
- Chrome is the default when no choice exists; explicitly select Edge on this user's host.
- Existing grants, expiry, reservation/concurrency rules, and one-attempt consumption semantics remain authoritative.
- Credentials continue to be retrieved and entered only in the service-owned isolated Chromium browser.
- Keep five existing public MCP tools, protocol 3, protected-state schema 3, native helpers, and runtime dependencies.
- No automatic credential retries, approval bypass, or transfer of partial challenge state.
- No runtime browser installation, automatic personal-profile attachment, browser termination, or simultaneous browser destinations.
- Use `rtk` for shell commands. Preserve backups and unrelated files; no structural changes without a backup.

## Review Focus

- A stale MCP environment or malformed saved browser must not silently select a different browser; Task 1/2 test explicit precedence and fail-closed parsing.
- An occupied endpoint may be another browser, unrelated process, unknown owner, or personal profile; Task 1 tests each refusal.
- Login form disappearance or private-only success must never become verified desktop success; Task 3/4 test both.
- Off-host form actions, fetch, redirects, subframes, service workers, and WebSockets can bypass visible-URL checks; Task 3 pins outbound enforcement.
- Cancellation during injection/verification can leave session state; Task 4 tests honest results, owned-tab cleanup, and untouched existing tabs/cookies.

## Task 1: Browser preference and Windows launcher

**Files:** `src/core/config.ts`, new `src/client/browser-choice.ts`, new `src/platform/windows/desktop-browser.ts`, new `scripts/desktop-browser.ps1`, new `scripts/start-browser.ps1`, `scripts/start-chrome.ps1`; tests `test/config.test.ts`, new `test/browser-choice.test.ts`, new `test/windows/desktop-browser.test.ts`.

**Interfaces:** `BrowserKind = 'chrome' | 'edge'`; `AppConfig` gains `browser`, `browserProfile`, `browserChoicePath` and retains legacy `chromeProfile`. `readBrowserChoice(path): BrowserKind | undefined` is synchronous and fails on malformed/redirected existing input. `saveBrowserChoice(path, browser): Promise<{changed:boolean; backupPath?:string}>` backs up before atomic replacement. An explicit `U_CHAN_BROWSER` environment is an operation/MCP snapshot; otherwise read saved choice, then Chrome. `inspectDesktopBrowser({endpoint, browser, profile}, env): Promise<DiagnosticState>` invokes the shared PowerShell probe without launching. Launcher accepts `-Browser chrome|edge`, `-Background`, and `-CheckOnly`; resolves saved/env/default choice consistently.

- [ ] Add tests for Chrome default, Edge persistence, invalid enum/JSON, omitted later selection, separate profiles, read-only inspection, atomic write/backup, redirect refusal, custom endpoint retention, and existing Chrome config compatibility.
- [ ] Add native-probe policy tests with injectable process/listener fixtures: matching dedicated Chrome/Edge pass; wrong binary/profile/owner, null command line, duplicate/ambiguous profile args, wildcard listener, occupied non-CDP port, missing browser, and unknown observation refuse.
- [ ] Implement preference with Node standard library and explicit safe errors. Store `{browser}` at user-side `browser.json`. Backups live beside it under `#0 backup`; never read or write service secrets.
- [ ] Implement shared PowerShell process/listener validation and launch. Check exact requested installed executable, current desktop owner SID, dedicated profile argument, loopback binding, and working CDP. Start only if no listener exists; poll identity/readiness after launch. Preserve old Chrome wrapper, which explicitly selects Chrome. Refuse unknown/conflicting listeners without killing processes or choosing another port/browser.
- [ ] Run `rtk proxy npm.cmd test -- --run test/config.test.ts test/browser-choice.test.ts test/windows/desktop-browser.test.ts`; expected all pass. Commit scoped browser foundation.

## Task 2: Setup, diagnostics, and browser selection integration

**Files:** `src/cli.ts`, `src/client/setup.ts`, `src/client/codex-setup.ts`, `src/core/doctor.ts`, `src/service/doctor.ts`, `src/service/manage.ts`, `src/mcp/server.ts`; tests `test/setup.test.ts`, `test/codex-setup.test.ts`, `test/doctor-v4.test.ts`, `test/manage.test.ts`, `test/mcp.test.ts`.

**Interfaces:** `SetupOptions.browser?: BrowserKind`; `SetupReport.browser?: BrowserKind` and `browserChanged?: boolean` are additive. `CodexSetupOptions.browser?: BrowserKind` registers/validates `U_CHAN_BROWSER` and `U_CHAN_CDP` on U-Chan, preserving unrelated advanced settings. Existing callers without browser options retain their current behavior. Diagnostics retain legacy `chrome` check ID for compatibility but use browser-neutral/actual-browser text, plus an additive `browser_identity` check on Windows. CDP browser observation returns `chrome|edge|unknown` separately from configured preference.

- [ ] Add failing CLI/setup tests for `--browser chrome|edge`, duplicate/missing/invalid value, read-only choice, explicit saved selection with `--apply`, preserved default on later omission, elevated refusal, MCP target/browser env mismatch, unrelated config preservation, and startup refusal when another dedicated browser owns the endpoint.
- [ ] Implement option forwarding without global environment mutation. Persist browser preference only after supported configuration checks permit apply; report completed changes and retained backups on partial failure. Combine preference/config changes into restartRequired and changed accurately.
- [ ] Wire read-only Windows identity probe and selected-browser launcher; report missing versus unknown distinctly and leave current-session sharing unverified. Fix generic Chrome-only wording in diagnostics, management, and MCP instructions; do not add tools.
- [ ] Run focused setup/config/doctor/manage/MCP tests; expected all pass. Commit integration.

## Task 3: Explicit login outcomes, bounded evidence, and private host enforcement

**Files:** new `src/core/login-success.ts`, `src/core/login-filler.ts`, `src/core/types.ts`, `src/service/isolated-login.ts`; tests `test/login-filler.test.ts`, `test/login-outcomes-v3.test.ts`, new `test/login-reliability-v5.test.ts`, `test/fixtures/server.ts`.

**Interfaces:** `waitForLoginSuccess(page, success, hostCheck, signal, timeoutMs): Promise<boolean>` checks an approved exact URL or visible selector with bounded waiting and fixed safe failure behavior. It never returns raw page/errors. `FillOutcome` retains statuses and assigns explicit stable codes at origin; `IsolatedLogin` does not classify English reason substrings. Add `browser_unavailable` and `destination_unconfirmed` codes while retaining legacy `chrome_unavailable` recognition. Human-action outcomes use `needs_human` with manual-sign-in guidance.

- [ ] Add delayed-URL/selector, late SPA rendering, no-fields/no-evidence, rejected credentials, CAPTCHA/passkey/push/missing or rejected TOTP, and safe-error tests. Assert at most existing one credential/TOTP submission sequence, no secret-bearing messages, and no invented success condition.
- [ ] Add private-context tests for off-host form action, redirect, fetch, subframe/subresource, and WebSocket refusal. Assert service workers blocked and requests cannot send dummy credentials to an unapproved host. Existing local HTTP fixtures use explicit injected host policy only; production remains approved HTTPS/WSS.
- [ ] Implement the reusable evaluator and explicit result codes in filler. Keep no-condition legacy flow unconfirmed. Reduce repeated unbounded network-idle waits when success evidence can decide; retain one overall 60-second login deadline.
- [ ] Configure isolated contexts with blocked service workers and routing that validates every outbound HTTP request/redirect and WebSocket host. Retain checked element handles before credential actions, signal cancellation, and grant rechecks.
- [ ] Run scoped login/isolated/grant tests; expected all pass. Commit private login reliability.

## Task 4: Verify transferred desktop sessions and service capability compatibility

**Files:** `src/core/browser.ts`, `src/core/types.ts`, `src/service/isolated-login.ts`, `src/service/control.ts`, `src/ipc/client.ts`; tests `test/browser.test.ts`, `test/isolated-login.test.ts`, `test/login-outcomes-v3.test.ts`, `test/ipc-v3.test.ts`, `test/grants.test.ts`, `test/control.test.ts`.

**Interfaces:** `SessionTarget.verify?(entry, finalUrl, signal): Promise<boolean>` is optional for old test/custom targets, but absence never permits `logged_in`. Production `CdpSessionTarget.verify` uses an owned tab and the shared success evaluator. `capabilities.features` adds `verified_session_transfer`; V5 `IpcClient.login` requires it before requesting login, otherwise returns `unsupported_service` without reserving a grant. Keep protocol 3 and schema 3; V4 clients may use the stricter V5 service without bypassing verification.

- [ ] Add true private+desktop success, private-success/desktop-failure, missing verifier, cancellation during inject/verify, unsafe destination redirect, and partial-transfer tests. Existing independent tabs/cookies remain untouched; only operation-owned tabs close. Missing/no condition always unconfirmed.
- [ ] Add IPC tests showing a V5 client refuses old/malformed/unreachable capabilities before `login`, and accepts the new feature. Retain old result-code parsing and five public MCP tools.
- [ ] Implement owned-tab top-level navigation/redirect restrictions without context-wide routing or desktop service-worker changes. Derive verification URL from approved exact URL or approved final private URL; check host before navigation and after evidence.
- [ ] After filtering/injection and authorization recheck, require successful target verification for `logged_in`. Return explicit destination-unconfirmed/partial-state guidance on failure; never delete pre-existing desktop cookies or refund once grants. Correct browser-neutral messages.
- [ ] Run browser/login/IPC/grant/control tests; expected all pass. Commit verified transfer.

## Task 5: Real Windows browser matrix, documentation, and whole-branch verification

**Files:** extend `scripts/windows-security/browser-worker.mjs`, `scripts/verify-windows-adversarial.mjs` and their result policy only as needed; add narrowly scoped desktop-browser fixture runner under `scripts/windows-security`; `README.md`, `CHANGELOG.md`, `SECURITY.md`, validation research report, `package.json`, `package-lock.json`; relevant integration tests.

- [ ] Update fixture targets to perform actual destination verification rather than injected-success stubs. Parameterize Chrome/Edge desktop fixtures with disposable dedicated profiles and safe fresh ports, preserving live profiles and current service settings. Real service-owned Chromium still performs dummy credential entry.
- [ ] Cover selected executable/profile ownership, denied personal-profile reuse, correct transfer and destination evidence, challenge refusal, session filtering, and harmless fresh shared-MCP connection separately for each installed browser. Missing browser is explicitly unavailable/unverified, never inferred from the other browser.
- [ ] Bump version to 5.0.0; document browser default/selection, switching refusal, saved condition requirements, private-network compatibility limits, manual challenge guidance, truthful result states, compatibility boundary, and macOS/runtime/session limitations.
- [ ] Run existing full suite, build, whole-project typecheck, diff check; obtain independent whole-branch review. Resolve findings. Source/tests/fixtures and docs form one scoped V5 PR; require exact-head Windows/macOS CI and CodeQL before merge.

## Task 6: Publish, install, select Edge, and record evidence

- [ ] Freeze and inspect the package; compare native helpers/dependencies and protect a pre-upgrade backup. Publish with existing official npm browser approval flow. Verify public registry signature/integrity and exact artifact hash before live update. Promote GitHub only with the matching verified artifact; align npm latest/next.
- [ ] Install matching public service/CLI through supported signed update or trusted reinstall as dictated by compatibility. Verify exact installed compiled/global package bytes and unchanged protected settings/grants/vault data.
- [ ] Back up user setup configuration, explicitly apply Edge selection and matching MCP registration. If Chrome currently owns the endpoint, ask user to close only the dedicated instance; do not terminate it automatically. Start/verify dedicated Edge, run doctor/setup and fresh MCP checks, and retain locked vault.
- [ ] Record real per-browser fixture reports, source CI, artifact verification, installation/configuration, and current-session restart caveat separately. Merge final evidence docs after CI. Finish with exact installed/released version, remaining physical checks, and restart instruction.

Execution choice: implement natively in this session because browser setup and login/transfer share configuration and types. The approved design authorizes implementation; use independent whole-branch review before merge rather than requesting a second implementation approval.
