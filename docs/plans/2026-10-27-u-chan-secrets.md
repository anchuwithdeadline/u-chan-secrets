# U-Chan Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a local MCP server for Claude Code: the AI calls `login(domain)`, and U-Chan Secrets fetches the email/password from Bitwarden and fills them into the Chrome shared with Playwright MCP — the password never enters the model's context.

**Architecture:** Two layers. `src/core/` (vault, allowlist, approval, audit, form filling, `CoreService`) knows nothing about MCP; `src/mcp/` is a thin adapter that forwards tool calls to `CoreService`. Every core dependency goes through an interface in `src/core/types.ts`, so the core can later run as a separate process/service (IPC) without changing the adapter. Chrome runs with `--remote-debugging-port`; both Playwright MCP and U-Chan Secrets connect over CDP, so the signed-in session is shared.

**Tech Stack:** Node ≥ 20, TypeScript (ESM), `@modelcontextprotocol/sdk`, `playwright`, `zod`, `vitest`. Bitwarden CLI (`bw`) installed on the machine. Windows PowerShell 5.1 for the approval dialog.

**Spec:** `docs/specs/2026-10-27-u-chan-secrets-design.md`

## Global Constraints

- Display name: `U-Chan Secrets`; package/folder: `u-chan-secrets`.
- The password never appears in: a tool result, an error message, the audit log, the server's stdout/stderr. stdout is reserved for MCP stdio — all other logging goes to stderr and must also be secret-free.
- Credentials are filled only when the page's current hostname is in `entry.hosts` (exact match, no wildcard), re-checked before **every** fill.
- `loginUrl` must be `https:`.
- The AI has no tool to list vault items.
- `revoke` needs no approval; adding/changing an entry goes only through `requestAllow` + the Windows dialog.
- Data directory: `process.env.U_CHAN_HOME`, default `%APPDATA%\u-chan-secrets`. Inside: `allowlist.json`, `audit.log`, `bw-session`, `chrome-profile\`.
- CDP endpoint: `process.env.U_CHAN_CDP`, default `http://127.0.0.1:9222`.
- Chrome uses its own profile `<U_CHAN_HOME>\chrome-profile`, not the everyday profile.

## Review Focus

1. **Vault locked / session expired** → `login` returns `failed: vault locked — run scripts/unlock.ps1`, no crash, no session leak. (Task 3, Task 6)
2. **Login page redirects to a host not in `hosts`** (phishing, unknown SSO) → nothing is filled, returns `failed: unexpected host <host>`. (Task 5)
3. **Wrong password** → the login form is still there after submit → return `failed`, never `ok`. (Task 5)
4. **Already signed in** (loginUrl redirects straight to the dashboard, no password field) → return `ok: already logged in` without fetching credentials. (Task 5, Task 6)
5. **Item missing, or several items with the same name in Bitwarden** → `failed: item not found` / `failed: multiple items match, use the item id`, without leaking item data. (Task 3)

---

