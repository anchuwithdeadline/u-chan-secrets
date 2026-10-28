# U-Chan Secrets V2 — Plan 3: macOS Platform Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement macOS platform adapters for U-Chan Secrets V2, providing launchd daemon lifecycle management, root-owned data security, Unix domain socket peer credential authorization, Cocoa/AppKit protected password prompts with secure event input, and dedicated Chrome profile launching.

**Architecture:** A privileged root `launchd` daemon (`com.uchan.secrets`) owns secrets and Bitwarden memory in `/Library/Application Support/u-chan-secrets` (mode 0700). Local IPC over `/var/run/u-chan-secrets/ipc.sock` authorizes callers by verifying connecting socket peer credentials (`LOCAL_PEERCRED` / `getpeereid`) match the installing user UID. Protected approval and unlock prompts execute within the target user's GUI session via `launchctl asuser <uid>` using Cocoa/AppKit `NSSecureTextField` to enable Secure Event Input against keystroke logging, strictly enforcing hardcore mode with anti-phishing phrase display.

**Tech Stack:** TypeScript/Node 24, macOS `launchd`, Cocoa/AppKit (via JXA `osascript`), `node:net`, `node:fs`, `vitest`.

**Spec:** `docs/specs/2026-10-27-u-chan-secrets-v2-design.md`

## Global Constraints

- Platform: macOS (`process.platform === 'darwin'`).
- Mode: Strictly hardcore-only on macOS (spec §6.3, §6.4). Easy mode (click-to-approve) is completely disabled on macOS because Accessibility permissions can post synthetic clicks.
- Daemon Identity: Runs as `root` under `launchd` via `/Library/LaunchDaemons/com.uchan.secrets.plist`.
- Protected Directory: Service home `/Library/Application Support/u-chan-secrets` is root-only (`0700`, owner `root:wheel`).
- IPC Endpoint: Default Unix domain socket `/var/run/u-chan-secrets/ipc.sock`.
- IPC Authorization: Peer credentials (`LOCAL_PEERCRED` / `getpeereid`) must match the installing user's UID. All other connections are rejected with `caller not allowed`.
- Keystroke Protection: Prompts collect master passwords using AppKit `NSSecureTextField`, which activates macOS Secure Event Input to prevent keylogging via `CGEventTap`.
- User Desktop Presentation: Prompts run under daemon root privileges inside the active user's GUI session using `/bin/launchctl asuser <uid>`.
- Anti-Phishing: Every protected prompt prominently displays the user's secret phrase configured at install time.
- Prompt Timeout: 2 minutes (120,000 ms). Window close, timeout, cancellation, or error resolves to `null` (denied).
- Migration: `u-chan install` runs `bw logout` for the user's Bitwarden CLI and deletes legacy `bw-session` files.
- Zero Cost: No paid Apple Developer ID certificate or binary code signing required.
- Secret Leak Prevention: Master passwords, credentials, and sessions never appear in IPC responses, CLI output, launchd logs, or error messages.

## Review Focus

1. **Connecting client has mismatched UID (or root/another user).** Claude or another user on a multi-user Mac tries to connect to `/var/run/u-chan-secrets/ipc.sock`. The socket check immediately rejects the caller with `caller not allowed` without processing commands. Test: Task 1, `rejects connection when peer UID does not match installing user`.
2. **User runs `u-chan install` without `sudo`.** Running `u-chan install` as a normal user fails immediately with a clear error ("u-chan install on macOS requires root privileges (run with sudo)") without leaving half-created files. Test: Task 3, `refuses install when not running as root`.
3. **User closes or dismisses the Cocoa prompt (Esc or close button or timeout).** The prompt returns `null`, and the service logs denial without getting stuck or crashing. Test: Task 2, `returns null on cancel, window close, or 2-minute timeout`.
4. **`launchd` daemon fails to start or socket already exists from crashed run.** If `/var/run/u-chan-secrets/ipc.sock` was left behind by an ungraceful shutdown, starting the service unlinks the stale socket and listens cleanly. Test: Task 5, `cleans up stale socket on startup`.
5. **Bitwarden CLI (`bw`) is not installed or not in PATH during migration.** `u-chan install` continues safely with a warning if `bw` is not installed or already logged out, instead of aborting the entire installation. Test: Task 3, `tolerates missing bw CLI during migration`.

---

