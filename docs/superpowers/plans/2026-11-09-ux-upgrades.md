# UX Upgrades (High + Medium) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the most common "what do I do now" moments in install, update, setup, allow and login.

**Architecture:** Small, local changes: one new module for the service-side Bitwarden login, one for login next-step hints. Everything else edits existing CLI/update/MCP/grant code. No native helper or dependency changes, so a coordinated `u-chan update` can ship this release; only Task 1's effect appears on the next `u-chan install`.

**Tech Stack:** TypeScript (ESM, Node ≥24), vitest, `@modelcontextprotocol/sdk`, zod.

**Spec:** No separate spec. This plan implements items 1–9 of the UX review from 2026-11-09 (copied below as the requirement list).

| # | Requirement | Task |
|---|---|---|
| 1 | `install` performs the service-side `bw login` itself | 1 |
| 2 | Update output names the exact path and commands for this machine | 2, 3 |
| 3 | Launcher repair after update | already done: `desktopUpdateAdapter.repair()` (`src/client/update-package.ts:101`) runs `configureWindowsCommand(true, …)` after every desktop install. Only a README fix (Task 3). |
| 4 | Clear "restart AI session" line | 3 |
| 5 | Every login failure code carries a next step | 4 |
| 6 | Nudge toward a success condition | 4 |
| 7 | `allow` infers domain from `--login-url` | 5 (item picker deferred, see below) |
| 8 | A once-grant is not used up when credentials were never requested | 6 |
| 9 | `needs_human` tells the AI how to continue | 4 |

**Deferred:** a protected item picker for `allow --item` (item 7, second half). It needs vault listing in the service plus a native prompt-helper change, so it would require a trusted reinstall. Plan it separately.

## Global Constraints

- Node `>=24`; no new dependencies.
- No change to native helper sources (`src/platform/windows/assets/*`) or to `package.json` dependencies, so the release stays coordinated-update compatible.
- Never print, return or log a password, TOTP, vault session key or bot token. Messages may name commands and versions only.
- Existing machine-readable outputs keep working: `u-chan update --check --json` and `u-chan update --json` print the exact JSON `runCoordinatedUpdate` returns today; `u-chan start` keeps calling `update(true, true)` and parsing JSON.
- MCP result text format stays `[code] message`; hints are appended as a new line `Next: <hint>`.
- Each task adds one bullet to a `## Unreleased` section at the top of `CHANGELOG.md` (create it in the first task that runs).
- Test command: `npx vitest run <file>`; full suite `npm test`; type check `npx tsc -p tsconfig.json --noEmit`.

## Review Focus

1. **`bw login` session key printed to the terminal.** `bw login` prints a working `BW_SESSION` value. Expected: the installer runs `bw lock` right after a successful login so the printed key is dead. Pinned in Task 1 test `locks the private vault right after login`.
2. **Non-interactive install** (CI, piped stdin). Expected: no hang waiting for a password; print the manual command and continue. Pinned in Task 1 test `skips login without a TTY`.
3. **Once-grant refund replay.** An AI looping `login` on a page that shows a CAPTCHA before any fill. Expected: the grant is refunded only when `getCreds` was never called, and only if the stored entry still has the same `grantId`. A revoke or a new approval in between must not be resurrected. Pinned in Task 6 test `does not refund a replaced grant`.
4. **`--json` scripts on `update`.** Someone parses `u-chan update --check` output. Expected: `--json` gives the old JSON byte for byte; the human text is the new default. Pinned in Task 3 test `update --check --json prints raw plan`.
5. **`allow` with a subdomain login URL** (`https://accounts.example.com/login`). Expected: inferred domain is the URL host `accounts.example.com`, not a guessed parent; an explicit positional domain still wins. Pinned in Task 5 test `infers the domain from the login URL host`.

---

### Task 1: Service-side Bitwarden login during install

**Files:**
- Create: `src/platform/service-bw-login.ts`
- Modify: `src/cli.ts` (install branch, after `r.ok` and before `printDoctor`, near line 270)
- Modify: `README.md` (Install step 2: replace both manual `bw login` blocks with "install runs it; manual fallback:" plus the old commands)
- Test: `test/service-bw-login.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BwRun = (args: string[], opts: { interactive: boolean }) => Promise<{ code: number; stdout: string }>
  export interface BwLoginDeps { run: BwRun; interactive: boolean; manualCommand: string; out(line: string): void }
  export type BwLoginOutcome = 'already' | 'logged_in' | 'skipped' | 'failed'
  export function ensureServiceBitwardenLogin(d: BwLoginDeps): Promise<BwLoginOutcome>
  export function serviceBwRunner(bwPath: string, dataDir: string, env: NodeJS.ProcessEnv): BwRun
  export function serviceBwPaths(platform: NodeJS.Platform): { bwPath: string; dataDir: string; manualCommand: string } | null
  ```
