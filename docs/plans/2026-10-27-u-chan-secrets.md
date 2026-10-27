# U-Chan Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP server local cho Claude Code: AI gọi `login(domain)`, U-Chan Secrets lấy email/mật khẩu từ Bitwarden và điền vào Chrome dùng chung với Playwright MCP — mật khẩu không bao giờ đi vào context của model.

**Architecture:** Hai lớp. `src/core/` (vault, allowlist, approval, audit, điền form, `CoreService`) không biết gì về MCP; `src/mcp/` là adapter mỏng chuyển tool call sang `CoreService`. Mọi phụ thuộc của core đi qua interface trong `src/core/types.ts` để sau này core có thể chạy thành process/service riêng (IPC) mà adapter không đổi. Chrome chạy với `--remote-debugging-port`; cả Playwright MCP và U-Chan Secrets kết nối qua CDP nên phiên đăng nhập dùng chung.

**Tech Stack:** Node ≥ 20, TypeScript (ESM), `@modelcontextprotocol/sdk`, `playwright`, `zod`, `vitest`. Bitwarden CLI (`bw`) cài sẵn trên máy. Windows PowerShell 5.1 cho hộp thoại duyệt.

**Spec:** `docs/specs/2026-10-27-u-chan-secrets-design.md`

## Global Constraints

- Tên sản phẩm hiển thị: `U-Chan Secrets`; package/thư mục: `u-chan-secrets`.
- Mật khẩu không bao giờ xuất hiện trong: tool result, error message, audit log, stdout/stderr của server. stdout dành riêng cho MCP stdio — mọi log khác ra stderr và cũng phải không có secret.
- Chỉ điền credential khi hostname hiện tại của trang nằm trong `entry.hosts` (so khớp chính xác, không wildcard), kiểm tra lại trước **mỗi** lần điền.
- `loginUrl` phải là `https:`.
- AI không có tool liệt kê item trong vault.
- `revoke` không cần duyệt; thêm/sửa entry chỉ qua `requestAllow` + hộp thoại Windows.
- Thư mục dữ liệu: `process.env.U_CHAN_HOME` hoặc mặc định `%APPDATA%\u-chan-secrets`. Bên trong: `allowlist.json`, `audit.log`, `bw-session`, `chrome-profile\`.
- CDP endpoint: `process.env.U_CHAN_CDP` hoặc mặc định `http://127.0.0.1:9222`.
- Chrome dùng profile riêng `<U_CHAN_HOME>\chrome-profile`, không phải profile hằng ngày.

## Review Focus