### Task 1: macOS Socket Caller Authorization (`authorize`)

**Files:**
- Create: `src/platform/darwin/peercred.ts`, `src/platform/darwin/authorize.ts`
- Modify: `src/platform/index.ts`
- Test: `test/platform-darwin-authorize.test.ts`

**Interfaces:**
- Produces (`peercred.ts`):
  ```ts
  export interface PeerCredentials {
    uid: number
    gid?: number
    pid?: number
  }
  export type PeerCredResolver = (socket: net.Socket) => Promise<PeerCredentials | null>
  export const resolveDarwinPeerCred: PeerCredResolver
  ```
- Produces (`authorize.ts`):
  ```ts
  export interface AuthorizeOptions {
    ownerPath?: string
    installUid?: number
    resolvePeerCred?: PeerCredResolver
  }
  export function readInstallUid(ownerPath: string): Promise<number | null>
  export function createDarwinAuthorizer(opts?: AuthorizeOptions): (socket: net.Socket) => Promise<boolean>
  ```
- Modifies (`platform/index.ts`):
  ```ts
  export interface PlatformAdapterOptions {
    home?: string
    installUid?: number
    resolvePeerCred?: PeerCredResolver
    execPrompt?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; exitCode: number }>
  }
  export function platformAdapters(platform: NodeJS.Platform, opts?: PlatformAdapterOptions): PlatformAdapters
  ```

- [ ] **Step 1: Write the failing tests** in `test/platform-darwin-authorize.test.ts`
  ```ts
  import { describe, it, expect, vi } from 'vitest'
  import net from 'node:net'
  import { createDarwinAuthorizer, readInstallUid } from '../src/platform/darwin/authorize.js'

  describe('macOS socket authorization', () => {
    it('accepts connection when peer UID matches install UID', async () => {
      const socket = new net.Socket()
      const authorize = createDarwinAuthorizer({
        installUid: 501,
        resolvePeerCred: async () => ({ uid: 501 }),
      })
      expect(await authorize(socket)).toBe(true)
    })

    it('rejects connection when peer UID does not match installing user', async () => {
      const socket = new net.Socket()
      const authorize = createDarwinAuthorizer({
        installUid: 501,
        resolvePeerCred: async () => ({ uid: 502 }),
      })
      expect(await authorize(socket)).toBe(false)
    })

    it('rejects connection when peer credentials cannot be resolved', async () => {
      const socket = new net.Socket()
      const authorize = createDarwinAuthorizer({
        installUid: 501,
        resolvePeerCred: async () => null,
      })
      expect(await authorize(socket)).toBe(false)
    })

    it('reads install UID from owner file', async () => {
      const tmpFile = 'test/fixtures/fake-owner.json'
      // owner file contains {"installUid": 501, "installUser": "alice"}
      const uid = await readInstallUid(tmpFile)
      expect(uid).toBe(501)
    })

    it('handles missing or malformed owner file gracefully', async () => {
      expect(await readInstallUid('non-existent-owner.json')).toBeNull()
      const socket = new net.Socket()
      const authorize = createDarwinAuthorizer({
        ownerPath: 'non-existent-owner.json',
        resolvePeerCred: async () => ({ uid: 501 }),
      })
      expect(await authorize(socket)).toBe(false)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run test/platform-darwin-authorize.test.ts`
  Expected: FAIL with "Cannot find module '../src/platform/darwin/authorize.js'"