- Consumes: `defaultProgramData()` from `src/platform/windows/install.ts`; macOS home `'/Library/Application Support/u-chan-secrets'` (same literal as `src/platform/darwin/lifecycle.ts:113`).

- [ ] **Step 1: Write the failing tests** in `test/service-bw-login.test.ts`

```ts
const status = (s: string) => ({ code: 0, stdout: JSON.stringify({ status: s }) })
it('does nothing when already logged in', async () => {
  const run = vi.fn(async () => status('locked'))
  expect(await ensureServiceBitwardenLogin({ run, interactive: true, manualCommand: 'M', out: vi.fn() })).toBe('already')
  expect(run).toHaveBeenCalledOnce()
})
it('locks the private vault right after login', async () => {
  const run = vi.fn(async (a: string[]) => a[0] === 'status' ? status('unauthenticated') : { code: 0, stdout: '' })
  expect(await ensureServiceBitwardenLogin({ run, interactive: true, manualCommand: 'M', out: vi.fn() })).toBe('logged_in')
  expect(run.mock.calls.map(c => c[0][0])).toEqual(['status', 'login', 'lock'])
  expect(run.mock.calls[1][1]).toEqual({ interactive: true })
})
it('skips login without a TTY and prints the manual command', async () => {
  const run = vi.fn(async () => status('unauthenticated')), out = vi.fn()
  expect(await ensureServiceBitwardenLogin({ run, interactive: false, manualCommand: 'MANUAL', out })).toBe('skipped')
  expect(out.mock.calls.flat().join('\n')).toContain('MANUAL')
  expect(run).toHaveBeenCalledOnce()
})
it('reports failure and the manual command when login exits non-zero or bw is missing', async () => {
  // login code 1 -> 'failed', no 'lock' call; run throwing on status -> 'failed'; both print manualCommand
})
it('runner removes BW_SESSION and sets the private data dir', () => {
  // serviceBwRunner('bw', 'D', { BW_SESSION: 'x', PATH: 'p' }): spy spawn/execFile env has no BW_SESSION, BITWARDENCLI_APPDATA_DIR === 'D'
})
```

- [ ] **Step 2: Run** `npx vitest run test/service-bw-login.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/platform/service-bw-login.ts`.**
  Flow: `run(['status'])` and read `JSON.parse(stdout).status`. Anything except `unauthenticated` means `'already'`. For `unauthenticated` without `interactive`, print `Bitwarden service login still needed. From this elevated terminal run:\n${manualCommand}` and return `'skipped'`. Otherwise run `run(['login'], { interactive: true })`; on code 0, run `run(['lock'])` and return `'logged_in'`. A throw or a non-zero code prints the same manual-command line and returns `'failed'`.
  `serviceBwRunner`: build the env as a copy of `env` without `BW_SESSION`, plus `BITWARDENCLI_APPDATA_DIR: dataDir`. Interactive calls use `spawn(bwPath, args, { stdio: 'inherit', env, windowsHide: false })` and resolve the exit code. Other calls use `execFile` with `{ timeout: 30000, maxBuffer: 65536 }`.
  `serviceBwPaths`: on `win32`, `bw.exe` and `bw-data` under `defaultProgramData()`, with `manualCommand` set to the three README PowerShell lines. On `darwin`, `bin/bw` and `bw-data` under the macOS home, with the README `sudo env -u BW_SESSION …` line. Any other platform returns `null`.

- [ ] **Step 4: Wire into `src/cli.ts`.** After a successful real install (`r.ok && cmd === 'install' && !d.install`), call `serviceBwPaths(d.platform)`. When it is non-null, run `ensureServiceBitwardenLogin({ run: serviceBwRunner(p.bwPath, p.dataDir, d.env), interactive: !!process.stdin.isTTY, manualCommand: p.manualCommand, out: d.out })`, then `printDoctor`. The outcome never changes the exit code.

- [ ] **Step 5: Run** `npx vitest run test/service-bw-login.test.ts test/cli-lifecycle.test.ts`. Expected: PASS.

- [ ] **Step 6: Update the README and CHANGELOG** (`- u-chan install now runs the service Bitwarden login itself when needed and locks it right after, so the printed session key is unusable.`). Commit:

```bash
git add src/platform/service-bw-login.ts src/cli.ts test/service-bw-login.test.ts README.md CHANGELOG.md
git commit -m "feat(install): run service Bitwarden login during install"
```

---

### Task 2: Exact trusted-reinstall steps in update failures

**Files:**
- Modify: `src/client/update.ts` (bootstrap failure at line ~31, incompatible failure at line ~37)
- Modify: `src/cli.ts:176` (`start` incompatible message)
- Test: `test/client-update.test.ts`, `test/cli-start.test.ts`

**Interfaces:**
- Produces: `export function trustedReinstallSteps(version: string): string` in `src/client/update.ts`.
  Exact copy:
  ```
  Trusted reinstall required for ${version}.
  1. Elevated terminal, in a reviewed u-chan-secrets ${version} checkout: npm ci; npm run build; node dist/cli.js install
  2. Normal terminal: npm.cmd install --global u-chan-secrets@${version}; u-chan.cmd setup --apply; u-chan unlock
  ```

- [ ] **Step 1: Write the failing tests**
  - `bootstrap failure names desktop version and steps`: capabilities without `coordinated_update` and desktop identity `5.1.2`. Expect `ok: false`, the message starts with `coordinated updater bootstrap required`, and it contains `trustedReinstallSteps('5.1.2')`.
  - `incompatible plan names target version and steps`: plan `compatible: false, reason: 'native_helpers_changed'`, target `5.2.0`. Expect the message to contain `native_helpers_changed`, `trustedReinstallSteps('5.2.0')` and `no components changed`.
  - In `test/cli-start.test.ts`, `start reports reinstall steps for incompatible update`: the err output contains `u-chan-secrets@5.2.0`.

- [ ] **Step 2: Run** `npx vitest run test/client-update.test.ts test/cli-start.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** In `runCoordinatedUpdate`, read `d.desktop.identity()` before the bootstrap check (wrap it in try; fall back to the text `the current release`). Append `'\n' + trustedReinstallSteps(...)` to both failures. Do the same for the `!plan.compatible` branch only. The `local_ahead`/`identity_unknown` messages stay as they are. Add `target: { version: string }` to the `start` plan type and use `trustedReinstallSteps(plan.target.version)` in `src/cli.ts:176`.

- [ ] **Step 4: Run** the same tests and `npx vitest run test/client-update.test.ts`. Expected: PASS, with the old tests still green.

- [ ] **Step 5: Add the CHANGELOG line and commit**

```bash
git commit -am "feat(update): print exact trusted-reinstall steps"
```

---

### Task 3: Human-readable update and setup output with restart line

**Files:**
- Modify: `src/cli.ts` (update branch at lines 77–82, setup plain output at line 156)
- Modify: `src/client/setup.ts` (export the constant)
- Modify: `README.md` (Daily commands: `update [--check] [--json]`; drop "Rerun setup after an npm installation or update recreates the PowerShell launcher" for the `u-chan update` path, keep it for a manual `npm install`)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `trustedReinstallSteps` (Task 2); `runCoordinatedUpdate` JSON shapes (check: `{service, target, decision, compatible, reason, desktop, desktopDecision, readOnly}`; apply: `{status:'complete', desktop, service, vault, agentSessionRestartRequired, manualSetupRequired}`).
- Produces:
  - `export const RESTART_LINE = 'Restart your Claude Code and Codex sessions now so they load the updated U-Chan MCP server.'` in `src/client/setup.ts`
  - `export function formatUpdate(message: string, checkOnly: boolean): string` in `src/cli.ts` (returns `message` unchanged if it is not JSON)

- [ ] **Step 1: Write the failing tests** in `test/cli.test.ts` using `deps.update` stubs:
  - `update --check prints a plan summary`: the stub returns a check JSON with service `5.1.1`, desktop `5.1.1`, target `5.1.2`, `update_required` and compatible. The out lines must equal `['Service: 5.1.1 -> 5.1.2 (update_required)', 'Desktop: 5.1.1 -> 5.1.2 (update_required)', 'Run u-chan update to apply.']`.
  - Both components `up_to_date` give the last line `Up to date.`. `compatible: false` makes the last lines `trustedReinstallSteps('5.1.2')`.
  - `update prints completion and restart line`: an apply JSON with `agentSessionRestartRequired: true, manualSetupRequired: true, vault: 'unlocked'` gives `['Update complete: 5.1.2. Vault: unlocked.', RESTART_LINE, 'Run u-chan setup --apply to repair AI client registrations.']`.
  - `update --check --json prints raw plan`: out equals the stub message exactly. The same holds for `update --json`.
  - `update` with any other argument combination prints `usage: u-chan update [--check] [--json]` and exits 1.
  - `setup prints restart line when required`: `deps.setup` returns `restartRequired: true`, and the last plain line is `RESTART_LINE`. It is absent when `false` and absent with `--json`.

- [ ] **Step 2: Run** `npx vitest run test/cli.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** Parse `--check` and `--json` in any order, each at most once. Print through `formatUpdate` unless `--json` is set. Error results stay unformatted text. In the setup plain branch, push `RESTART_LINE` when `r.restartRequired`. Update the `USAGE` string to `update [--check] [--json]`.