1. **Vault đang khoá / session hết hạn** → `login` trả `failed: vault locked — chạy scripts/unlock.ps1`, không crash, không lộ session. (Task 3, Task 6)
2. **Trang login redirect sang host không có trong `hosts`** (phishing, SSO lạ) → không điền gì, trả `failed: unexpected host <host>`. (Task 5)
3. **Sai mật khẩu** → form login vẫn còn sau submit → trả `failed`, không báo `ok`. (Task 5)
4. **Đã đăng nhập sẵn** (loginUrl redirect thẳng vào dashboard, không có ô mật khẩu) → trả `ok: already logged in`, không lấy credential. (Task 5, Task 6)
5. **Item không tồn tại hoặc nhiều item trùng tên trong Bitwarden** → `failed: item not found` / `failed: multiple items match, dùng item id`, không lộ dữ liệu item. (Task 3)

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
  export class UserFacingError extends Error {}   // message an toàn để trả cho AI
  ```
- Produces (`config.ts`): `export function loadConfig(env = process.env): { home: string; allowlistPath: string; auditPath: string; sessionPath: string; chromeProfile: string; cdpEndpoint: string }`
- Produces (`redact.ts`): `export function redact(text: string, secrets: string[]): string` — thay mọi lần xuất hiện của từng secret không rỗng bằng `[REDACTED]`.
- Produces (`audit.ts`): `export class FileAuditLog implements AuditLog { constructor(path: string) }` — append một dòng JSON `{ts, action, domain, result}`, tạo thư mục nếu chưa có.

- [ ] **Step 1:** `git init`, tạo `package.json` (`"type": "module"`, scripts `build: tsc`, `test: vitest run`), cài `@modelcontextprotocol/sdk playwright zod` và dev `typescript vitest @types/node`. `.gitignore`: `node_modules`, `dist`.
- [ ] **Step 2: Viết test failing**
  ```ts
  // redact.test.ts
  expect(redact('pw=hunter2 again hunter2', ['hunter2'])).toBe('pw=[REDACTED] again [REDACTED]')
  expect(redact('abc', [''])).toBe('abc')
  // audit.test.ts — ghi 2 event vào file tạm, đọc lại được 2 dòng JSON có ts, action, domain, result
  ```
- [ ] **Step 3:** `npx vitest run` → FAIL (module chưa có).
- [ ] **Step 4:** Implement `types.ts`, `config.ts`, `redact.ts`, `audit.ts`.
- [ ] **Step 5:** `npx vitest run` → PASS; `npx tsc --noEmit` → không lỗi.
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
    upsert(entry: AllowEntry): Promise<void>   // ghi atomic: file tạm rồi rename
    remove(domain: string): Promise<boolean>
  }
  export function isHostAllowed(entry: AllowEntry, url: string): boolean
  export function buildEntry(domain: string, loginUrl: string, item: string, existing?: AllowEntry): AllowEntry
  ```
  `buildEntry`: ném `UserFacingError` nếu `loginUrl` không phải `https:`; `hosts` = hợp của `existing?.hosts`, `domain`, hostname của `loginUrl` (lowercase, không trùng). Domain normalize về lowercase, bỏ `https://` và path nếu AI truyền nhầm URL.

