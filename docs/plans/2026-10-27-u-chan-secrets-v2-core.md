# U-Chan Secrets V2 — Plan 1: Platform-neutral service core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split U-Chan into a service process (holds vault, allowlist, approvals, its own login browser) and a thin MCP client that talks to it over local IPC, with every platform-specific piece behind an interface.

**Architecture:** The V1 core moves behind an IPC server. The MCP server becomes `IpcClient`, which implements the existing `CoreApi`. Approvals go through `PolicyApprover` (easy/hardcore, lockout) on top of a `ProtectedPrompt` interface. The vault keeps its Bitwarden session in memory only. Logins run in a service-owned headless Chromium, and only the session for the entry's hosts is copied into the user's Chrome. Platform adapters (protected windows, IPC caller check, install) are stubs here and come in Plans 2–3.

**Tech Stack:** TypeScript/Node 24, `node:net`, `@modelcontextprotocol/sdk`, `playwright`, `vitest`.

**Spec:** `docs/specs/2026-10-27-u-chan-secrets-v2-design.md`

**Plan series (each its own plan, written after this one lands):**
1. **This plan:** the platform-neutral core, fully testable with fakes on CI.
2. **Windows platform:** service install/uninstall as admin, admin-owned program dir and ACL'd data dir, named-pipe caller check, protected windows (SYSTEM process in the user session or a secure desktop), UAC-level warning, `bw logout` migration step, `u-chan audit`.
3. **macOS platform:** launchd daemon, root-owned dirs, socket caller check, protected windows with a secure text field, hardcore-only mode, Chrome launcher.
4. **Self-update and docs:** `u-chan update` with npm signature/provenance check, README and threat model for V2.

## Global Constraints

- Nothing secret (password, TOTP seed, Bitwarden session, master password) appears in an IPC response, audit entry, stderr log or thrown message. Reuse `redact()` and `UserFacingError`.
- The master password never crosses IPC. Only the service's `ProtectedPrompt` collects it.
- Easy mode exists on Windows only. With `platform === 'darwin'` the effective mode is always `hardcore`.
- Hardcore → easy needs the master password. Easy → hardcore needs nothing.
- 5 wrong master passwords → no prompts for 15 minutes (900000 ms).
- Protected prompts are serialized: only one is on screen at a time.
- Default idle lock: 12 h (43200000 ms).
- Every `login` signs in fresh in a new service browser context. Session transfer is limited to the entry's hosts.
- Human-check pages give exactly `needs you — sign in by hand this time`.
- The MCP tool names and parameters stay as in V1, plus optional `selectors` on `request_allow`.
- Code style matches V1: small classes with injected deps, `ToolResult`, terse comments.

## Review Focus

1. **Junk on the IPC socket** (non-JSON, a frame over 64 KiB, an unknown method, non-string params). The server answers `bad request` or closes that connection and keeps serving others. Test: Task 1, `rejects malformed and oversized frames`.
2. **Service not running.** Every MCP tool returns `U-Chan service is not running — run u-chan install` instead of crashing or hanging. Test: Task 1, `reports service down`.
3. **Two approvals at once.** Claude fires two `request_allow` calls in parallel; the second prompt waits for the first. Test: Task 2, `serializes prompts`.
4. **Idle expiry.** After 12 h unused, `login` reports `vault locked — run u-chan unlock`, and each use resets the timer. Test: Task 3, `locks after idle timeout`.
5. **`bw` echoes the master password in stderr.** The password must not reach stderr logs or any message. Test: Task 3, `never logs the master password`.

---

### Task 1: IPC protocol, server and client

**Files:**
- Create: `src/ipc/protocol.ts`, `src/ipc/server.ts`, `src/ipc/client.ts`, `src/ipc/endpoint.ts`
- Modify: `src/core/types.ts` (add `ControlApi`, `ApprovalMode`; `CoreApi.requestAllow` gains `selectors?`)
- Test: `test/ipc.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export type ApprovalMode = 'easy' | 'hardcore'
  export type Selectors = NonNullable<AllowEntry['selectors']>
  // CoreApi.requestAllow(domain: string, loginUrl: string, item: string, selectors?: Selectors): Promise<ToolResult>
  export interface ControlApi {
    unlock(): Promise<ToolResult>
    lock(): Promise<ToolResult>
    setMode(mode: ApprovalMode): Promise<ToolResult>
    importV1(entries: unknown[]): Promise<ToolResult>
  }
  ```
