# U-Chan Secrets V2 — Plan 2: Windows Platform Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Windows platform adapters for U-Chan Secrets V2: admin-owned service lifecycle, named-pipe caller SID authorization, UIPI-isolated protected prompt windows with anti-phishing phrases, Bitwarden CLI logout migration, and UAC elevation checks.

**Architecture:** A native Windows service runs under `NT AUTHORITY\SYSTEM` hosting the V2 CoreService and IPC server. The named pipe endpoint enforces caller authentication by inspecting the connected client's token SID against the authorized user SID. Approvals and password unlocks render through a standalone C# WinForms prompt compiled on the host via .NET / PowerShell, displaying the secret anti-phishing phrase with a 2-minute hardware timer. An elevated CLI installer configures `%ProgramData%\u-chan-secrets` with strict SYSTEM/Admin ACLs, registers the service via Service Control Manager (`sc.exe`), detects default UAC vulnerability, and runs `bw logout` migration.

**Tech Stack:** TypeScript, Node.js 24 (`node:net`, `node:child_process`, `node:fs/promises`), Windows Service Control Manager (`sc.exe`), Windows Access Control Lists (`icacls.exe`), C# / .NET WinForms and ServiceBase (compiled host-side via PowerShell `Add-Type`), Vitest.

**Spec:** `docs/specs/2026-10-27-u-chan-secrets-v2-design.md`

## Global Constraints

- Secrets (passwords, TOTP seeds, Bitwarden sessions, master passwords) must never cross IPC, appear in stdout/stderr, or be written to unprivileged user storage.
- Program files and service data on Windows live in `%ProgramData%\u-chan-secrets` with inheritance disabled and ACLs restricted strictly to `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators`.
- Easy mode is permitted on Windows only; hardcore mode is available and enforces master password entry.
- Prompt windows enforce a strict 2-minute (120000 ms) timeout. Any window closure, timeout, or error evaluates to denied/cancelled (`false` or `null`).
- Every protected window prominently displays the user's secret anti-phishing phrase.
- The IPC named pipe authorizer verifies that the connecting client process belongs to the authorized user SID stored during install.
- `u-chan install` requires administrative elevation and warns if UAC is set to default prompt behavior.
- Migration runs `bw logout` on the user's Bitwarden CLI and removes legacy V1 `bw-session` files.
- All tasks must be fully testable via dependency injection with mocks/fakes on non-elevated CI environments and non-Windows host systems.

## Review Focus

1. **Unprivileged execution of `u-chan install`:** When invoked without administrative elevation, `install` fails immediately with `u-chan install requires administrator privileges`, exits with code 1, and touches no filesystem paths. (Test: Task 5, `refuses install without administrator privileges`).
2. **Default Windows UAC level warning:** When UAC is set to default (consent prompt on secure desktop for admins, `ConsentPromptBehaviorAdmin = 5`), the installer emits the exact prominent security warning recommending "Always notify" before proceeding. (Test: Task 1, `detects default UAC level and emits warning`).
3. **Unauthorized caller on named pipe:** When a process belonging to a different SID connects to `\\.\pipe\u-chan-secrets`, `authorize(socket)` returns `false`, the server rejects with `{ id, ok: false, message: 'caller not allowed' }`, and the core API is never called. (Test: Task 3, `rejects client process with mismatched SID`).
4. **Prompt timeout or forced close:** When a user closes the prompt window or the 2-minute timer expires, `confirm` resolves `false` and `askPassword` resolves `null` without throwing unhandled exceptions or leaking state. (Test: Task 4, `times out after 2 minutes and cancels`).
5. **Bitwarden CLI missing or failing during migration:** If `bw` is not installed in PATH or exits non-zero during `bw logout`, `migrateBitwarden` logs a warning, cleans up any existing `bw-session` file, and allows installation to proceed. (Test: Task 1, `handles missing or failing bw gracefully`).

---

### Task 1: Windows Security Foundations (UAC Detection, ACL Management, Migration)

