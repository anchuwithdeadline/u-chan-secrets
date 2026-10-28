# U-Chan Secrets V2 — Plan 4: Self-Update, Audit CLI & Documentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the cryptographically verified self-update mechanism (`u-chan update`), the read-only audit inspection CLI (`u-chan audit`), and complete V2 documentation (architecture overview, Windows/macOS install, UAC guidance, and threat model attack checklist).

**Architecture:** The admin CLI communicates with the privileged system service over local IPC. `u-chan audit` fetches and formats audit records via a read-only IPC endpoint without recording additional events. `u-chan update` triggers the service to query the npm registry, verify the package SHA-512 integrity and npm cryptographic signatures/provenance, atomically swap the admin-owned program files, log an audit event, and schedule a safe service restart. The user-facing documentation (`README.md`) and threat model (`SECURITY.md`) are updated to specify the V2 security boundaries, setup instructions, Windows UAC requirements, and a 9-point attack verification checklist.

**Tech Stack:** TypeScript/Node 24, `node:crypto`, `node:fs/promises`, `node:net`, `vitest`.

**Spec:** `docs/specs/2026-10-27-u-chan-secrets-v2-design.md`

## Global Constraints

- Nothing secret (password, TOTP seed, Bitwarden session, master password) appears in an IPC response, audit entry, stderr log, or thrown message.
- The service updates itself; user-writable npm directories are never executed with admin/root privileges.
- Package updates must verify SHA-512 integrity and npm registry signature/provenance before replacing any admin-owned files.
- The audit log remains read-only for normal users; `u-chan audit` queries the service over IPC and does not append an audit event.
- Windows UAC security boundary requires "Always notify" or a standard user account; `README.md` must explicitly document this requirement.
- macOS supports hardcore mode only; `README.md` and `SECURITY.md` must explain the Accessibility API synthetic click constraint.
- All code additions follow TDD: failing test first, minimal implementation, passing test, atomic commit.

## Review Focus

1. **Audit log missing or empty.** Calling `u-chan audit` before any logins or if the file was deleted must return `"no audit log entries"` cleanly without throwing `ENOENT` or crashing. (Tested in Task 1: `returns clean message when audit log is empty or missing`).
2. **Tampered or corrupt package during self-update.** If an npm mirror, network proxy, or CDN serves a corrupted or altered tarball, the SHA-512 integrity or registry signature verification must fail, the download must be aborted immediately, and no existing service files may be touched. (Tested in Task 3: `rejects tarball with mismatched integrity hash`).
3. **Staged package missing required entrypoints.** If an update tarball is signed and downloaded but lacks `dist/index.js` or `dist/cli.js` (e.g. malformed build published), the atomic replacement must abort, rollback, and keep the existing service running. (Tested in Task 4: `aborts update and rolls back if staged package is malformed`).
4. **Invalid or non-numeric limit passed to `u-chan audit`.** If a user or script calls `u-chan audit -5` or `u-chan audit abc`, CLI must reject it with a clear error without crashing or sending bad params over IPC. (Tested in Task 2: `rejects non-positive or non-integer audit limit`).
5. **IPC timeout during self-update.** Downloading and verifying a package over a slow network can take > 10 seconds. The CLI must use an extended timeout (120 seconds) for `update` so it does not time out while the service is downloading. (Tested in Task 5: `update uses extended 120s timeout`).

---