- Produces (protocol.ts): `MAX_FRAME = 65536`; `type Method = 'login' | 'request_allow' | 'revoke' | 'list_allowed' | 'status' | 'unlock' | 'lock' | 'set_mode' | 'import_v1'`; `interface Request { id: number; method: Method; params: Record<string, unknown> }`; `interface Response { id: number; ok: boolean; message: string }`; `encode(msg: Request | Response): string` (JSON + `\n`); `class FrameReader { push(chunk: Buffer): unknown[] }`, which throws `FrameTooLarge` when a pending line exceeds `MAX_FRAME`.
- Produces (server.ts): `startIpcServer(path: string, api: CoreApi & ControlApi, opts?: { authorize?: (socket: net.Socket) => Promise<boolean> }): Promise<net.Server>`.
- Produces (client.ts): `class IpcClient implements CoreApi, ControlApi`, constructor `(path: string, opts?: { timeoutMs?: number })`, default timeout 180000 ms (prompts can take 2 min).
- Produces (endpoint.ts): `defaultEndpoint(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string`: `U_CHAN_IPC` if set; win32 `\\.\pipe\u-chan-secrets`; darwin `/var/run/u-chan-secrets/ipc.sock`.

- [ ] **Step 1: Write the failing tests** in `test/ipc.test.ts`. Use a temp socket path (on win32 `\\.\pipe\ucs-test-<random>`) and a fake `api` built from `vi.fn`s returning `{ ok: true, message: <method name> }`.
  - `round-trips every method`: each `IpcClient` method → matching fake called with the same args (`requestAllow` includes the `selectors` object, `importV1` the array) → client gets `{ ok: true, message }`.
  - `rejects malformed and oversized frames`: raw socket writes `not json\n` → reads `{"id":0,"ok":false,"message":"bad request"}`; a 70000-byte line → socket is closed; `{"id":1,"method":"nope","params":{}}` → `unknown method`; `{"id":2,"method":"login","params":{"domain":5}}` → `bad request`; afterwards a fresh `IpcClient.status()` still succeeds.
  - `reports service down`: `new IpcClient('<unused path>').login('x')` → `{ ok: false, message: 'U-Chan service is not running — run u-chan install' }`.
  - `refuses unauthorized callers`: `authorize` resolves `false` → any call → `{ ok: false, message: 'caller not allowed' }` and the fake api is never called.
  - `api throw becomes internal error`: a fake that throws `new Error('secret')` → `{ ok: false, message: 'internal error' }`.