**Files:**
- Create: `src/platform/windows/uac.ts`, `src/platform/windows/acl.ts`, `src/platform/windows/migration.ts`
- Test: `test/windows/uac.test.ts`, `test/windows/acl.test.ts`, `test/windows/migration.test.ts`

**Interfaces:**
- Produces (`uac.ts`):
  ```ts
  export interface UacStatus {
    enabled: boolean
    consentPromptBehaviorAdmin: number
    promptOnSecureDesktop: boolean
    isDefault: boolean
    warning?: string
  }
  export const UAC_DEFAULT_WARNING =
    'WARNING: Windows UAC is at the default level (consent prompt on secure desktop).\n' +
    'Normal user processes can silently bypass default UAC to gain administrator rights.\n' +
    'For full protection, set UAC to "Always notify" or run Claude in a standard user account.'

  export type RegistryQuery = (key: string, valueName: string) => Promise<number | undefined>
  export async function checkUacLevel(queryReg?: RegistryQuery): Promise<UacStatus>
  ```
- Produces (`acl.ts`):
  ```ts
  export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
  export async function setAdminOnlyAcl(dirPath: string, exec?: ExecFn): Promise<void>
  ```
- Produces (`migration.ts`):
  ```ts
  export interface MigrationResult {
    bwLoggedOut: boolean
    sessionFileRemoved: boolean
    warning?: string
  }
  export async function migrateBitwarden(opts: {
    exec?: ExecFn
    unlink?: (path: string) => Promise<void>
    fileExists?: (path: string) => Promise<boolean>
    sessionPath?: string
  }): Promise<MigrationResult>
  ```

- [ ] **Step 1: Write the failing tests**
  - In `test/windows/uac.test.ts`:
    - `detects default UAC level and emits warning`: `ConsentPromptBehaviorAdmin: 5`, `EnableLUA: 1`, `PromptOnSecureDesktop: 1` → `isDefault: true`, `warning === UAC_DEFAULT_WARNING`.
    - `recognizes high security always notify`: `ConsentPromptBehaviorAdmin: 2` → `isDefault: false`, `warning === undefined`.
    - `handles disabled UAC`: `EnableLUA: 0` → `enabled: false`, `isDefault: false`, warning indicates UAC disabled.
    - `handles missing registry keys safely`: query returns `undefined` → falls back to safe assumptions without throwing.
  - In `test/windows/acl.test.ts`:
    - `invokes icacls with inheritance removal and admin-only grant`: `setAdminOnlyAcl('C:\\ProgramData\\u-chan-secrets', fakeExec)` → verifies `icacls` called with args `['C:\\ProgramData\\u-chan-secrets', '/inheritance:r', '/grant:r', 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F']`.
    - `propagates icacls failure as user-facing error`: fakeExec rejects → throws error with message describing ACL failure.
  - In `test/windows/migration.test.ts`:
    - `runs bw logout and removes legacy session`: `migrateBitwarden` calls `bw logout` and unlinks `sessionPath` → `{ bwLoggedOut: true, sessionFileRemoved: true }`.
    - `handles missing or failing bw gracefully`: `exec` throws for `bw logout` (e.g. command not found) → `{ bwLoggedOut: false, sessionFileRemoved: true, warning }`, does not throw.
    - `skips unlink if session file does not exist`: `fileExists` returns `false` → `unlink` not called.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/windows/uac.test.ts test/windows/acl.test.ts test/windows/migration.test.ts`
  Expected: FAIL with missing modules.

- [ ] **Step 3: Implement `uac.ts`, `acl.ts`, and `migration.ts`**
  - In `uac.ts`: implement registry reader using `powershell Get-ItemProperty` or default `queryReg` querying `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`. If `consentPromptBehaviorAdmin === 5`, return `isDefault: true` and `warning: UAC_DEFAULT_WARNING`.
  - In `acl.ts`: execute `icacls.exe` with `/inheritance:r /grant:r SYSTEM:(OI)(CI)F Administrators:(OI)(CI)F`.
  - In `migration.ts`: attempt `bw logout` via `exec('bw', ['logout'])`. Catch failures into warning text. Check `sessionPath` (defaults to `%APPDATA%\u-chan-secrets\bw-session`), unlink if exists.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npx vitest run test/windows/uac.test.ts test/windows/acl.test.ts test/windows/migration.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/windows/uac.ts src/platform/windows/acl.ts src/platform/windows/migration.ts test/windows/uac.test.ts test/windows/acl.test.ts test/windows/migration.test.ts
  git commit -m "feat(windows): add UAC detection, admin ACL enforcement, and Bitwarden migration"
  ```