- [ ] **Step 4: Run** `npx vitest run test/cli.test.ts test/cli-start.test.ts`. Expected: PASS (`start` still parses JSON because it calls `update()` directly, not the CLI branch).

- [ ] **Step 5: Update the README and CHANGELOG, then commit**

```bash
git commit -am "feat(cli): readable update output and explicit restart line"
```

---

### Task 4: Next-step hints on MCP results

**Files:**
- Create: `src/core/result-hints.ts`
- Modify: `src/mcp/server.ts` (`run()` at line 10; `request_allow` handler at line 90)
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `ResultCode`, `ToolResult` from `src/core/types.ts`.
- Produces: `export const NEXT_STEP: Partial<Record<ResultCode, string>>` and `export function resultText(r: ToolResult): string` (returns `[code] message` plus `\nNext: <hint>` when a hint exists).

Exact hint copy (these strings are the spec; tests compare them):

| Code | Hint |
|---|---|
| `grant_missing` | `Ask the user which Bitwarden item to use, then call request_allow.` |
| `grant_expired`, `grant_exhausted` | `Call request_allow again; the user must approve a new grant.` |
| `vault_locked` | `Call request_unlock once (or ask the user to run u-chan unlock), then retry login.` |
| `vault_unauthenticated` | `Ask the user to rerun u-chan install from an elevated terminal to finish the service Bitwarden login.` |
| `vault_unavailable` | `Ask the user to run u-chan doctor.` |
| `chrome_unavailable`, `browser_unavailable` | `Ask the user to run u-chan setup --start-browser, then retry login.` |
| `needs_human` | `Ask the user to finish signing in by hand in the dedicated browser, then continue with Playwright. No further U-Chan call is needed.` |
| `unsupported_form` | `Ask the user to sign in by hand in the dedicated browser, then continue with Playwright.` |
| `authentication_unconfirmed` | `Check the page with Playwright. If it is signed in, call request_allow again with success.url set to that page URL so future logins are confirmed.` |
| `destination_unconfirmed`, `session_transfer_failed` | `Check the page with Playwright before continuing; do not retry login blindly.` |
| `success_condition_failed` | `Ask the user whether the approved success condition is still correct; propose a new one with request_allow if not.` |
| `login_timeout` | `Retry login once; if it times out again, call status.` |
| `unsupported_service` | `Ask the user to run u-chan update.` |

- [ ] **Step 1: Write the failing tests** in `test/mcp.test.ts`
  - `appends next step for needs_human`: login returns `{ ok:false, code:'needs_human', message:'needs you' }`. The text must equal `'[needs_human] needs you\nNext: ' + NEXT_STEP.needs_human`.
  - `no hint for codes without one`: `internal_error` gives exactly `'[internal_error] x'`.
  - `every RESULT_CODES entry except invalid_policy and internal_error has a hint`: loop over `RESULT_CODES`.
  - `request_allow without success adds a note`: ok result, no `success` arg. The text ends with `\nNote: no success condition; login may return authentication_unconfirmed.` It is absent when `success` is given and absent on `ok:false`.