- [ ] **Step 2: Run** `npx vitest run test/ipc.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the four files. The server validates params per method (strings only; `selectors` a plain object of strings; `entries` an array; `mode` is `easy` or `hardcore`) before calling `api`. The client opens one connection per call, matches by `id`, and maps `ECONNREFUSED`/`ENOENT` to the service-down message.
- [ ] **Step 4: Run** `npx vitest run test/ipc.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ipc): add local IPC protocol, server and client`.

### Task 2: Settings, attempt limiter and PolicyApprover

**Files:**
- Create: `src/service/settings.ts`, `src/service/attempts.ts`, `src/service/policy-approver.ts`
- Modify: `src/core/types.ts`
- Test: `test/policy-approver.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export interface PromptRequest { title: string; lines: string[]; phrase: string }
  /** Platform window owned by the service. Close, timeout or error → false / null. */
  export interface ProtectedPrompt {
    confirm(req: PromptRequest): Promise<boolean>
    askPassword(req: PromptRequest): Promise<string | null>
  }
  export interface MasterPasswordChecker { verify(password: string): Promise<boolean> }
  ```
- Produces (settings.ts): `interface Settings { mode: ApprovalMode; phrase: string; idleLockMs: number }`; `class SettingsStore(path: string)` with `get(): Promise<Settings>` (defaults `{ mode: 'easy', phrase: '', idleLockMs: 43200000 }` when the file is missing) and `update(patch: Partial<Settings>): Promise<Settings>` (atomic tmp + rename, as in `AllowlistStore.write`).
- Produces (attempts.ts): `class AttemptLimiter(max = 5, windowMs = 900000, now = Date.now)` with `blocked(): boolean`, `fail(): void`, `reset(): void`. After `max` consecutive failures it is blocked until `windowMs` has passed since the last failure.
- Produces (policy-approver.ts): `class PolicyApprover implements Approver` with constructor `({ prompt, checker, settings, limiter, platform }: { prompt: ProtectedPrompt; checker: MasterPasswordChecker; settings: SettingsStore; limiter: AttemptLimiter; platform: NodeJS.Platform })`; `effectiveMode(): Promise<ApprovalMode>` (always `'hardcore'` on darwin); `ask(title, lines): Promise<boolean>`; `askPassword(title, lines): Promise<string | null>` (serialized like `ask`, used by Task 5's unlock and mode change).

- [ ] **Step 1: Write the failing tests:**
  - `easy mode confirms`: mode `easy`, platform `win32`, `confirm` → true → `ask` resolves true; `askPassword` never called.
  - `hardcore needs the right password`: `askPassword` returns `'pw'`; `checker.verify('pw')` true → true; verify false → false and `limiter.fail` counted; `askPassword` null → false.
  - `darwin is always hardcore`: settings mode `easy`, platform `darwin` → `askPassword` is used and `effectiveMode()` is `'hardcore'`.
  - `locks out after 5 wrong passwords`: 5 failed verifies, then a 6th `ask` → false without calling `prompt`; advance the fake clock by 900000 ms → the prompt shows again.
  - `passes the phrase`: settings phrase `'blue otter'` → every `PromptRequest` has `phrase: 'blue otter'`.
  - `serializes prompts`: two concurrent `ask` calls with a `confirm` whose first call is held open → the second `confirm` has not been called until the first resolves.
- [ ] **Step 2: Run** `npx vitest run test/policy-approver.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files. Serialize with a promise chain held on the instance.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(service): add approval policy with easy/hardcore modes and lockout`.

### Task 3: In-memory Bitwarden session

**Files:**
- Modify: `src/core/vault.ts`, `src/core/types.ts`
- Test: `test/vault.test.ts` (rewrite the session-file cases)

**Interfaces:**
- Consumes: `MasterPasswordChecker` (Task 2).
- Produces: `class BitwardenVault implements VaultClient, MasterPasswordChecker` with constructor `({ dataDir, exec?, idleLockMs, now? }: { dataDir: string; exec?: Exec; idleLockMs: number; now?: () => number })` and methods `status()`, `getLogin(item)`, `unlock(password: string): Promise<boolean>`, `lock(): Promise<void>`, `verify(password: string): Promise<boolean>`. `types.ts` adds `unlock`/`lock` to `VaultClient`.
- Message constants: `UNLOCK_MSG = 'vault locked — run u-chan unlock'`, `LOGIN_MSG = 'not logged in to Bitwarden — run u-chan install'`.

- [ ] **Step 1: Write the failing tests** with a fake `Exec`:
  - `unlock keeps the session in memory`: exec for `['unlock', '--passwordenv', 'UCS_BW_PASSWORD', '--raw']` returns stdout `SESS` → `unlock('pw')` true; a following `getLogin` call's env has `BW_SESSION === 'SESS'`; `UCS_BW_PASSWORD` was `'pw'` in the unlock env and `'pw'` is in no argv.
  - `every bw call uses the service data dir`: env `BITWARDENCLI_APPDATA_DIR === dataDir` on all calls.
  - `wrong password`: unlock exit code 1 → false; `status()` is `'locked'`.
  - `locks after idle timeout`: unlock, advance the fake clock by `idleLockMs + 1` → `status()` `'locked'` and `getLogin` throws `UNLOCK_MSG`; a `getLogin` just before expiry resets the timer.
  - `lock forgets the session`: `lock()` runs `bw lock` and then `status()` is `'locked'` without calling `bw status`.
  - `verify re-unlocks`: `verify('pw')` true replaces the session; `verify('bad')` false keeps the old session.
  - `never logs the master password`: unlock fails with stderr `Invalid master password pw`, with `console.error` spied → no logged string contains `'pw '` or ends with `'pw'`.
- [ ] **Step 2: Run** `npx vitest run test/vault.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove `sessionPath` and `process.env.BW_SESSION` support. Redact both the password and the session in any stderr that gets logged.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(vault): keep Bitwarden session in service memory with idle lock`.

### Task 4: Login in the service browser and session transfer

**Files:**
- Create: `src/service/isolated-login.ts`, `src/service/session-transfer.ts`
- Modify: `src/core/login-filler.ts` (challenge detection), `src/core/browser.ts` (add `CdpSessionTarget`), `test/fixtures/server.ts` (add a `/captcha` route)
- Test: `test/login-filler.test.ts`, `test/isolated-login.test.ts`, `test/session-transfer.test.ts`

**Interfaces:**
- Produces (login-filler.ts): `export const NEEDS_YOU = 'needs you — sign in by hand this time'`; `fillLogin` returns `{ status: 'failed', reason: NEEDS_YOU }` when `iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"]` is visible on the login page before filling, or after a submit.
- Produces (session-transfer.ts): `type SessionState = Awaited<ReturnType<BrowserContext['storageState']>>`; `filterState(state: SessionState, hosts: string[]): SessionState` keeps a cookie when some host `h` satisfies `h === d || h.endsWith('.' + d)`, where `d` is the cookie domain without its leading dot. It keeps origins whose hostname is in `hosts`.
- Produces (types.ts): `interface SessionTarget { userAgent(): Promise<string>; inject(state: SessionState): Promise<void> }`; `interface LoginRunner { run(entry: AllowEntry, getCreds: () => Promise<Credentials>): Promise<FillOutcome> }`.
- Produces (isolated-login.ts): `class IsolatedLogin implements LoginRunner`, constructor `({ launch, target, timeoutMs? }: { launch: () => Promise<Browser>; target: SessionTarget; timeoutMs?: number })`. Per run: launch (or reuse) the browser, create a new context with `userAgent: await target.userAgent()`, call `fillLogin`; on `logged_in`, `target.inject(filterState(await ctx.storageState(), entry.hosts))`; always close the context. A failed `inject` → `{ status: 'failed', reason: 'could not hand the session to Chrome' }`.
- Produces (browser.ts): `class CdpSessionTarget implements SessionTarget`, constructor `(provider: CdpBrowserProvider)`. `inject` calls `context.addCookies`, then for each origin with localStorage opens a page on that origin, sets the items and closes the page.