---

### Task 2: Native Windows C# Assets and Host Compiler

**Files:**
- Create:
  - `src/platform/windows/assets/auth-src.ts` (C# source for named-pipe caller SID inspection)
  - `src/platform/windows/assets/prompt-src.ts` (C# source for WinForms prompt window with timeout and phrase banner)
  - `src/platform/windows/assets/service-src.ts` (C# source for Windows Service host)
  - `src/platform/windows/assets/compiler.ts`
- Test: `test/windows/compiler.test.ts`

**Interfaces:**
- Produces (`auth-src.ts`): `export const AUTH_HELPER_CSHARP: string`: C# program that takes `[serverPid, targetSid]`, enumerates server pipe handles using `DuplicateHandle` and `GetNamedPipeClientProcessId`, queries client token with `OpenProcessToken` and `ConvertSidToStringSid`, returns exit code `0` on match or `1` on mismatch.
- Produces (`prompt-src.ts`): `export const PROMPT_HELPER_CSHARP: string`: WinForms program supporting `--mode confirm|password --title <t> --phrase <p> --lines <json>`, rendering bold top phrase banner, 2-minute countdown timer, topmost modal window, masked password box. Outputs password to stdout on confirm, exits 0 on approve, exits 1 on cancel/timeout.
- Produces (`service-src.ts`): `export const SERVICE_HOST_CSHARP: string`: `System.ServiceProcess.ServiceBase` implementation that spawns and monitors the Node.js service process and kills child process tree on stop.
- Produces (`compiler.ts`):
  ```ts
  export interface CompileOptions {
    outputType?: 'ConsoleApplication' | 'WindowsApplication'
    referencedAssemblies?: string[]
    exec?: ExecFn
  }
  export async function compileCsharp(source: string, outputPath: string, opts?: CompileOptions): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**
  - In `test/windows/compiler.test.ts`:
    - `formats PowerShell Add-Type compilation command`: `compileCsharp(src, 'out.exe', { outputType: 'WindowsApplication', referencedAssemblies: ['System.Windows.Forms.dll'] }, fakeExec)` → verifies `fakeExec` received powershell command containing `Add-Type`, source string, OutputAssembly, and references.
    - `handles compilation errors`: `fakeExec` returns non-zero with stderr compiler errors → throws descriptive error without leaking raw code.
    - `csharp templates contain required signatures`: inspect `AUTH_HELPER_CSHARP`, `PROMPT_HELPER_CSHARP`, `SERVICE_HOST_CSHARP` to verify Win32 P/Invoke signatures (`GetNamedPipeClientProcessId`, `OpenProcessToken`, `TopMost = true`, `ServiceBase`).

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/windows/compiler.test.ts`
  Expected: FAIL with missing compiler module.

- [ ] **Step 3: Implement asset sources and compiler**
  - In `compiler.ts`: construct a PowerShell script block that invokes `Add-Type -TypeDefinition $src -OutputAssembly $out -OutputType $type -ReferencedAssemblies $refs`. Use `exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])`.
  - In `auth-src.ts`, `prompt-src.ts`, `service-src.ts`: implement clean, zero-dependency C# .NET 4.x compatible sources.

- [ ] **Step 4: Run test to verify passes**
  Run: `npx vitest run test/windows/compiler.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/windows/assets/ test/windows/compiler.test.ts
  git commit -m "feat(windows): add native C# helper templates and PowerShell compiler bridge"
  ```

---

### Task 3: Named Pipe Caller Authorization

**Files:**
- Create: `src/platform/windows/authorize.ts`
- Test: `test/windows/authorize.test.ts`

**Interfaces:**
- Produces (`authorize.ts`):
  ```ts
  import type net from 'node:net'

  export interface AuthorizerOptions {
    authorizedSid: string
    authExePath?: string
    serverPid?: number
    getClientSid?: (socket: net.Socket) => Promise<string | null>
  }
  export function createWindowsAuthorizer(opts: AuthorizerOptions): (socket: net.Socket) => Promise<boolean>
  export async function queryPipeClientSid(
    socket: net.Socket,
    opts: { authExePath: string; serverPid: number; execFile?: ExecFn }
  ): Promise<string | null>
  ```

- [ ] **Step 1: Write the failing tests**
  - In `test/windows/authorize.test.ts`:
    - `allows client process with matching authorized SID`: `getClientSid` returns `'S-1-5-21-1001'`, `authorizedSid: 'S-1-5-21-1001'` → authorizer returns `true`.
    - `case-insensitive SID comparison`: `getClientSid` returns `'s-1-5-21-1001'`, `authorizedSid: 'S-1-5-21-1001'` → returns `true`.
    - `rejects client process with mismatched SID`: `getClientSid` returns `'S-1-5-21-9999'` → authorizer returns `false`.
    - `rejects when client SID lookup fails or returns null`: `getClientSid` returns `null` → authorizer returns `false`.
    - `queryPipeClientSid executes auth helper binary`: calls `execFile(authExePath, [String(serverPid), 'dummy'])` → parses stdout `AUTHORIZED:1234` or exit code 0.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/windows/authorize.test.ts`
  Expected: FAIL with module not found.

- [ ] **Step 3: Implement `authorize.ts`**
  - Implement `createWindowsAuthorizer`: wrap `getClientSid` lookup. Check `clientSid !== null && clientSid.toLowerCase() === authorizedSid.toLowerCase()`. Return boolean.
  - Implement `queryPipeClientSid`: invoke `u-chan-auth.exe` via `execFile` passing server PID. Parse exit code 0 and stdout for client SID.

- [ ] **Step 4: Run test to verify passes**
  Run: `npx vitest run test/windows/authorize.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/windows/authorize.ts test/windows/authorize.test.ts
  git commit -m "feat(windows): add named pipe caller SID verification"
  ```

---

### Task 4: Windows Protected Prompt Window

**Files:**
- Create: `src/platform/windows/prompt.ts`
- Test: `test/windows/prompt.test.ts`

**Interfaces:**
- Produces (`prompt.ts`):
  ```ts
  import type { PromptRequest, ProtectedPrompt } from '../../core/types.js'

  export interface PromptRunnerOutcome {
    ok: boolean
    password?: string
  }
  export type PromptRunner = (params: {
    mode: 'confirm' | 'password'
    title: string
    lines: string[]
    phrase: string
    timeoutMs: number
  }) => Promise<PromptRunnerOutcome>

  export interface WindowsPromptOptions {
    phrase: string
    promptExePath?: string
    runner?: PromptRunner
    timeoutMs?: number
  }

  export class WindowsProtectedPrompt implements ProtectedPrompt {
    constructor(opts: WindowsPromptOptions)
    confirm(req: PromptRequest): Promise<boolean>
    askPassword(req: PromptRequest): Promise<string | null>
  }
  ```

- [ ] **Step 1: Write the failing tests**
  - In `test/windows/prompt.test.ts`:
    - `confirm returns true when user approves`: runner resolves `{ ok: true }` → `confirm` returns `true`.
    - `confirm returns false on cancel or window close`: runner resolves `{ ok: false }` → `confirm` returns `false`.
    - `askPassword returns trimmed password on approve`: runner resolves `{ ok: true, password: 'secret\n' }` → returns `'secret'`.
    - `askPassword returns null on cancel or error`: runner resolves `{ ok: false }` → returns `null`.
    - `times out after 2 minutes and cancels`: runner times out after `timeoutMs` (120000 ms) → returns `false` / `null`.
    - `passes anti-phishing phrase from settings`: prompt request passes configured `phrase` into the runner parameters.
    - `serializes prompt invocations`: two parallel calls execute sequentially.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/windows/prompt.test.ts`
  Expected: FAIL with missing module.

- [ ] **Step 3: Implement `WindowsProtectedPrompt` in `prompt.ts`**
  - Implement `WindowsProtectedPrompt`:
    - Hold promise queue for serialization.
    - Default `runner` executes `u-chan-prompt.exe` using `child_process.execFile` with 120000 ms timeout.
    - Pass `--mode`, `--title`, `--phrase`, and lines via temporary file or base64 JSON argument.
    - Parse output safely, redact all error traces, trim password string, return `null`/`false` on non-zero exit or timeout.

- [ ] **Step 4: Run test to verify passes**
  Run: `npx vitest run test/windows/prompt.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/windows/prompt.ts test/windows/prompt.test.ts
  git commit -m "feat(windows): implement protected prompt window with anti-phishing phrase"
  ```

---

### Task 5: Windows Service Manager, Installer, and Adapter Factory

**Files:**
- Create:
  - `src/platform/windows/service-manager.ts`
  - `src/platform/windows/install.ts`
  - `src/platform/windows/index.ts`
- Test:
  - `test/windows/service-manager.test.ts`
  - `test/windows/install.test.ts`

**Interfaces:**
- Produces (`service-manager.ts`):
  ```ts
  export class ServiceManager {
    constructor(private exec: ExecFn = defaultExec)
    create(name: string, binPath: string, displayName?: string): Promise<void>
    start(name: string): Promise<void>
    stop(name: string): Promise<void>
    delete(name: string): Promise<void>
    status(name: string): Promise<'running' | 'stopped' | 'not_installed'>
  }
  ```
- Produces (`install.ts`):
  ```ts
  import type { ApprovalMode, ToolResult } from '../../core/types.js'

  export interface WindowsInstallOptions {
    mode?: ApprovalMode
    phrase?: string
    adminCheck?: () => Promise<boolean>
    getUserSid?: () => Promise<string>
    programData?: string
    exec?: ExecFn
    serviceManager?: ServiceManager
    out?: (msg: string) => void
    err?: (msg: string) => void
  }
  export async function installWindowsService(opts: WindowsInstallOptions): Promise<ToolResult>

  export interface WindowsUninstallOptions {
    adminCheck?: () => Promise<boolean>
    programData?: string
    serviceManager?: ServiceManager
    out?: (msg: string) => void
    err?: (msg: string) => void
  }
  export async function uninstallWindowsService(opts: WindowsUninstallOptions): Promise<ToolResult>
  ```
- Produces (`src/platform/windows/index.ts`):
  ```ts
  import type { PlatformAdapters } from '../index.js'
  export function windowsPlatformAdapters(cfg?: { settingsPath?: string; binDir?: string }): PlatformAdapters
  ```

- [ ] **Step 1: Write the failing tests**
  - In `test/windows/service-manager.test.ts`:
    - `creates service with sc.exe`: `create('u-chan-secrets', 'C:\\...\\host.exe')` → calls `sc.exe create u-chan-secrets binPath= "..." start= auto obj= LocalSystem`.
    - `starts service with sc.exe`: `start('u-chan-secrets')` → calls `sc.exe start u-chan-secrets`.
    - `stops and deletes service`: calls `sc.exe stop`, then `sc.exe delete`.
  - In `test/windows/install.test.ts`:
    - `refuses install without administrator privileges`: `adminCheck: async () => false` → `{ ok: false, message: 'u-chan install requires administrator privileges' }`.
    - `full install workflow`:
      - Checks admin (true).
      - Checks UAC (logs warning if default).
      - Creates directories under `programData` (`bin`, `data`).
      - Sets ACLs with `setAdminOnlyAcl`.
      - Compiles binaries (`prompt`, `service`, `auth`).
      - Writes `settings.json` with `mode: 'easy'`, `phrase`, `authorizedSid`.
      - Runs Bitwarden migration.
      - Creates and starts service.
      - Returns `{ ok: true, message: 'U-Chan Secrets service installed and started successfully' }`.
    - `full uninstall workflow`:
      - Stops service.
      - Deletes service.
      - Removes `programData` directory.
      - Returns `{ ok: true, message: 'U-Chan Secrets service uninstalled successfully' }`.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/windows/service-manager.test.ts test/windows/install.test.ts`
  Expected: FAIL with missing modules.

- [ ] **Step 3: Implement `service-manager.ts`, `install.ts`, and `index.ts`**
  - `service-manager.ts`: execute `sc.exe` commands with proper quoting and status querying.
  - `install.ts`: orchestrate all Windows setup steps using injected dependencies. Default `adminCheck` executes `net session` or `fltmc`. Default `getUserSid` runs `whoami /user` or PowerShell `[WindowsIdentity]::GetCurrent().User.Value`.
  - `index.ts`: load `settings.json` for `phrase` and `authorizedSid`, construct `WindowsProtectedPrompt` and `createWindowsAuthorizer`, and export `windowsPlatformAdapters`.

- [ ] **Step 4: Run test to verify passes**
  Run: `npx vitest run test/windows/service-manager.test.ts test/windows/install.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/windows/service-manager.ts src/platform/windows/install.ts src/platform/windows/index.ts test/windows/service-manager.test.ts test/windows/install.test.ts
  git commit -m "feat(windows): implement Windows service manager, installer, and adapter factory"
  ```

---

### Task 6: CLI Wiring and Platform Entry Points

**Files:**
- Modify: `src/platform/index.ts`, `src/cli.ts`
- Test: `test/cli.test.ts`, `test/windows/platform.test.ts`

**Interfaces:**
- Modifies (`src/platform/index.ts`):
  ```ts
  import { windowsPlatformAdapters } from './windows/index.js'
  export function platformAdapters(platform: NodeJS.Platform): PlatformAdapters {
    if (platform === 'win32') return windowsPlatformAdapters()
    throw new UserFacingError(`U-Chan V2 is not supported on ${platform} yet`)
  }
  ```
- Modifies (`src/cli.ts`):
  - Extends `USAGE` to: `'usage: u-chan install [--mode <easy|hardcore>] [--phrase <phrase>] | uninstall | unlock | lock | mode <easy|hardcore> | import-v1 [path]'`
  - Extends `CliDeps` with `install?: (opts: any) => Promise<ToolResult>` and `uninstall?: (opts: any) => Promise<ToolResult>`.
  - Dispatches `install` and `uninstall` to Windows installer on `platform === 'win32'`.

- [ ] **Step 1: Write the failing tests**
  - In `test/cli.test.ts`:
    - `dispatches install command with options`: argv `['install', '--mode', 'hardcore', '--phrase', 'blue otter']` → calls `d.install` with parsed options, prints message, exits 0.
    - `dispatches uninstall command`: argv `['uninstall']` → calls `d.uninstall`, prints message, exits 0.
    - `install failure returns exit code 1`: `d.install` returns `{ ok: false, message: 'failed' }` → prints error, exit code 1.
  - In `test/windows/platform.test.ts`:
    - `platformAdapters('win32') returns prompt and authorize adapters`: resolves without throwing `UserFacingError`.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/cli.test.ts test/windows/platform.test.ts`
  Expected: FAIL on new CLI test cases.

- [ ] **Step 3: Implement CLI updates and platform wiring**
  - In `src/platform/index.ts`: import and call `windowsPlatformAdapters` when `platform === 'win32'`.
  - In `src/cli.ts`: parse `install` (extracting `--mode` and `--phrase`) and `uninstall`. Route to `installWindowsService` / `uninstallWindowsService`.

- [ ] **Step 4: Run tests to verify all tests pass**
  Run: `npm test`
  Expected: PASS (all core and windows tests pass).

- [ ] **Step 5: Commit**
  ```bash
  git add src/platform/index.ts src/cli.ts test/cli.test.ts test/windows/platform.test.ts
  git commit -m "feat: wire Windows service install/uninstall into CLI and platform index"
  ```