### Task 1: Audit Log Querying and Service IPC

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/audit.ts`
- Modify: `src/ipc/protocol.ts`
- Modify: `src/ipc/server.ts`
- Modify: `src/ipc/client.ts`
- Modify: `src/service/control.ts`
- Modify: `src/service/main.ts`
- Test: `test/audit.test.ts`
- Test: `test/control.test.ts`
- Test: `test/ipc.test.ts`

**Interfaces:**
- Produces (`src/core/types.ts`):
  ```ts
  export interface AuditRecord {
    ts: string
    action: AuditEvent['action']
    domain: string
    result: string
  }
  export interface AuditLog {
    record(event: AuditEvent): Promise<void>
    readTail(limit?: number): Promise<AuditRecord[]>
  }
  // ControlApi adds audit
  export interface ControlApi {
    unlock(): Promise<ToolResult>
    lock(): Promise<ToolResult>
    setMode(mode: ApprovalMode): Promise<ToolResult>
    importV1(entries: unknown[]): Promise<ToolResult>
    audit(limit?: number): Promise<ToolResult>
  }
  ```
- Produces (`src/core/audit.ts`):
  `FileAuditLog.prototype.readTail(limit = 100): Promise<AuditRecord[]>`: reads `this.path`, skips invalid lines, returns at most `limit` most recent parsed records. Returns `[]` if file missing.
- Produces (`src/ipc/protocol.ts`):
  `Method` union adds `'audit'`.
- Produces (`src/ipc/server.ts`):
  Handler for `audit`: validates `limit` (optional positive integer, rejects non-integers, `<= 0`, or non-numbers) and dispatches `api.audit(limit)`.
- Produces (`src/ipc/client.ts`):
  `IpcClient.prototype.audit(limit?: number): Promise<ToolResult>`.
- Produces (`src/service/control.ts`):
  `ControlService.prototype.audit(limit?: number): Promise<ToolResult>`: formats records as newline-delimited human-readable strings (`${r.ts}  ${r.action.padEnd(13)}  ${r.domain ? r.domain + '  ' : ''}${r.result}`). Returns `{ ok: true, message: 'no audit log entries' }` when empty. Does NOT call `this.guarded` or record an audit event.

- [ ] **Step 1: Write the failing tests**
  - In `test/audit.test.ts`:
    - `FileAuditLog.readTail returns empty array when file does not exist`: instance pointing to non-existent file returns `[]`.
    - `FileAuditLog.readTail returns parsed records in order`: record 3 events, readTail returns all 3 with matching `ts`, `action`, `domain`, `result`.
    - `FileAuditLog.readTail limits to the last N entries`: record 5 events, `readTail(2)` returns only the last 2.
    - `FileAuditLog.readTail skips blank and corrupted lines`: write manual file with 1 valid line, 1 garbage string line, 1 empty line, 1 valid line; returns 2 valid records.
  - In `test/control.test.ts`:
    - `control: audit formats records`: fake audit log with 2 records -> returns `{ ok: true, message: <formatted lines> }`.
    - `control: audit returns clean message when audit log is empty`: fake audit log with 0 records -> returns `{ ok: true, message: 'no audit log entries' }`.
    - `control: audit does not append an audit event`: verify `audit.record` is not called during `control.audit()`.
  - In `test/ipc.test.ts`:
    - `ipc: round-trips audit method`: client calls `client.audit(50)` -> fake receives `limit: 50` -> returns formatted message.
    - `ipc: rejects invalid audit limit`: request with `params: { limit: -1 }` or `params: { limit: 'lots' }` returns `{ ok: false, message: 'bad request' }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/audit.test.ts test/control.test.ts test/ipc.test.ts`
Expected: FAIL with missing methods `readTail` and `audit`.

- [ ] **Step 3: Implement audit querying across core, IPC, and service**

In `src/core/types.ts`:
Add `AuditRecord` interface and update `AuditLog` and `ControlApi`.

In `src/core/audit.ts`:
Implement `readTail(limit = 100): Promise<AuditRecord[]>` reading file with `readFile(this.path, 'utf8')`, handling `ENOENT` by returning `[]`, parsing JSON lines, and returning `records.slice(-limit)`.

In `src/ipc/protocol.ts`:
Add `'audit'` to `Method`.

In `src/ipc/server.ts`:
Add `audit` to `handlers`:
```ts
audit: (api, p) => {
  if (p.limit !== undefined && (!Number.isInteger(p.limit) || (p.limit as number) <= 0)) return BAD
  return api.audit(p.limit as number | undefined)
}
```

In `src/ipc/client.ts`:
Add `audit(limit?: number)`:
```ts
audit(limit?: number) { return this.call('audit', limit !== undefined ? { limit } : {}) }
```

In `src/service/control.ts`:
Implement `audit(limit?: number)`:
```ts
async audit(limit?: number): Promise<ToolResult> {
  try {
    const records = await this.d.audit.readTail(limit)
    if (records.length === 0) return { ok: true, message: 'no audit log entries' }
    const message = records
      .map((r) => `${r.ts}  ${r.action.padEnd(13)}  ${r.domain ? r.domain + '  ' : ''}${r.result}`)
      .join('\n')
    return { ok: true, message }
  } catch {
    return { ok: false, message: 'could not read audit log' }
  }
}
```

In `src/service/main.ts`:
Add `audit: (limit) => control.audit(limit)` to the `api` object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/audit.test.ts test/control.test.ts test/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/audit.ts src/ipc/protocol.ts src/ipc/server.ts src/ipc/client.ts src/service/control.ts src/service/main.ts test/audit.test.ts test/control.test.ts test/ipc.test.ts
git commit -m "feat(audit): add readTail query to audit log and wire to IPC"
```