### Task 1: Scaffold, types, config, redact, audit

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/types.ts`, `src/core/config.ts`, `src/core/redact.ts`, `src/core/audit.ts`
- Test: `test/redact.test.ts`, `test/audit.test.ts`

**Interfaces:**
- Produces (`src/core/types.ts`):
  ```ts
  export interface AllowEntry { domain: string; hosts: string[]; loginUrl: string; item: string;
    selectors?: { username?: string; password?: string; submit?: string } }
  export interface Credentials { username: string; password: string }
  export type VaultStatus = 'unlocked' | 'locked' | 'unauthenticated' | 'unavailable'
  export interface VaultClient { status(): Promise<VaultStatus>; getLogin(item: string): Promise<Credentials> }
  export interface Approver { ask(title: string, lines: string[]): Promise<boolean> }
  export interface AuditLog { record(event: AuditEvent): Promise<void> }
  export type AuditEvent = { action: 'login' | 'request_allow' | 'revoke'; domain: string; result: string }
  export type ToolResult = { ok: boolean; message: string }
  export class UserFacingError extends Error {}   // message that is safe to return to the AI
  ```
- Produces (`config.ts`): `export function loadConfig(env = process.env): { home: string; allowlistPath: string; auditPath: string; sessionPath: string; chromeProfile: string; cdpEndpoint: string }`
- Produces (`redact.ts`): `export function redact(text: string, secrets: string[]): string` — replaces every occurrence of each non-empty secret with `[REDACTED]`.
- Produces (`audit.ts`): `export class FileAuditLog implements AuditLog { constructor(path: string) }` — appends one JSON line `{ts, action, domain, result}`, creating the directory if needed.

- [ ] **Step 1:** `git init`, create `package.json` (`"type": "module"`, scripts `build: tsc`, `test: vitest run`), install `@modelcontextprotocol/sdk playwright zod` and dev `typescript vitest @types/node`. `.gitignore`: `node_modules`, `dist`.
- [ ] **Step 2: Write failing tests**
  ```ts
  // redact.test.ts
  expect(redact('pw=hunter2 again hunter2', ['hunter2'])).toBe('pw=[REDACTED] again [REDACTED]')
  expect(redact('abc', [''])).toBe('abc')
  // audit.test.ts — write 2 events to a temp file, read back 2 JSON lines with ts, action, domain, result
  ```
- [ ] **Step 3:** `npx vitest run` → FAIL (module missing).
- [ ] **Step 4:** Implement `types.ts`, `config.ts`, `redact.ts`, `audit.ts`.
- [ ] **Step 5:** `npx vitest run` → PASS; `npx tsc --noEmit` → no errors.
- [ ] **Step 6:** Commit `chore: scaffold u-chan-secrets core types, config, redact, audit`.

### Task 2: Allowlist store

**Files:**
- Create: `src/core/allowlist.ts`
- Test: `test/allowlist.test.ts`

**Interfaces:**
- Consumes: `AllowEntry`, `UserFacingError`.
- Produces:
  ```ts
  export class AllowlistStore {
    constructor(path: string)
    list(): Promise<AllowEntry[]>
    get(domain: string): Promise<AllowEntry | undefined>
    upsert(entry: AllowEntry): Promise<void>   // atomic write: temp file, then rename
    remove(domain: string): Promise<boolean>
  }
  export function isHostAllowed(entry: AllowEntry, url: string): boolean
  export function buildEntry(domain: string, loginUrl: string, item: string, existing?: AllowEntry): AllowEntry
  ```
  `buildEntry`: throws `UserFacingError` if `loginUrl` is not `https:`; `hosts` = union of `existing?.hosts`, `domain`, and the `loginUrl` hostname (lowercase, deduplicated). The domain is normalized to lowercase, stripping `https://` and any path if the AI passes a URL by mistake.