- [ ] **Step 1: Write the failing tests:**
  - `login-filler: stops at a captcha`: fixture `/captcha` (a login form plus `<iframe src="/recaptcha/api2/anchor">`) → `{ status: 'failed', reason: NEEDS_YOU }` and `getCreds` is never called.
  - `filterState keeps only entry hosts`: cookies for `example.com`, `.example.com`, `evil.com` and `a.example.com`, with hosts `['example.com']` → keeps the first two; origins `https://example.com` kept and `https://evil.com` dropped.
  - `isolated-login: hands over the session`: fixture `/single` with a real `chromium.launch()` and a fake target → on success `inject` gets a state whose cookies include the fixture's session cookie (add `set-cookie: sid=1` on the `/dash` redirect) and the context is closed.
  - `isolated-login: fresh context each run`: two runs → two distinct `newContext` calls; the second run still fills the form.
  - `isolated-login: inject failure`: target `inject` rejects → the fixed failure reason, with no error text passed through.
  - `CdpSessionTarget injects cookies`: launch chromium with `--remote-debugging-port=0`, connect `CdpBrowserProvider` to it, inject a state → `context.cookies()` in that browser contains the cookie.
- [ ] **Step 2: Run** `npx vitest run test/login-filler.test.ts test/isolated-login.test.ts test/session-transfer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above. The hostCheck override used by the fixture tests stays as in V1.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(login): sign in inside a service-owned browser and transfer only the session`.

### Task 5: CoreService and ControlService

**Files:**
- Modify: `src/core/service.ts`, `src/core/types.ts` (`AuditEvent.action` adds `'unlock' | 'lock' | 'mode' | 'import'`), `src/core/allowlist.ts` (export `isValidEntry`)
- Create: `src/service/control.ts`
- Test: `test/service.test.ts`, `test/control.test.ts`

**Interfaces:**
- Consumes: `LoginRunner` (Task 4), `PolicyApprover` (Task 2), `BitwardenVault` (Task 3).
- Produces: `CoreDeps` becomes `{ vault: VaultClient; allowlist: AllowlistStore; approver: Approver; audit: AuditLog; login: LoginRunner; mode: () => Promise<ApprovalMode> }`. `browser` and `playwright` are removed (the Playwright check moves to the client in Task 6).
- Produces (control.ts): `class ControlService implements ControlApi`, constructor `({ vault, approver, limiter, settings, allowlist, audit, platform }: { vault: BitwardenVault; approver: PolicyApprover; limiter: AttemptLimiter; settings: SettingsStore; allowlist: AllowlistStore; audit: AuditLog; platform: NodeJS.Platform })`. `limiter` is the same instance `PolicyApprover` uses, so wrong unlock passwords and wrong approval passwords share one lockout; while `limiter.blocked()`, `unlock` returns `too many wrong passwords — try again in 15 minutes` without prompting.