- [ ] **Step 1: Viết test failing**
  ```ts
  isHostAllowed({hosts:['admin.example.com'], ...}, 'https://admin.example.com/login') === true
  isHostAllowed(same, 'https://evil.example.com/login') === false        // không wildcard
  isHostAllowed(same, 'https://admin.example.com.evil.com/') === false
  isHostAllowed(same, 'http://admin.example.com/') === false              // chỉ https
  buildEntry('admin.example.com','http://x', 'item') throws UserFacingError
  buildEntry('admin.example.com','https://auth.example.com/login','Example').hosts
    => ['admin.example.com','auth.example.com']
  store: upsert → get trả entry; remove → true rồi get undefined; file không tồn tại → list() = []
  ```
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Chạy → PASS.
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
    constructor(opts: { sessionPath: string; exec?: Exec })   // exec mặc định: execFile('bw', args) không qua shell
  }
  ```
  Session: đọc `BW_SESSION` từ env nếu có, ngược lại đọc file `sessionPath` (trim). Truyền cho `bw` qua env `BW_SESSION`, không qua argv.
  `status()`: `bw status` → parse JSON `.status`; `bw` không chạy được → `'unavailable'`.
  `getLogin(item)`: `bw get item <item>`; lỗi chứa `More than one result` → `UserFacingError('multiple items match, dùng item id')`; `Not found` → `UserFacingError('item not found')`; locked → `UserFacingError('vault locked — chạy scripts/unlock.ps1')`; item không có `login.username`/`login.password` → `UserFacingError('item has no username/password')`. Mọi message lỗi khác đi qua `redact` với session và không bao giờ kèm stdout.
- `scripts/unlock.ps1`: chạy `bw unlock --raw` (bw tự hỏi master password), ghi output vào `<U_CHAN_HOME>\bw-session`; `-Lock` switch: `bw lock` và xoá file.

- [ ] **Step 1: Viết test failing** với `exec` giả:
  - status JSON `{"status":"unlocked"}` → `'unlocked'`; exec ném ENOENT → `'unavailable'`.
  - `get item` trả JSON `{login:{username:'u@x',password:'p'}}` → `{username:'u@x',password:'p'}`.
  - stderr `More than one result was found` → throws `UserFacingError` message `multiple items match, dùng item id`.
  - stderr `Not found.` → `item not found`; stderr `Vault is locked.` → `vault locked — chạy scripts/unlock.ps1`.
  - Exec nhận `env.BW_SESSION === 'S'` khi file session chứa `S\n`; `args` không chứa `'S'`.
  - Lỗi lạ có stderr chứa session `S` → message không chứa `S`.
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Implement `vault.ts` và `unlock.ps1`.
- [ ] **Step 4:** Chạy → PASS.
- [ ] **Step 5:** Commit `feat: bitwarden vault client via bw CLI`.

### Task 4: Windows approval dialog

**Files:**
- Create: `src/core/approver.ts`
- Test: `test/approver.test.ts`

**Interfaces:**
- Consumes: `Approver`.
- Produces: `export class WindowsDialogApprover implements Approver { constructor(opts?: { spawnPs?: SpawnPs; timeoutMs?: number }) }` (timeout mặc định 120000 → coi là từ chối).
  Cách làm: spawn `powershell.exe -NoProfile -NonInteractive -Command <script cố định>`; nội dung hiển thị truyền qua env `UCS_TITLE` / `UCS_BODY` (body = `lines.join('\n')`), **không bao giờ nội suy chuỗi do AI cung cấp vào script** (chống PowerShell injection). Script dùng `System.Windows.Forms.MessageBox` Yes/No, icon Warning, nút mặc định = No, cửa sổ TopMost; in `YES` hoặc `NO`. Chỉ `YES` → `true`.

- [ ] **Step 1: Viết test failing** với `spawnPs` giả: stdout `YES\r\n` → true; `NO` → false; timeout → false; khi `lines` chứa `"; Remove-Item C:\ ; "` thì argument script truyền cho `spawnPs` giống hệt script cố định và chuỗi đó chỉ nằm trong env `UCS_BODY`.
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Chạy → PASS. Thử tay: `node -e` gọi `ask('U-Chan Secrets', ['test'])` → hộp thoại hiện trên cùng, bấm Yes/No ra đúng kết quả.
- [ ] **Step 5:** Commit `feat: windows native approval dialog`.

### Task 5: Login filler (Playwright)

**Files:**
- Create: `src/core/login-filler.ts`
- Test: `test/login-filler.test.ts`, `test/fixtures/server.ts` (HTTP server local phục vụ các trang login mẫu)

**Interfaces:**
- Consumes: `AllowEntry`, `Credentials`, `isHostAllowed`.
- Produces:
  ```ts
  export type FillOutcome = { status: 'logged_in' | 'already_logged_in' | 'failed'; reason?: string }
  export async function fillLogin(page: Page, entry: AllowEntry,
    getCreds: () => Promise<Credentials>, opts?: { timeoutMs?: number; hostCheck?: (url: string) => boolean }): Promise<FillOutcome>
  ```
  `hostCheck` mặc định `url => isHostAllowed(entry, url)`; test truyền hàm cho phép `http://127.0.0.1:<port>`.
  Thuật toán:
  1. `page.goto(entry.loginUrl)`, chờ load. Nếu `hostCheck(page.url())` sai → `failed: unexpected host <hostname>`.
  2. Nếu không có ô username lẫn ô password hiển thị → `already_logged_in` (**không** gọi `getCreds`).
  3. Gọi `getCreds()` một lần.
  4. Ô username: `selectors.username` hoặc input hiển thị đầu tiên khớp `[autocomplete=username], [type=email], [name*=email i], [name*=user i], [id*=email i]`. Ô password: `selectors.password` hoặc `input[type=password]:visible`. Submit: `selectors.submit` hoặc `button[type=submit], input[type=submit]`, fallback nhấn Enter.
  5. Nếu cả hai ô hiển thị: kiểm tra host → fill username → fill password → submit **liền nhau trong cùng một lần gọi** (không trả control giữa chừng).
  6. Nếu chỉ có username (form tách bước): kiểm tra host → fill → submit → chờ `input[type=password]` hiển thị (timeout) → kiểm tra host lại → fill password → submit.
  7. Chờ navigation/network idle. Nếu ô password vẫn hiển thị → `failed: login form still present (sai mật khẩu?)`. Ngược lại → `logged_in`.
  `reason` không bao giờ chứa giá trị credential.