- [ ] **Step 2: Run** `npx vitest run test/mcp.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `result-hints.ts` from the table. In `run()`, use `resultText(r)`. In the `request_allow` handler, wrap the result: when `r.ok && !success`, append the note.

- [ ] **Step 4: Update the `INSTRUCTIONS` line** in `src/mcp/server.ts:26`. Replace `If login says "needs you", ask the user to sign in by hand.` with `Follow the "Next:" line of a failed result.` Run `npx vitest run test/mcp.test.ts`. Expected: PASS, with existing assertions on `[code] message` updated only where a hint now follows.

- [ ] **Step 5: Add the CHANGELOG line and commit**

```bash
git add src/core/result-hints.ts src/mcp/server.ts test/mcp.test.ts CHANGELOG.md
git commit -m "feat(mcp): add next-step hints to failed results"
```

---

### Task 5: `allow` infers the domain from `--login-url`

**Files:**
- Modify: `src/client/allow.ts` (`parseAllowArgs`)
- Modify: `src/cli.ts` (allow usage string, line ~111)
- Modify: `README.md` (Daily commands `allow [<domain>] --login-url …`; one example without a domain)
- Test: `test/cli-allow.test.ts`

**Interfaces:**
- Produces: `parseAllowArgs(args: string[])`, same return type. When `args[0]` starts with `--`, the domain becomes `new URL(loginUrl).hostname`.

- [ ] **Step 1: Write the failing tests**
  - `infers the domain from the login URL host`: `parseAllowArgs(['--login-url','https://accounts.example.com/login','--item','A'])?.domain` is `'accounts.example.com'`.
  - An explicit domain still wins: `parseAllowArgs(base)?.domain` is `'example.com'`.
  - A missing `--login-url` with no domain gives `null`.
  - Add `['--item','A']` and `['--login-url','https://user:SECRET@example.com','--item','A']` to the existing `bad` list.

- [ ] **Step 2: Run** `npx vitest run test/cli-allow.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Split off the positional argument only when it does not start with `--`. After the login URL validates, derive the domain from it and pass both through the existing domain checks and `buildEntry`.

- [ ] **Step 4: Run** `npx vitest run test/cli-allow.test.ts`. Expected: PASS.

- [ ] **Step 5: Update the README and CHANGELOG, then commit**

```bash
git commit -am "feat(allow): infer domain from --login-url"
```

---

### Task 6: Refund a once-grant when credentials were never requested

**Files:**
- Modify: `src/service/grants.ts` (add `refund`)
- Modify: `src/core/service.ts:98-110` (track credential use; change the approval copy at line 138)
- Modify: `README.md` (grant table `once` row), `SECURITY.md` if it states the old rule (`grep -n "reserved attempt" SECURITY.md README.md`)
- Test: `test/grants.test.ts`, `test/service.test.ts`

**Interfaces:**
- Produces: `GrantCoordinator.refund(reserved: AllowEntry): Promise<void>`. It restores `remainingUses` to `reserved.remainingUses` only when the stored entry exists, has the same `grantId`, and has `remainingUses === reserved.remainingUses - 1`. Otherwise it does nothing.
- Consumes: the `AllowEntry` that `reserve()` returns (the pre-decrement entry).

New approval copy (replaces `Duration: one login attempt; a failed reserved attempt also counts.`):
`Duration: one login attempt; it is used once the password is requested, even if sign-in then fails.`

- [ ] **Step 1: Write the failing tests**
  - `test/grants.test.ts` `refunds an unused once reservation`: after `reserve` and `refund`, `remainingUses` is `1`.
  - `does not refund a replaced grant`: after reserve, upsert the entry with a new `grantId`, then refund. The stored entry is unchanged. The same holds after `store.remove(domain)`: still absent.
  - `test/service.test.ts` `once grant survives a failure before credentials`: the login runner returns `{status:'failed', code:'needs_human'}` without calling `getCreds`. A second `login` is then not `grant_exhausted`.
  - `once grant is consumed after credentials are requested`: the runner calls `getCreds()` and then fails. The second login is `grant_exhausted`.
  - `runner throw before credentials refunds`: the runner throws before `getCreds`. The grant is refunded and the error result is unchanged.
  - The approval prompt lines contain the new copy exactly.

- [ ] **Step 2: Run** `npx vitest run test/grants.test.ts test/service.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** In `login`, keep `const reserved = await this.grants.reserve(entry.domain)` and set `let credsRequested = false`, with `credsRequested = true` as the first line of `getCreds`. Wrap `this.deps.login.run(...)` in try/finally. If the status is not `logged_in`/`already_logged_in` (or the call threw) and `!credsRequested` and `reserved.remainingUses !== undefined`, run `await this.grants.refund(reserved)`. This stays inside the `guarded` callback, so it runs on the same grant queue. Replace the prompt copy.

- [ ] **Step 4: Run** `npm test` and `npx tsc -p tsconfig.json --noEmit`. Expected: all PASS.

- [ ] **Step 5: Update the README, SECURITY and CHANGELOG, then commit**

```bash
git commit -am "feat(grants): keep once-grant when credentials were never requested"
```