- [ ] **Step 1: Write failing tests**
  ```ts
  isHostAllowed({hosts:['admin.example.com'], ...}, 'https://admin.example.com/login') === true
  isHostAllowed(same, 'https://evil.example.com/login') === false        // no wildcard
  isHostAllowed(same, 'https://admin.example.com.evil.com/') === false
  isHostAllowed(same, 'http://admin.example.com/') === false              // https only
  buildEntry('admin.example.com','http://x', 'item') throws UserFacingError
  buildEntry('admin.example.com','https://auth.example.com/login','Example').hosts
    => ['admin.example.com','auth.example.com']
  store: upsert → get returns the entry; remove → true, then get is undefined; missing file → list() = []
  ```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: allowlist store with exact host matching`.

### Task 3: Bitwarden vault client

**Files:**
- Create: `src/core/vault.ts`
- Create: `scripts/unlock.ps1`
- Test: `test/vault.test.ts`

**Interfaces:**
- Consumes: `VaultClient`, `Credentials`, `VaultStatus`, `UserFacingError`.
- Produces:
  ```ts
  export type Exec = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>
  export class BitwardenVault implements VaultClient {
    constructor(opts: { sessionPath: string; exec?: Exec })   // default exec: execFile('bw', args), no shell
  }
  ```
  Session: read `BW_SESSION` from the environment if present, otherwise read the `sessionPath` file (trimmed). Pass it to `bw` through the `BW_SESSION` environment variable, never through argv.
  `status()`: `bw status` → parse JSON `.status`; `bw` cannot run → `'unavailable'`.
  `getLogin(item)`: `bw get item <item>`; error containing `More than one result` → `UserFacingError('multiple items match, use the item id')`; `Not found` → `UserFacingError('item not found')`; locked → `UserFacingError('vault locked — run scripts/unlock.ps1')`; item without `login.username`/`login.password` → `UserFacingError('item has no username/password')`. Every other error message goes through `redact` with the session and never includes stdout.
- `scripts/unlock.ps1`: runs `bw unlock --raw` (bw prompts for the master password itself) and writes the output to `<U_CHAN_HOME>\bw-session`; the `-Lock` switch runs `bw lock` and deletes the file.

- [ ] **Step 1: Write failing tests** with a fake `exec`:
  - status JSON `{"status":"unlocked"}` → `'unlocked'`; exec throws ENOENT → `'unavailable'`.
  - `get item` returns JSON `{login:{username:'u@x',password:'p'}}` → `{username:'u@x',password:'p'}`.
  - stderr `More than one result was found` → throws `UserFacingError` with message `multiple items match, use the item id`.
  - stderr `Not found.` → `item not found`; stderr `Vault is locked.` → `vault locked — run scripts/unlock.ps1`.
  - Exec receives `env.BW_SESSION === 'S'` when the session file contains `S\n`; `args` does not contain `'S'`.
  - An unexpected error whose stderr contains session `S` → the message does not contain `S`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `vault.ts` and `unlock.ps1`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: bitwarden vault client via bw CLI`.

### Task 4: Windows approval dialog

**Files:**
- Create: `src/core/approver.ts`
- Test: `test/approver.test.ts`

**Interfaces:**
- Consumes: `Approver`.
- Produces: `export class WindowsDialogApprover implements Approver { constructor(opts?: { spawnPs?: SpawnPs; timeoutMs?: number }) }` (default timeout 120000 → treated as a denial).
  Approach: spawn `powershell.exe -NoProfile -NonInteractive -Command <fixed script>`; the displayed text is passed through the `UCS_TITLE` / `UCS_BODY` environment variables (body = `lines.join('\n')`). **Never interpolate AI-supplied strings into the script** (prevents PowerShell injection). The script uses a `System.Windows.Forms.MessageBox` with Yes/No, a Warning icon, default button = No, TopMost window; it prints `YES` or `NO`. Only `YES` → `true`.

- [ ] **Step 1: Write failing tests** with a fake `spawnPs`: stdout `YES\r\n` → true; `NO` → false; timeout → false; when `lines` contains `"; Remove-Item C:\ ; "`, the script argument passed to `spawnPs` is identical to the fixed script and the string appears only in the `UCS_BODY` environment variable.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Manual check: `node -e` calling `ask('U-Chan Secrets', ['test'])` → the dialog appears on top, and Yes/No give the right result.
- [ ] **Step 5:** Commit `feat: windows native approval dialog`.

### Task 5: Login filler (Playwright)

**Files:**
- Create: `src/core/login-filler.ts`
- Test: `test/login-filler.test.ts`, `test/fixtures/server.ts` (a local HTTP server serving sample login pages)