---

### Task 2: CLI Audit Command (`u-chan audit`)

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `ControlApi.audit(limit?: number)` (Task 1).
- Produces: CLI support for `u-chan audit [limit]`. When `limit` is provided, parses as positive integer; rejects invalid values with exit code 1; outputs formatted log to stdout with exit code 0; outputs errors to stderr with exit code 1.

- [ ] **Step 1: Write the failing tests** in `test/cli.test.ts`:
  - `audit prints formatted log and exits 0`: fake client returns `{ ok: true, message: '2026-10-27T... login ok' }` -> `out` receives message, exit code 0.
  - `audit passes parsed limit`: run `['audit', '25']` -> `client.audit` called with `25`.
  - `audit rejects non-positive or non-integer audit limit`:
    - run `['audit', 'abc']` -> `err` receives `'limit must be a positive integer'`, exit code 1, `client.audit` not called.
    - run `['audit', '-5']` -> `err` receives `'limit must be a positive integer'`, exit code 1.
    - run `['audit', '0']` -> `err` receives `'limit must be a positive integer'`, exit code 1.
  - `audit reports service errors`: fake client returns `{ ok: false, message: 'U-Chan service is not running — run u-chan install' }` -> `err` receives message, exit code 1.
  - `usage message includes audit`: run `[]` -> usage contains `audit [limit]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL on `audit` command unrecognized.

- [ ] **Step 3: Implement `audit` command in `src/cli.ts`**

Update `USAGE`:
```ts
const USAGE = 'usage: u-chan unlock | lock | mode <easy|hardcore> | import-v1 [path] | audit [limit]'
```

In `main(argv, d)`:
Add branch:
```ts
else if (cmd === 'audit' && rest.length === 0) {
  let limit: number | undefined
  if (arg !== undefined) {
    const parsed = Number(arg)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      d.err('limit must be a positive integer')
      return 1
    }
    limit = parsed
  }
  call = () => d.connect({}).audit(limit)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat(cli): add u-chan audit command"
```

---

### Task 3: Package Verifier (Registry Metadata, SHA-512 SRI, Signatures & Provenance)

**Files:**
- Create: `src/service/update/verifier.ts`
- Modify: `src/core/types.ts`
- Test: `test/update-verifier.test.ts`

**Interfaces:**
- Produces (`src/core/types.ts`):
  ```ts
  export interface RegistryDist {
    tarball: string
    shasum: string
    integrity?: string
    signatures?: Array<{ keyid: string; sig: string }>
    attestations?: { url: string }
  }
  export interface PackageVersionInfo {
    version: string
    dist: RegistryDist
  }
  export interface PackageMetadata {
    'dist-tags': { latest: string }
    versions: Record<string, PackageVersionInfo>
  }
  export interface VerificationOutcome {
    ok: boolean
    targetVersion?: string
    tarball?: Buffer
    error?: string
  }
  export interface PackageVerifier {
    checkLatest(currentVersion: string): Promise<{ isNewer: boolean; latestVersion: string }>
    verify(targetVersion: string): Promise<VerificationOutcome>
  }
  ```
- Produces (`src/service/update/verifier.ts`):
  `class NpmPackageVerifier implements PackageVerifier`:
  Constructor options: `{ packageName?: string; registryUrl?: string; npmPublicKey?: string; expectedRepo?: string; fetcher?: typeof fetch }`.
  - `checkLatest(currentVersion)`: fetches `${registryUrl}/${packageName}`, checks if `dist-tags.latest` is semver-greater than `currentVersion`.
  - `verify(targetVersion)`:
    1. Fetches metadata and locates version `targetVersion`.
    2. Downloads tarball into memory.
    3. Verifies SHA-512 against `dist.integrity` (using `crypto.createHash('sha512')`).
    4. Verifies ECDSA signature in `dist.signatures` for `${packageName}@${version}:${dist.shasum}` against npm registry public key using `crypto.verify`.
    5. If `dist.attestations?.url` is present, fetches attestation bundle and verifies repository matches `expectedRepo` (default `https://github.com/anchuwithdeadline/u-chan-secrets`).
    6. Returns `{ ok: true, targetVersion, tarball }` or `{ ok: false, error }`.