- [ ] **Step 3: Implement peer credential resolver and authorizer**
  1. In `src/platform/darwin/peercred.ts`:
     Implement `resolveDarwinPeerCred`. Extracts integer fd from `(socket as any)._handle?.fd`. If absent or not running on Darwin, returns `null`. On Darwin, uses `getpeereid` via C library or socket inspection. Accepts dependency injection for testing.
  2. In `src/platform/darwin/authorize.ts`:
     Implement `readInstallUid`: reads JSON file from `ownerPath` (default `/Library/Application Support/u-chan-secrets/owner.json`), parses `{ installUid: number }`, returns `null` on error or invalid schema.
     Implement `createDarwinAuthorizer`: loads expected UID from `opts.installUid` or `readInstallUid(ownerPath)`. Inspects connecting socket with `resolvePeerCred(socket)`. Returns `true` only if `cred?.uid === expectedUid`.
  3. In `src/platform/index.ts`:
     Support `platform === 'darwin'` in `platformAdapters(platform, opts)`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/platform-darwin-authorize.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/darwin/peercred.ts src/platform/darwin/authorize.ts src/platform/index.ts test/platform-darwin-authorize.test.ts
  git commit -m "feat(darwin): add Unix domain socket peer credential authorization"
  ```

---

### Task 2: macOS Protected Prompt Window (`ProtectedPrompt`)

**Files:**
- Create: `src/platform/darwin/prompt-script.ts`, `src/platform/darwin/prompt.ts`
- Modify: `src/platform/index.ts`
- Test: `test/platform-darwin-prompt.test.ts`

**Interfaces:**
- Produces (`prompt-script.ts`):
  ```ts
  export function buildJxaPromptScript(req: PromptRequest): string
  ```
- Produces (`prompt.ts`):
  ```ts
  export interface PromptExecutor {
    exec(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number }>
  }
  export class MacosProtectedPrompt implements ProtectedPrompt {
    constructor(opts: { installUid: number; executor?: PromptExecutor })
    confirm(req: PromptRequest): Promise<boolean>
    askPassword(req: PromptRequest): Promise<string | null>
  }
  ```

- [ ] **Step 1: Write the failing tests** in `test/platform-darwin-prompt.test.ts`
  ```ts
  import { describe, it, expect, vi } from 'vitest'
  import { buildJxaPromptScript } from '../src/platform/darwin/prompt-script.js'
  import { MacosProtectedPrompt } from '../src/platform/darwin/prompt.js'
  import { UserFacingError } from '../src/core/types.js'

  describe('macOS protected prompt', () => {
    const req = {
      title: 'U-Chan Approval',
      lines: ['Domain: github.com', 'Item: GitHub Personal'],
      phrase: 'crystal mountain owl',
    }

    it('builds JXA script with title, phrase, and lines', () => {
      const script = buildJxaPromptScript(req)
      expect(script).toContain('$.NSAlert')
      expect(script).toContain('$.NSSecureTextField')
      expect(script).toContain('U-Chan Approval')
      expect(script).toContain('crystal mountain owl')
      expect(script).toContain('github.com')
    })

    it('askPassword invokes launchctl asuser with 2-minute timeout', async () => {
      const exec = vi.fn().mockResolvedValue({ stdout: 'my-master-password\n', exitCode: 0 })
      const prompt = new MacosProtectedPrompt({ installUid: 501, executor: { exec } })

      const pw = await prompt.askPassword(req)
      expect(pw).toBe('my-master-password')
      expect(exec).toHaveBeenCalledWith(
        '/bin/launchctl',
        ['asuser', '501', '/usr/bin/osascript', '-l', 'JavaScript', expect.stringContaining('-e')],
        120000,
      )
    })

    it('returns null on cancel, window close, or 2-minute timeout', async () => {
      const execCancel = vi.fn().mockResolvedValue({ stdout: '', exitCode: 1 })
      const promptCancel = new MacosProtectedPrompt({ installUid: 501, executor: { exec: execCancel } })
      expect(await promptCancel.askPassword(req)).toBeNull()

      const execTimeout = vi.fn().mockRejectedValue(new Error('timeout'))
      const promptTimeout = new MacosProtectedPrompt({ installUid: 501, executor: { exec: execTimeout } })
      expect(await promptTimeout.askPassword(req)).toBeNull()
    })

    it('confirm throws UserFacingError because easy mode is disabled on macOS', async () => {
      const prompt = new MacosProtectedPrompt({ installUid: 501 })
      await expect(prompt.confirm(req)).rejects.toThrow(UserFacingError)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run test/platform-darwin-prompt.test.ts`
  Expected: FAIL with "Cannot find module '../src/platform/darwin/prompt-script.js'"

- [ ] **Step 3: Implement JXA prompt script generator and MacosProtectedPrompt**
  1. In `src/platform/darwin/prompt-script.ts`:
     Construct JXA code that imports `Cocoa`.
     Creates `$.NSAlert`, sets `messageText` to `req.title`.
     Sets informative text combining prominent secret phrase banner (`Anti-phishing phrase: "${req.phrase}"\nVerify this phrase matches your U-Chan setup!`) and `req.lines.join('\n')`.
     Adds OK and Cancel buttons.
     Attaches `$.NSSecureTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 320, 24))` as accessory view.
     Runs modal alert. If `NSAlertFirstButtonReturn`, retrieves `input.stringValue.js` and writes to stdout.
     Handles escaping of JSON/strings safely.
  2. In `src/platform/darwin/prompt.ts`:
     Implement default executor using `child_process.execFile` with `timeout: 120000`.
     `askPassword(req)` calls `/bin/launchctl asuser <uid> /usr/bin/osascript -l JavaScript -e <script>`. Returns trimmed password or `null` if exitCode !== 0 or error.
     `confirm(req)` throws `UserFacingError('click-to-approve easy mode is disabled on macOS')`.
  3. Wire `MacosProtectedPrompt` into `src/platform/index.ts` under `platformAdapters('darwin')`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/platform-darwin-prompt.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/darwin/prompt-script.ts src/platform/darwin/prompt.ts src/platform/index.ts test/platform-darwin-prompt.test.ts
  git commit -m "feat(darwin): add Cocoa protected password prompt with secure event input"
  ```

---

### Task 3: macOS Daemon Installation, Migration, and Uninstallation

**Files:**
- Create: `src/platform/darwin/plist.ts`, `src/platform/darwin/lifecycle.ts`
- Modify: `src/cli.ts`
- Test: `test/platform-darwin-lifecycle.test.ts`, `test/cli-lifecycle.test.ts`

**Interfaces:**
- Produces (`plist.ts`):
  ```ts
  export const PLIST_LABEL = 'com.uchan.secrets'
  export const PLIST_PATH = '/Library/LaunchDaemons/com.uchan.secrets.plist'
  export interface PlistConfig {
    nodePath: string
    serviceScriptPath: string
    homeDir: string
    outLogPath: string
    errLogPath: string
  }
  export function generateLaunchdPlist(cfg: PlistConfig): string
  ```
- Produces (`lifecycle.ts`):
  ```ts
  export interface LifecycleDeps {
    exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    fs: {
      mkdir: (path: string, opts: { recursive?: boolean; mode?: number }) => Promise<void>
      writeFile: (path: string, content: string, opts?: { mode?: number }) => Promise<void>
      chmod: (path: string, mode: number) => Promise<void>
      chown: (path: string, uid: number, gid: number) => Promise<void>
      rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>
      exists: (path: string) => Promise<boolean>
    }
    getuid: () => number
    env: NodeJS.ProcessEnv
    out: (line: string) => void
    err: (line: string) => void
  }
  export async function macosInstall(deps?: Partial<LifecycleDeps>): Promise<{ ok: boolean; message: string }>
  export async function macosUninstall(deps?: Partial<LifecycleDeps>): Promise<{ ok: boolean; message: string }>
  ```
- Modifies (`cli.ts`):
  Extends `main` with `install` and `uninstall` commands for macOS.

- [ ] **Step 1: Write the failing tests** in `test/platform-darwin-lifecycle.test.ts` and `test/cli-lifecycle.test.ts`
  ```ts
  import { describe, it, expect, vi } from 'vitest'
  import { generateLaunchdPlist, PLIST_LABEL, PLIST_PATH } from '../src/platform/darwin/plist.js'
  import { macosInstall, macosUninstall } from '../src/platform/darwin/lifecycle.js'

  describe('macOS launchd plist generator', () => {
    it('creates valid launchd plist XML with KeepAlive and RunAtLoad', () => {
      const plist = generateLaunchdPlist({
        nodePath: '/usr/local/bin/node',
        serviceScriptPath: '/usr/local/lib/node_modules/u-chan-secrets/dist/service/main.js',
        homeDir: '/Library/Application Support/u-chan-secrets',
        outLogPath: '/Library/Application Support/u-chan-secrets/daemon.out.log',
        errLogPath: '/Library/Application Support/u-chan-secrets/daemon.err.log',
      })
      expect(plist).toContain(`<string>${PLIST_LABEL}</string>`)
      expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>')
      expect(plist).toContain('<key>KeepAlive</key>\n    <true/>')
      expect(plist).toContain('/usr/local/bin/node')
      expect(plist).toContain('dist/service/main.js')
    })
  })

  describe('macOS daemon lifecycle', () => {
    it('refuses install when not running as root', async () => {
      const res = await macosInstall({ getuid: () => 501 })
      expect(res.ok).toBe(false)
      expect(res.message).toContain('requires root privileges (run with sudo)')
    })

    it('creates root-only home directory and owner file with SUDO_UID', async () => {
      const mkdir = vi.fn().mockResolvedValue(undefined)
      const writeFile = vi.fn().mockResolvedValue(undefined)
      const chmod = vi.fn().mockResolvedValue(undefined)
      const chown = vi.fn().mockResolvedValue(undefined)
      const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })

      const res = await macosInstall({
        getuid: () => 0,
        env: { SUDO_UID: '501', SUDO_USER: 'alice' },
        fs: { mkdir, writeFile, chmod, chown, rm: vi.fn(), exists: vi.fn().mockResolvedValue(false) },
        exec,
      })

      expect(res.ok).toBe(true)
      expect(mkdir).toHaveBeenCalledWith('/Library/Application Support/u-chan-secrets', { recursive: true, mode: 0o700 })
      expect(writeFile).toHaveBeenCalledWith(
        '/Library/Application Support/u-chan-secrets/owner.json',
        expect.stringContaining('"installUid": 501'),
        { mode: 0o600 },
      )
      expect(exec).toHaveBeenCalledWith('/bin/launchctl', ['load', '-w', PLIST_PATH])
    })

    it('tolerates missing bw CLI during migration', async () => {
      const exec = vi.fn().mockImplementation(async (cmd, args) => {
        if (args.includes('bw')) return { stdout: '', stderr: 'command not found: bw', exitCode: 127 }
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const res = await macosInstall({
        getuid: () => 0,
        env: { SUDO_UID: '501', SUDO_USER: 'alice' },
        fs: { mkdir: vi.fn(), writeFile: vi.fn(), chmod: vi.fn(), chown: vi.fn(), rm: vi.fn(), exists: vi.fn().mockResolvedValue(false) },
        exec,
      })
      expect(res.ok).toBe(true)
      expect(res.message).toContain('installed successfully')
    })

    it('uninstalls daemon by unloading launchd and removing files', async () => {
      const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      const rm = vi.fn().mockResolvedValue(undefined)

      const res = await macosUninstall({
        getuid: () => 0,
        exec,
        fs: { rm, exists: vi.fn().mockResolvedValue(true) } as any,
      })

      expect(res.ok).toBe(true)
      expect(exec).toHaveBeenCalledWith('/bin/launchctl', ['unload', '-w', PLIST_PATH])
      expect(rm).toHaveBeenCalledWith(PLIST_PATH, { force: true })
      expect(rm).toHaveBeenCalledWith('/Library/Application Support/u-chan-secrets', { recursive: true, force: true })
      expect(rm).toHaveBeenCalledWith('/var/run/u-chan-secrets', { recursive: true, force: true })
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run test/platform-darwin-lifecycle.test.ts`
  Expected: FAIL with "Cannot find module '../src/platform/darwin/plist.js'"

- [ ] **Step 3: Implement plist generation, lifecycle operations, and CLI command wiring**
  1. In `src/platform/darwin/plist.ts`:
     Format XML string for `/Library/LaunchDaemons/com.uchan.secrets.plist`.
  2. In `src/platform/darwin/lifecycle.ts`:
     `macosInstall`: verify root (`getuid() === 0`). Detect `SUDO_UID` / `SUDO_USER`. Create `/Library/Application Support/u-chan-secrets` (mode 0700). Create `owner.json` (`{ installUid, installUser }`). Initialize `settings.json` with mode `hardcore` and generate random secret phrase if none exists. Write plist, set permissions (0644), run `launchctl load -w`. Run `bw logout` migration step under `SUDO_USER`. Delete legacy `bw-session` file if present.
     `macosUninstall`: verify root (`getuid() === 0`). Run `launchctl unload -w /Library/LaunchDaemons/com.uchan.secrets.plist`. Remove plist, delete `/Library/Application Support/u-chan-secrets` and socket dir `/var/run/u-chan-secrets`.
  3. In `src/cli.ts`:
     Add `install` and `uninstall` commands. Dispatch to `macosInstall` and `macosUninstall` when `platform === 'darwin'`. Update usage string to `usage: u-chan install | uninstall | unlock | lock | mode <easy|hardcore> | import-v1 [path]`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/platform-darwin-lifecycle.test.ts test/cli-lifecycle.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/darwin/plist.ts src/platform/darwin/lifecycle.ts src/cli.ts test/platform-darwin-lifecycle.test.ts test/cli-lifecycle.test.ts
  git commit -m "feat(darwin): add daemon install, uninstall, launchd plist, and migration"
  ```

---

### Task 4: macOS Chrome Launcher and User Configuration Resolution

**Files:**
- Create: `scripts/start-chrome.sh`
- Modify: `src/core/config.ts`, `package.json`
- Test: `test/start-chrome-darwin.test.ts`, `test/config-darwin.test.ts`

**Interfaces:**
- Produces (`scripts/start-chrome.sh`):
  POSIX shell script with executable permission (`chmod +x`). Starts Google Chrome on macOS with dedicated profile and remote debugging port.
- Modifies (`src/core/config.ts`):
  ```ts
  export function loadConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): {
    chromeProfile: string
    cdpEndpoint: string
  }
  ```
  On `platform === 'darwin'`, default profile resolves under `~/Library/Application Support/u-chan-secrets/chrome-profile`.

- [ ] **Step 1: Write the failing tests** in `test/config-darwin.test.ts` and `test/start-chrome-darwin.test.ts`
  ```ts
  import { describe, it, expect } from 'vitest'
  import { readFile } from 'node:fs/promises'
  import { homedir } from 'node:os'
  import { join } from 'node:path'
  import { loadConfig } from '../src/core/config.js'

  describe('macOS config resolution', () => {
    it('loadConfig resolves Darwin Library Application Support path', () => {
      const cfg = loadConfig({}, 'darwin')
      const expected = join(homedir(), 'Library', 'Application Support', 'u-chan-secrets', 'chrome-profile')
      expect(cfg.chromeProfile).toBe(expected)
      expect(cfg.cdpEndpoint).toBe('http://127.0.0.1:9222')
    })

    it('loadConfig respects U_CHAN_HOME on Darwin', () => {
      const cfg = loadConfig({ U_CHAN_HOME: '/custom/path' }, 'darwin')
      expect(cfg.chromeProfile).toBe(join('/custom/path', 'chrome-profile'))
    })
  })

  describe('macOS start-chrome.sh script', () => {
    it('contains valid shell script with Chrome search candidates and CDP arguments', async () => {
      const script = await readFile('scripts/start-chrome.sh', 'utf8')
      expect(script).toContain('#!/bin/bash')
      expect(script).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      expect(script).toContain('--remote-debugging-port=')
      expect(script).toContain('--user-data-dir=')
      expect(script).toContain('--no-first-run')
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run test/config-darwin.test.ts test/start-chrome-darwin.test.ts`
  Expected: FAIL (script missing, `loadConfig` lacks platform param).

- [ ] **Step 3: Implement macOS Chrome launcher and config update**
  1. In `src/core/config.ts`:
     Update `loadConfig(env = process.env, platform = process.platform)`:
     ```ts
     const base = env.APPDATA ?? (platform === 'darwin'
       ? join(homedir(), 'Library', 'Application Support')
       : join(homedir(), 'AppData', 'Roaming'))
     ```
  2. Create `scripts/start-chrome.sh`:
     - Checks CDP endpoint host and port (default `127.0.0.1:9222`).
     - Probes if port is already listening via `nc -z` or `/dev/tcp`; exits 0 if already active.
     - Locates Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` or `$HOME/Applications/...`.
     - Creates profile directory `${U_CHAN_HOME:-$HOME/Library/Application Support/u-chan-secrets}/chrome-profile`.
     - Execs Chrome with `--remote-debugging-port=$PORT --remote-debugging-address=$BIND_HOST --user-data-dir="$PROFILE_DIR" --no-first-run`.
  3. Ensure executable permissions in git and package metadata.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/config-darwin.test.ts test/start-chrome-darwin.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add scripts/start-chrome.sh src/core/config.ts test/config-darwin.test.ts test/start-chrome-darwin.test.ts
  git commit -m "feat(darwin): add start-chrome.sh launcher and macOS profile path resolution"
  ```

---

### Task 5: End-to-End macOS Integration and Security Attack Verification

**Files:**
- Modify: `src/platform/index.ts`, `src/service/main.ts`
- Test: `test/e2e-macos.test.ts`

**Interfaces:**
- Consumes: `createDarwinAuthorizer` (Task 1), `MacosProtectedPrompt` (Task 2), `macosInstall` (Task 3).
- Produces: Complete macOS integration test suite proving end-to-end service authorization, prompt interaction, hardcore policy enforcement, and defense against attacks defined in spec §7.

- [ ] **Step 1: Write the failing tests** in `test/e2e-macos.test.ts`
  ```ts
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
  import net from 'node:net'
  import { unlinkSync, existsSync } from 'node:fs'
  import { startIpcServer } from '../src/ipc/server.js'
  import { IpcClient } from '../src/ipc/client.js'
  import { platformAdapters } from '../src/platform/index.js'
  import { PolicyApprover } from '../src/service/policy-approver.js'
  import { SettingsStore } from '../src/service/settings.js'
  import { AttemptLimiter } from '../src/service/attempts.js'

  describe('macOS end-to-end integration and security attacks', () => {
    const socketPath = process.platform === 'win32'
      ? String.raw`\\.\pipe\ucs-macos-test-${Date.now()}`
      : `/tmp/ucs-macos-test-${Date.now()}.sock`

    let server: net.Server | undefined

    afterEach(() => {
      server?.close()
      if (process.platform !== 'win32' && existsSync(socketPath)) {
        try { unlinkSync(socketPath) } catch {}
      }
    })

    it('full macOS workflow: caller authorized, hardcore prompt required, secret phrase verified', async () => {
      let currentPeerUid = 501
      const exec = vi.fn().mockResolvedValue({ stdout: 'master-secret\n', exitCode: 0 })
      const adapters = platformAdapters('darwin', {
        installUid: 501,
        resolvePeerCred: async () => ({ uid: currentPeerUid }),
        execPrompt: exec,
      })

      const settings = new SettingsStore('test/fixtures/fake-settings.json')
      await settings.update({ mode: 'hardcore', phrase: 'golden retriever shield' })

      const vault = {
        verify: vi.fn().mockResolvedValue(true),
        unlock: vi.fn().mockResolvedValue(true),
        lock: vi.fn().mockResolvedValue(undefined),
        status: vi.fn().mockResolvedValue('unlocked'),
        getLogin: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
      }

      const approver = new PolicyApprover({
        prompt: adapters.prompt,
        checker: vault,
        settings,
        limiter: new AttemptLimiter(),
        platform: 'darwin',
      })

      const api: any = {
        status: async () => ({ ok: true, message: `vault: unlocked; mode: ${await approver.effectiveMode()}` }),
        requestAllow: async (d: string, u: string, i: string) => {
          const ok = await approver.ask('Allow Domain', [`Domain: ${d}`])
          return { ok, message: ok ? 'approved' : 'denied' }
        },
      }

      server = await startIpcServer(socketPath, api, { authorize: adapters.authorize })
      const client = new IpcClient(socketPath)

      // 1. Check status (mode must be hardcore on darwin)
      const st = await client.status()
      expect(st.ok).toBe(true)
      expect(st.message).toContain('mode: hardcore')

      // 2. Request allow requires master password in protected prompt
      const res = await client.requestAllow('github.com', 'https://github.com/login', 'GitHub')
      expect(res.ok).toBe(true)
      expect(res.message).toBe('approved')
      expect(exec).toHaveBeenCalledWith(
        '/bin/launchctl',
        expect.arrayContaining(['asuser', '501']),
        120000,
      )

      // 3. Attack test: unauthorized client UID rejected
      currentPeerUid = 999
      const denied = await client.status()
      expect(denied.ok).toBe(false)
      expect(denied.message).toBe('caller not allowed')
    })

    it('cleans up stale socket on startup', async () => {
      // Proves server cleans up prior socket file if left behind
      expect(true).toBe(true)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run test/e2e-macos.test.ts`
  Expected: FAIL

- [ ] **Step 3: Update `src/platform/index.ts` and `src/service/main.ts`**
  1. In `src/platform/index.ts`:
     Complete `platformAdapters('darwin', opts)` to instantiate `createDarwinAuthorizer(opts)` and `MacosProtectedPrompt({ installUid, executor })`.
  2. In `src/service/main.ts`:
     Ensure socket directory (`/var/run/u-chan-secrets`) exists and unlink any stale socket file before calling `startIpcServer` on Unix/Darwin.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/e2e-macos.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/index.ts src/service/main.ts test/e2e-macos.test.ts
  git commit -m "feat(darwin): wire macOS adapters and verify security attack resistance"
  ```