- [ ] **Step 1: Viết fixture server** với các trang: `/single` (email+password, POST đúng `u@x`/`pw` → redirect `/dash`, sai → render lại form), `/two-step` (bước 1 email, bước 2 password), `/already` (redirect thẳng `/dash`), `/redirect-evil` (redirect sang `http://localhost:<port>/single` — khác host so với `127.0.0.1`).
- [ ] **Step 2: Viết test failing** (Playwright chromium headless):
  - `/single` đúng creds → `logged_in`, page ở `/dash`.
  - `/single` sai mật khẩu → `failed`, reason chứa `login form still present`, không chứa mật khẩu.
  - `/two-step` → `logged_in`.
  - `/already` → `already_logged_in`, `getCreds` không được gọi.
  - `/redirect-evil` → `failed: unexpected host localhost`, `getCreds` không được gọi, không có request POST nào tới server.
- [ ] **Step 3:** Chạy → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Chạy → PASS.
- [ ] **Step 6:** Commit `feat: playwright login filler with host checks and two-step support`.

### Task 6: CoreService

**Files:**
- Create: `src/core/browser.ts`, `src/core/service.ts`
- Test: `test/service.test.ts`

**Interfaces:**
- Consumes: mọi thứ từ Task 1–5.
- Produces (`browser.ts`): `export interface BrowserProvider { withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>; connected(): Promise<boolean> }` và `export class CdpBrowserProvider implements BrowserProvider { constructor(endpoint: string) }` — `chromium.connectOverCDP`, dùng `contexts()[0]` (context mặc định, cookie dùng chung với Playwright MCP), mở tab mới, chạy `fn`, đóng tab. Không kết nối được → `UserFacingError('Chrome chưa chạy — chạy scripts/start-chrome.ps1')`.
- Produces (`service.ts`):
  ```ts
  export class CoreService {
    constructor(deps: { vault: VaultClient; allowlist: AllowlistStore; approver: Approver; audit: AuditLog; browser: BrowserProvider })
    login(domain: string): Promise<ToolResult>
    requestAllow(domain: string, loginUrl: string, item: string): Promise<ToolResult>
    revoke(domain: string): Promise<ToolResult>
    listAllowed(): Promise<ToolResult>   // message: mỗi dòng "domain — item — hosts"
    status(): Promise<ToolResult>        // vault status + chrome connected
  }
  ```
  `CoreService` là ranh giới IPC tương lai: chỉ nhận/trả kiểu serializable.
  - `login`: domain không có trong allowlist → `{ok:false, message:'domain chưa được cho phép — dùng request_allow'}`. Ngược lại `browser.withPage(page => fillLogin(page, entry, () => vault.getLogin(entry.item)))`. `logged_in` → `ok: logged in`; `already_logged_in` → `ok: already logged in`; `failed` → `{ok:false}`.
  - `requestAllow`: `buildEntry` (lỗi → `{ok:false}`), rồi `approver.ask('U-Chan Secrets', ['Cho phép AI đăng nhập?', 'Domain: …', 'Login URL: …', 'Item Bitwarden: …', 'Hosts: …'])`. true → `upsert`, `approved`; false → `denied`.
  - Mọi method: bắt lỗi; `UserFacingError` → trả message của nó; lỗi khác → `{ok:false, message:'internal error'}` và log chi tiết đã `redact` ra stderr. Ghi audit cho login/request_allow/revoke.