- [ ] **Step 1: Write the failing tests** in `test/update-verifier.test.ts`:
  - `detects when new version is available`: metadata latest is `2.1.0`, current is `2.0.0` -> `isNewer: true, latestVersion: '2.1.0'`.
  - `detects when current version is already up to date`: metadata latest is `2.0.0`, current is `2.0.0` -> `isNewer: false`.
  - `verifies valid package with matching SHA-512 and valid signature`: mock fetch returning valid tarball buffer, correct SHA-512 SRI string, and ECDSA signature signed by test keypair -> returns `{ ok: true, tarball }`.
  - `rejects tarball with mismatched integrity hash`: mock fetch returning tarball with wrong SHA-512 -> returns `{ ok: false, error: 'integrity check failed' }`.
  - `rejects package with invalid registry signature`: valid hash but signature corrupt/tampered -> returns `{ ok: false, error: 'registry signature verification failed' }`.
  - `rejects package when provenance repository does not match`: attestation URL returns bundle with repo `https://github.com/attacker/malicious` -> returns `{ ok: false, error: 'provenance repository mismatch' }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/update-verifier.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `NpmPackageVerifier` in `src/service/update/verifier.ts`**

Implement semver comparison helper (or parse `major.minor.patch[-prerelease]`).
Implement SHA-512 verification:
```ts
const hash = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64')
if (dist.integrity && hash !== dist.integrity) return { ok: false, error: 'integrity check failed' }
```
Implement npm ECDSA signature check:
Format string `${packageName}@${version}:${dist.shasum}`.
Verify with `crypto.verify(null, Buffer.from(signedStr), key, Buffer.from(sig, 'base64'))`.
Implement provenance check if attestation URL present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/update-verifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/service/update/verifier.ts test/update-verifier.test.ts
git commit -m "feat(update): add NpmPackageVerifier for integrity, signature, and provenance checks"
```

---

### Task 4: Service Self-Updater & Safe Restart

**Files:**
- Create: `src/service/update/updater.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/config.ts`
- Modify: `src/service/control.ts`
- Modify: `src/ipc/protocol.ts`
- Modify: `src/ipc/server.ts`
- Modify: `src/ipc/client.ts`
- Modify: `src/service/main.ts`
- Test: `test/updater.test.ts`
- Test: `test/control.test.ts`

**Interfaces:**
- Produces (`src/core/types.ts`):
  ```ts
  export interface ServiceRestarter {
    restart(): Promise<void>
  }
  // AuditEvent adds 'update'
  export type AuditEvent = { action: 'login' | 'request_allow' | 'revoke' | 'unlock' | 'lock' | 'mode' | 'import' | 'update'; domain: string; result: string }
  // ControlApi adds update()
  export interface ControlApi {
    unlock(): Promise<ToolResult>
    lock(): Promise<ToolResult>
    setMode(mode: ApprovalMode): Promise<ToolResult>
    importV1(entries: unknown[]): Promise<ToolResult>
    audit(limit?: number): Promise<ToolResult>
    update(): Promise<ToolResult>
  }
  ```