**Interfaces:**
- Consumes: `AllowEntry`, `Credentials`, `isHostAllowed`.
- Produces:
  ```ts
  export type FillOutcome = { status: 'logged_in' | 'already_logged_in' | 'failed'; reason?: string }
  export async function fillLogin(page: Page, entry: AllowEntry,
    getCreds: () => Promise<Credentials>, opts?: { timeoutMs?: number; hostCheck?: (url: string) => boolean }): Promise<FillOutcome>
  ```
  `hostCheck` defaults to `url => isHostAllowed(entry, url)`; tests pass a function that allows `http://127.0.0.1:<port>`.
  Algorithm:
  1. `page.goto(entry.loginUrl)`, wait for load. If `hostCheck(page.url())` is false → `failed: unexpected host <hostname>`.
  2. If neither a username field nor a password field is visible → `already_logged_in` (do **not** call `getCreds`).
  3. Call `getCreds()` once.
  4. Username field: `selectors.username`, or the first visible input matching `[autocomplete=username], [type=email], [name*=email i], [name*=user i], [id*=email i]`. Password field: `selectors.password` or `input[type=password]:visible`. Submit: `selectors.submit` or `button[type=submit], input[type=submit]`, falling back to pressing Enter.
  5. If both fields are visible: check host → fill username → fill password → submit **back to back in a single call** (no control handed back in between).
  6. If only the username field is present (split form): check host → fill → submit → wait for `input[type=password]` to be visible (timeout) → check host again → fill password → submit.
  7. Wait for navigation/network idle. If the password field is still visible → `failed: login form still present (wrong password?)`. Otherwise → `logged_in`.
  `reason` never contains a credential value.

- [ ] **Step 1: Write the fixture server** with these pages: `/single` (email+password; a POST with `u@x`/`pw` → redirect to `/dash`, otherwise the form re-renders), `/two-step` (step 1 email, step 2 password), `/already` (redirects straight to `/dash`), `/redirect-evil` (redirects to `http://localhost:<port>/single` — a different host from `127.0.0.1`).
- [ ] **Step 2: Write failing tests** (Playwright chromium headless):
  - `/single` with correct creds → `logged_in`, page at `/dash`.
  - `/single` with a wrong password → `failed`, reason contains `login form still present` and not the password.
  - `/two-step` → `logged_in`.
  - `/already` → `already_logged_in`, `getCreds` not called.
  - `/redirect-evil` → `failed: unexpected host localhost`, `getCreds` not called, no POST request reaches the server.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit `feat: playwright login filler with host checks and two-step support`.

### Task 6: CoreService

**Files:**
- Create: `src/core/browser.ts`, `src/core/service.ts`
- Test: `test/service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces (`browser.ts`): `export interface BrowserProvider { withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>; connected(): Promise<boolean> }` and `export class CdpBrowserProvider implements BrowserProvider { constructor(endpoint: string) }` — `chromium.connectOverCDP`, uses `contexts()[0]` (the default context, whose cookies are shared with Playwright MCP), opens a new tab, runs `fn`, closes the tab. Connection failure → `UserFacingError('Chrome is not running — run scripts/start-chrome.ps1')`.
- Produces (`service.ts`):
  ```ts
  export class CoreService {
    constructor(deps: { vault: VaultClient; allowlist: AllowlistStore; approver: Approver; audit: AuditLog; browser: BrowserProvider })
    login(domain: string): Promise<ToolResult>
    requestAllow(domain: string, loginUrl: string, item: string): Promise<ToolResult>
    revoke(domain: string): Promise<ToolResult>
    listAllowed(): Promise<ToolResult>   // message: one line per entry, "domain — item — hosts"
    status(): Promise<ToolResult>        // vault status + chrome connected
  }
  ```
  `CoreService` is the future IPC boundary: it only takes and returns serializable types.
  - `login`: domain not in the allowlist → `{ok:false, message:'domain is not allowlisted — use request_allow'}`. Otherwise `browser.withPage(page => fillLogin(page, entry, () => vault.getLogin(entry.item)))`. `logged_in` → `ok: logged in`; `already_logged_in` → `ok: already logged in`; `failed` → `{ok:false}`.
  - `requestAllow`: `buildEntry` (error → `{ok:false}`), then `approver.ask('U-Chan Secrets', ['Allow the AI to sign in?', 'Domain: …', 'Login URL: …', 'Bitwarden item: …', 'Hosts: …'])`. true → `upsert`, `approved`; false → `denied`.
  - Every method catches errors; `UserFacingError` → return its message; any other error → `{ok:false, message:'internal error'}` with the `redact`ed details logged to stderr. Write audit entries for login/request_allow/revoke.

- [ ] **Step 1: Write failing tests** with a fake vault/approver/audit/browser (the fake browser calls `fn` with a page from the Task 5 fixture server, or `fillLogin` is stubbed via a module mock):
  - `login` for an unknown domain → ok=false, the vault is not called.
  - Successful `login` → `{ok:true, message:'logged in'}`, the audit records `{action:'login', result:'ok'}`.
  - Fake vault throws `UserFacingError('vault locked — run scripts/unlock.ps1')` → exactly that message.
  - Fake vault throws `Error('boom hunter2')` with password `hunter2` → message `internal error`; the JSON of the whole result does not contain `hunter2`.
  - `requestAllow` with approver=false → `denied`, the allowlist is unchanged; approver=true → the entry is in `list()`.
  - `requestAllow` with `http://` → ok=false, the approver is not called.
  - `revoke` → the entry is removed, the approver is not called.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: core service orchestrating login and allowlist`.

### Task 7: MCP adapter and entrypoint

**Files:**
- Create: `src/mcp/server.ts`, `src/index.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `CoreService`, `loadConfig` and the concrete classes.
- Produces: `export function createMcpServer(core: Pick<CoreService, 'login'|'requestAllow'|'revoke'|'listAllowed'|'status'>): McpServer`. Tools (exact names, zod schemas):
  - `login` `{ domain: string }`
  - `request_allow` `{ domain: string, login_url: string, item: string }` — the description states that a dialog will ask the user to approve, and that item is the Bitwarden item name/ID provided by the user.
  - `revoke` `{ domain: string }`
  - `list_allowed` `{}`
  - `status` `{}`
  Each tool returns `{ content: [{ type: 'text', text: message }], isError: !ok }`. The `login` description says: once it returns `ok`, use Playwright MCP to keep browsing.
  `src/index.ts`: builds the dependencies from `loadConfig()` and connects a `StdioServerTransport`. No `console.log` (stdout is the MCP channel).