- [ ] **Step 1: Viết test failing** với fake vault/approver/audit/browser (browser fake gọi `fn` với page từ fixture server Task 5 hoặc stub `fillLogin` qua module mock):
  - `login` domain lạ → ok=false, vault không bị gọi.
  - `login` thành công → `{ok:true, message:'logged in'}`, audit ghi `{action:'login', result:'ok'}`.
  - Fake vault ném `UserFacingError('vault locked — chạy scripts/unlock.ps1')` → message đúng như vậy.
  - Fake vault ném `Error('boom hunter2')` với password `hunter2` → message `internal error`; JSON toàn bộ kết quả không chứa `hunter2`.
  - `requestAllow` approver=false → `denied`, allowlist không đổi; approver=true → entry có trong `list()`.
  - `requestAllow` với `http://` → ok=false, approver không bị gọi.
  - `revoke` → entry bị xoá, approver không bị gọi.
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Chạy → PASS.
- [ ] **Step 5:** Commit `feat: core service orchestrating login and allowlist`.

### Task 7: MCP adapter và entrypoint

**Files:**
- Create: `src/mcp/server.ts`, `src/index.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `CoreService`, `loadConfig` và các class cụ thể.
- Produces: `export function createMcpServer(core: Pick<CoreService, 'login'|'requestAllow'|'revoke'|'listAllowed'|'status'>): McpServer`. Tool (tên chính xác, schema zod):
  - `login` `{ domain: string }`
  - `request_allow` `{ domain: string, login_url: string, item: string }` — description nói rõ: sẽ hiện hộp thoại để người dùng duyệt; item là tên/ID item Bitwarden do người dùng cung cấp.
  - `revoke` `{ domain: string }`
  - `list_allowed` `{}`
  - `status` `{}`
  Mỗi tool trả `{ content: [{ type: 'text', text: message }], isError: !ok }`. Description của `login` nói: sau khi `ok`, dùng Playwright MCP để duyệt tiếp.
  `src/index.ts`: dựng các dependency từ `loadConfig()`, kết nối `StdioServerTransport`. Không `console.log` (stdout là kênh MCP).

- [ ] **Step 1: Viết test failing**: dùng `InMemoryTransport` + `Client` của SDK với core giả; `listTools` có đúng 5 tên trên; gọi `login` → text = message của core; core trả ok=false → `isError: true`.
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Chạy → PASS; `npm run build` → có `dist/index.js`.
- [ ] **Step 5:** Commit `feat: mcp adapter exposing u-chan-secrets tools`.

### Task 8: Scripts khởi động, README, kiểm tra end-to-end

**Files:**
- Create: `scripts/start-chrome.ps1`, `README.md`

**Interfaces:**
- Consumes: `dist/index.js`, `scripts/unlock.ps1`.

- [ ] **Step 1:** `scripts/start-chrome.ps1`: tìm `chrome.exe` (Program Files / LocalAppData), chạy với `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=<U_CHAN_HOME>\chrome-profile --no-first-run`. Nếu cổng 9222 đã mở thì không chạy thêm.
- [ ] **Step 2:** `README.md` (tiếng Việt): cài `bw` và `bw login`; quy trình hằng ngày (`start-chrome.ps1`, `unlock.ps1`); đăng ký MCP:
  ```
  claude mcp add u-chan-secrets -- node <path-to>\u-chan-secrets\dist\index.js
  claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
  ```
  (cấu hình lại Playwright MCP hiện có thay vì thêm bản thứ hai); threat model v1 (chống lộ vô tình, không chống AI bị lừa — xem spec §5b); cách gỡ quyền (`revoke`, sửa `allowlist.json`).
- [ ] **Step 3: E2E thật:** chạy Chrome + unlock; trong Claude Code: `status` → unlocked + connected; `request_allow("admin.example.com", "<login url>", "<item>")` → hộp thoại hiện, bấm Đồng ý; `login("admin.example.com")` → `logged in`; Playwright MCP `browser_navigate` tới trang admin → thấy giao diện đã đăng nhập, chụp màn hình.
- [ ] **Step 4: Kiểm tra rò rỉ:** grep mật khẩu thật trong `audit.log`, transcript Claude Code của phiên test (`~/.claude/projects/...`), và stderr log → không có kết quả.
- [ ] **Step 5:** Commit `docs: startup scripts and README`.