- Produces (`src/service/update/updater.ts`):
  `class ServiceUpdater`:
  Constructor: `({ verifier, restarter, programDir, stagingDir, currentVersion, extractArchive }: UpdaterDeps)`.
  `update(): Promise<ToolResult>`:
  1. Checks if newer version exists; if not, returns `{ ok: true, message: 'already up to date (version X.Y.Z)' }`.
  2. Verifies tarball buffer via `verifier.verify(latestVersion)`. If invalid, returns `{ ok: false, message: 'update failed: ' + res.error }`.
  3. Unpacks tarball into `<stagingDir>/staging-<version>`.
  4. Validates staged payload: `package.json` exists with matching name and version, `dist/index.js` and `dist/cli.js` exist.
  5. Backs up `<programDir>` to `<programDir>.bak`.
  6. Atomically replaces `<programDir>` files with staged files.
  7. Cleans up staging and backup files. (On failure during replacement, restores from backup).
  8. Triggers `restarter.restart()` asynchronously (via `setImmediate`).
  9. Returns `{ ok: true, message: 'updated to version ' + latestVersion + ' — restarting service' }`.

- [ ] **Step 1: Write the failing tests** in `test/updater.test.ts` and `test/control.test.ts`:
  - In `test/updater.test.ts`:
    - `reports already up to date when no newer version`: verifier reports no update -> `{ ok: true, message: 'already up to date (version 2.0.0)' }`; restarter not called.
    - `stages verified package, validates files, and performs atomic replacement`: mock verifier returns valid tarball, mock extractor creates files; programDir updated with new files, restarter scheduled.
    - `aborts update and rolls back if staged package is malformed`: mock extractor omits `dist/index.js` -> returns `{ ok: false, message: 'staged package is invalid: missing dist/index.js' }`; original programDir untouched.
    - `restores from backup if file swap fails`: simulate disk error during copy -> original programDir restored.
  - In `test/control.test.ts`:
    - `control: update records audit event on success`: mock updater returns ok -> audit log contains `action: 'update'`, `result: 'updated to 2.1.0'`.
    - `control: update records audit event on failure`: mock updater returns fail -> audit log contains `action: 'update'`, `result: 'failed: integrity check failed'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/updater.test.ts test/control.test.ts`
Expected: FAIL (modules/methods missing).

- [ ] **Step 3: Implement `ServiceUpdater` and wire to `ControlService` and IPC**

In `src/core/types.ts`:
Add `'update'` to `AuditEvent['action']` and `update(): Promise<ToolResult>` to `ControlApi`.

In `src/core/config.ts`:
Add `programDir` and `stagingDir` to `serviceConfig`:
- `programDir`: path.join(home, 'program')
- `stagingDir`: path.join(home, 'staging')

In `src/service/update/updater.ts`:
Implement `ServiceUpdater` with backup, atomic swap, validation, and deferred restart.

In `src/service/control.ts`:
Add `updater: ServiceUpdater` to `ControlService` deps.
Implement `update()` wrapped with `this.guarded('update', () => this.d.updater.update())`.

In `src/ipc/protocol.ts`:
Add `'update'` to `Method`.

In `src/ipc/server.ts`:
Add `update: api => api.update()` to `handlers`.

In `src/ipc/client.ts`:
Add `update()`:
```ts
update() { return this.call('update') }
```