- [ ] **Step 1: Write failing tests**: use the SDK's `InMemoryTransport` + `Client` with a fake core; `listTools` has exactly the 5 names above; calling `login` → text = the core's message; core returns ok=false → `isError: true`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; `npm run build` → `dist/index.js` exists.
- [ ] **Step 5:** Commit `feat: mcp adapter exposing u-chan-secrets tools`.

### Task 8: Startup scripts, README, end-to-end check

**Files:**
- Create: `scripts/start-chrome.ps1`, `README.md`

**Interfaces:**
- Consumes: `dist/index.js`, `scripts/unlock.ps1`.

- [ ] **Step 1:** `scripts/start-chrome.ps1`: find `chrome.exe` (Program Files / LocalAppData) and run it with `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=<U_CHAN_HOME>\chrome-profile --no-first-run`. If port 9222 is already open, do not start another one.
- [ ] **Step 2:** `README.md`: install `bw` and run `bw login`; the daily routine (`start-chrome.ps1`, `unlock.ps1`); MCP registration:
  ```
  claude mcp add u-chan-secrets -- node <path-to>\u-chan-secrets\dist\index.js
  claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
  ```
  (reconfigure the existing Playwright MCP instead of adding a second one); threat model v1 (prevents accidental leaks, not a tricked AI — see spec §5b); how to revoke access (`revoke`, editing `allowlist.json`).
- [ ] **Step 3: Real E2E:** start Chrome + unlock; in Claude Code: `status` → unlocked + connected; `request_allow("admin.example.com", "<login url>", "<item>")` → the dialog appears, click Yes; `login("admin.example.com")` → `logged in`; Playwright MCP `browser_navigate` to the admin page → the signed-in UI is visible; take a screenshot.
- [ ] **Step 4: Leak check:** grep for the real password in `audit.log`, the Claude Code transcript of the test session (`~/.claude/projects/...`) and the stderr log → no hits.
- [ ] **Step 5:** Commit `docs: startup scripts and README`.