- [ ] **Step 1: Write the failing tests:**
  - `service: requestAllow shows and stores selectors`: selectors `{ username: '#e' }` → the approver's lines include `Selectors: username=#e`, and the stored entry has them. Selector values go through `clean()`.
  - `service: login uses the runner`: the fake runner gets the entry; `logged_in` → `logged in`; the V1 secret-leak tests stay green, rewritten for `login` deps.
  - `service: status shows mode`: → `vault: unlocked; mode: hardcore`; when locked → `ok: false`.
  - `control: unlock`: `approver.askPassword` → `'pw'` and `vault.unlock` true → `unlocked`; false → `wrong password` plus `limiter.fail`; null → `cancelled`. Audit gets `unlock` with no password.
  - `control: lock` → `locked`.
  - `control: mode`: `hardcore` saves with no prompt; `easy` on win32 requires `askPassword` + `verify`; `easy` on darwin → `{ ok: false, message: 'easy mode is not available on macOS' }` with no prompt.
  - `control: importV1 asks for each entry`: 3 entries (1 invalid) with the approver approving the first only → `imported 1 of 2`, and only that entry is stored.
- [ ] **Step 2: Run** `npx vitest run test/service.test.ts test/control.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `login`'s `already_logged_in` branch can stay; it is unreachable with fresh contexts but harmless.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(service): add control commands and wire core to the login runner`.

### Task 6: Entry points, CLI and V1 removal

**Files:**
- Create: `src/service/main.ts`, `src/cli.ts`, `src/platform/index.ts`
- Modify: `src/index.ts` (the thin MCP client), `src/mcp/server.ts` (text and `selectors`), `src/core/config.ts`, `package.json` (bin `u-chan`, version `2.0.0-dev.0`)
- Delete: `src/core/approver.ts`, `test/approver.test.ts`, `scripts/unlock.ps1`
- Test: `test/mcp.test.ts`, `test/e2e-core.test.ts`

**Interfaces:**
- Produces (config.ts): `serviceConfig(env, platform)` returns `{ home, allowlistPath, auditPath, settingsPath, bwDataDir, endpoint }`. `home` is `U_CHAN_HOME`, else win32 `%ProgramData%\u-chan-secrets`, else darwin `/Library/Application Support/u-chan-secrets`. `loadConfig` keeps only the user-side `chromeProfile` and `cdpEndpoint`.
- Produces (platform/index.ts): `platformAdapters(platform): { prompt: ProtectedPrompt; authorize: (s: net.Socket) => Promise<boolean> }`. For now it throws `UserFacingError('U-Chan V2 is not supported on <platform> yet')`; Plans 2–3 fill it in.
- Produces (cli.ts): `u-chan unlock | lock | mode <easy|hardcore> | import-v1 [path]`. `import-v1` reads the V1 `allowlist.json` (default `%APPDATA%\u-chan-secrets\allowlist.json`) and sends the parsed array. It prints the `ToolResult` message and exits with code 1 when `ok` is false.
- Produces (index.ts): `createMcpServer(withPlaywrightStatus(new IpcClient(endpoint), checkPlaywrightNow))`. `withPlaywrightStatus` appends `; playwright: …` to `status` exactly as V1 did.
- MCP `INSTRUCTIONS` last two lines become: `If the domain is not allowlisted, ask the user which Bitwarden item to use, then call request_allow; the user approves it in a U-Chan window.` and `If login fails, call status: a locked vault means the user must run u-chan unlock themselves. If login says "needs you", ask the user to sign in by hand.`

- [ ] **Step 1: Write the failing tests:**
  - `e2e-core: MCP → IPC → service`: start `startIpcServer` with a real `CoreService`/`ControlService` built from fakes (prompt, vault exec, runner); connect the MCP server from `createMcpServer(new IpcClient(path))` through the SDK's in-memory transport. `request_allow` → `approved`, `list_allowed` shows the domain, `login` → `logged in`, and the transcript of all tool results contains neither the fake password nor the session.
  - `mcp: request_allow accepts selectors` and the updated instruction text.
  - `cli: exits 1 on failure`: run `cli.ts` main with a fake client returning `ok: false` → exit code 1.
- [ ] **Step 2: Run** `npx vitest run`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the files. `service/main.ts` wires `serviceConfig` + `platformAdapters` + Tasks 1–5 and logs only to stderr.
- [ ] **Step 4: Run** `npm run build && npx vitest run`. Expected: build OK, all tests PASS.
- [ ] **Step 5: Commit** `feat: split into service and thin MCP client; retire V1 session file and dialog`.