In `src/service/main.ts`:
Instantiate `NpmPackageVerifier`, platform-appropriate `ServiceRestarter`, and `ServiceUpdater`, and add `update: () => control.update()` to `api`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/updater.test.ts test/control.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/config.ts src/service/update/updater.ts src/service/control.ts src/ipc/protocol.ts src/ipc/server.ts src/ipc/client.ts src/service/main.ts test/updater.test.ts test/control.test.ts
git commit -m "feat(update): implement service self-update with atomic replacement and safe restart"
```

---

### Task 5: CLI Update Command (`u-chan update`)

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `ControlApi.update()` (Task 4).
- Produces: CLI support for `u-chan update`. Calls `connect({ timeoutMs: 120000 }).update()`; prints success message to stdout with exit code 0; prints failure to stderr with exit code 1.

- [ ] **Step 1: Write the failing tests** in `test/cli.test.ts`:
  - `update prints message and exits 0 on success`: fake client returns `{ ok: true, message: 'updated to 2.1.0 — restarting service' }` -> stdout contains message, exit code 0.
  - `update uses extended 120s timeout`: verify `connect` was called with `{ timeoutMs: 120000 }` (to allow package download).
  - `update prints error and exits 1 on failure`: fake client returns `{ ok: false, message: 'update failed: integrity check failed' }` -> stderr contains error, exit code 1.
  - `usage message includes update`: run `[]` -> usage contains `update`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL on `update` unrecognized.

- [ ] **Step 3: Implement `update` command in `src/cli.ts`**

Update `USAGE`:
```ts
const USAGE = 'usage: u-chan unlock | lock | mode <easy|hardcore> | import-v1 [path] | audit [limit] | update'
```

In `main(argv, d)`:
Add branch:
```ts
else if (cmd === 'update' && arg === undefined) {
  call = () => d.connect({ timeoutMs: 120000 }).update()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat(cli): add u-chan update command with 120s timeout"
```

---

### Task 6: Comprehensive Documentation Rewrite (`README.md`)

**Files:**
- Modify: `README.md`

**Contents:**
- Complete rewrite for U-Chan Secrets V2:
  1. **Title and Value Proposition:**
     - Bitwarden-backed MCP login for Claude Code that protects credentials even if Claude is tricked by prompt injection or running in bypass permissions mode.
  2. **Architecture Diagram and Components:**
     - Privileged background service (SYSTEM on Windows / launchd on macOS) holding Bitwarden session in memory only.
     - Thin MCP client talking over local IPC.
     - Protected prompt windows (keystroke isolation and synthetic click defense).
     - Service-owned headless browser performing logins; only session cookies and localStorage injected into user's Chrome over CDP.
     - Anti-phishing secret phrase displayed on all official prompts.
  3. **Prerequisites:**
     - Node.js 24+
     - Bitwarden CLI (`bw` native binary)
     - Google Chrome
  4. **Installation Guide:**
     - **Windows Installation:**
       - `npm install -g u-chan-secrets`
       - `u-chan install` (triggers elevation, creates service, configures initial mode and secret phrase).
       - **CRITICAL Windows Security Notice (UAC Configuration):**
         - Explain why Windows default UAC on an administrator account allows silent UAC bypasses.
         - State clearly: *The V2 security guarantee holds on Windows ONLY if UAC is set to "Always Notify" or if Claude Code is run from a Standard User account.*
     - **macOS Installation:**
       - `npm install -g u-chan-secrets`
       - `sudo u-chan install`
       - Note: macOS is strictly hardcore mode only due to Accessibility API synthetic click allowances.
  5. **MCP Registration:**
     - `claude mcp add u-chan-secrets -- u-chan-secrets`
     - Configuring Playwright MCP to connect to shared CDP endpoint (`http://127.0.0.1:9222`).
     - Dedicated Chrome profile and starting Chrome.
  6. **Admin CLI Reference (`u-chan`):**
     - Table of all commands: `install`, `uninstall`, `unlock`, `lock`, `mode <easy|hardcore>`, `import-v1 [path]`, `audit [limit]`, `update`.
     - Daily workflow: `u-chan unlock`, browse with Claude, `u-chan lock`.
  7. **Approval Modes:**
     - Comparison table: Easy (click OK, Windows only) vs Hardcore (master password required, Windows & macOS).
     - Downgrade protection: switching from Hardcore to Easy requires master password.
     - 5 wrong attempts = 15-minute lockout.
  8. **Migration from V1:**
     - Running `u-chan import-v1`.
     - Retiring `bw-session` and `scripts/unlock.ps1`.
     - User-side `bw logout`.

- [ ] **Step 1: Draft and update `README.md` with complete V2 documentation**
- [ ] **Step 2: Verify all links, code blocks, and formatting**
- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for V2 architecture, setup, UAC guidance, and CLI reference"
```

---

### Task 7: Threat Model & Attack Checklist (`SECURITY.md`)

**Files:**
- Modify: `SECURITY.md`
- Create: `docs/attack-checklist.md`

**Contents:**
- `SECURITY.md`:
  - Vulnerability reporting process and SLA.
  - V2 Security Scope & Adversarial Model:
    - Assumes Claude Code has full shell access, user file read/write, user browser automation, and may be compromised by arbitrary prompt injection.
    - Security Boundaries:
      1. *OS Identity Boundary:* Service data (`allowlist.json`, `audit.log`, Bitwarden data) owned by SYSTEM/root; inaccessible to user account.
      2. *Memory-Only Session:* Bitwarden session never touches disk; locked automatically on idle timeout (12 h) or reboot.
      3. *Protected Window Isolation:* Keystrokes cannot be intercepted by user hooks; synthetic clicks blocked by UIPI on Windows; hardcore mode enforces password entry on macOS.
      4. *Anti-Phishing Secret Phrase:* Defense against lookalike prompts generated by the AI.
      5. *Browser Isolation:* Credentials entered in isolated headless browser; only session cookies for allowlisted origins injected over CDP.
      6. *Cryptographic Update Verification:* `u-chan update` checks npm registry signatures and SHA-512 integrity before touching admin files.
- `docs/attack-checklist.md`:
  - Detailed manual attack verification test scenarios (Spec §7):
    1. **Attack 1 (Direct File Read):** From a user prompt, run PowerShell/bash to read `C:\ProgramData\u-chan-secrets\settings.json` or `/Library/Application Support/u-chan-secrets/settings.json`. -> Expected: Access Denied.
    2. **Attack 2 (Bitwarden CLI Theft):** Run `bw status` and `bw list items` from the user shell. -> Expected: Vault locked or unauthenticated; zero items returned.
    3. **Attack 3 (Service Browser Snooping):** Scan ports and attempt CDP connection to the service's internal browser. -> Expected: Connection refused (no open user-reachable debugging port).
    4. **Attack 4 (Synthetic Input to Approval Dialog):** Run a script (`SendKeys`, `pynput`, AppleScript) targeting the protected approval window. -> Expected: Keystrokes and clicks dropped / blocked.
    5. **Attack 5 (Tampering with Program Files):** Attempt to write or overwrite files in the service program directory. -> Expected: Permission denied.
    6. **Attack 6 (Direct Mode Downgrade):** Attempt to downgrade mode from Hardcore to Easy without typing the master password. -> Expected: Refused by service.
    7. **Attack 7 (Playwright Init Script Sniffing):** Claude registers a Playwright init script on the user's Chrome to intercept password input before calling `login`. -> Expected: Credentials are submitted inside the service browser; user Chrome only receives post-login cookies.
    8. **Attack 8 (Lookalike Phishing):** Claude displays an unauthorized modal or prompt asking for the Bitwarden master password. -> Expected: User spots the missing anti-phishing secret phrase and aborts.
    9. **Attack 9 (Log and Transcript Secret Leak Check):** Grep full user directory, Claude Code project transcripts, and audit log for password strings. -> Expected: 0 matches found.

- [ ] **Step 1: Write `docs/attack-checklist.md` with complete 9-point verification scenarios**
- [ ] **Step 2: Update `SECURITY.md` referencing the threat model and attack checklist**
- [ ] **Step 3: Commit**

```bash
git add SECURITY.md docs/attack-checklist.md
git commit -m "docs(security): update threat model and add manual attack verification checklist"
```

---

### Task 8: Full End-to-End Build and Verification

**Files:**
- Test: all test files

- [ ] **Step 1: Run complete test suite**

Run: `cmd.exe /c npm test`
Expected: All tests PASS.

- [ ] **Step 2: Run build**

Run: `cmd.exe /c npm run build`
Expected: TypeScript compile completes with 0 errors, output in `dist/`.

- [ ] **Step 3: Verification of all CLI commands**

Verify CLI help and usage string matches all implemented commands:
`u-chan unlock | lock | mode <easy|hardcore> | import-v1 [path] | audit [limit] | update`

- [ ] **Step 4: Final commit**

```bash
git commit --allow-empty -m "chore(release): Plan 4 complete - self-update, audit CLI, and V2 documentation"
```
