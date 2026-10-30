# Security Policy

U-Chan Secrets handles real credentials, privileged processes, and signed-in browser sessions. Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/anchuwithdeadline/u-chan-secrets/security/advisories/new), not a public issue.

Include the affected version, OS, approval mode, attack steps, expected/observed behavior, and impact. Use disposable test credentials in reproductions. Never include real passwords, TOTP material, cookies, or vault session keys. Initial response target: seven days.

## Version and verification status

| Source line | Status |
|---|---|
| 5.x | Published 5.0.0 signature/hash verified; disposable Chrome/Edge SYSTEM matrices and Windows installation verified on the documented host; macOS runtime unverified |
| 4.x | Published 4.0.0 signature/hash verified; Windows rollout passed on the documented host; macOS runtime unverified |
| 3.x | Stable npm 3.0.3; Windows closeout verified on the documented host; macOS runtime unverified |
| 2.x | Previous architecture; upgrade to V3 source through the documented trusted reinstall flow |
| 1.x | Deprecated; its user-writable session/authorization storage is outside the V3 boundary |

Source merge, package publication, installation, CI, and observed native security verification are separate events. Version `3.0.0` in package metadata does not establish npm publication or deployment.

The [validation report](docs/superpowers/research/2026-10-29-v3-validation.md) records local evidence and CI history. The tightened [Windows closeout](docs/superpowers/research/2026-10-29-v3-windows-closeout.md) passed actual native isolation, disposable browser/update verification, module inspection, and final state-preserving V3.0.3 reinstall on the documented host. These observations are scoped to that host and revision. macOS runtime remains unverified. CI, native compilation, and mock-based tests do not establish native security properties by themselves.

## Threat model

Assume the AI may be prompt-injected or actively adversarial while running as the installed desktop user. It can execute shell commands, read/write user files, control the selected user Chrome/Edge through CDP, and call every exposed MCP tool with arbitrary arguments.

The intended protected assets are website credentials, TOTP seeds/codes, Bitwarden session keys/data, authorization settings, and privileged executable integrity.

Outside scope:

- Existing administrator/root compromise, physical access, and hardware interception.
- Denial of service against user-level tools/configuration.
- Misuse of an already transferred authenticated website session.

On Windows, use UAC **Always notify** or a standard account for the AI. The service boundary does not defend an administrator account whose configuration permits silent elevation bypasses. macOS permits hardcore approval only because Accessibility-enabled applications can synthesize ordinary window clicks.

## Credential and execution boundary

The service runs as SYSTEM on Windows or root on macOS. Protected state resides under `%ProgramData%\u-chan-secrets` or `/Library/Application Support/u-chan-secrets`. The desktop thin client forwards requests through caller-authenticated local IPC and never receives vault credentials.

V3 stages private runtime, dependencies, Bitwarden, and Chromium assets. Windows ownership/DACL setup replaces unrelated grants, refuses reparse points, and normalizes the protected tree. Verify the actual permissions and every native library/executable loaded by the service on the target OS.

The Bitwarden session is retained in service memory and supplied through the environment of privileged Bitwarden child processes when required. It is not written to a desktop session file or the desktop environment. Session access is invalidated on manual lock, restart/reboot, or the configured idle limit. JavaScript string handling is not a claim of cryptographic memory zeroization.

Credentials are entered only in the isolated service browser. User Chrome receives filtered cookies/localStorage for approved hosts. Raw login-page text, screenshots, passwords, TOTP material, and vault session keys are not returned through MCP.

## Protected user interaction

Windows prompt helpers require SYSTEM identity and use a separate input desktop. Cross-session results use a SYSTEM-only named pipe; failed protected launch must deny rather than fall back to an ordinary approval window. UIPI alone is not the claimed keyboard-isolation mechanism.

macOS password entry uses `NSSecureTextField` with secure input enabled around the modal interaction and disabled during cleanup. Hardcore mode remains enforced. Verify actual keyboard hooks, synthetic input, screen exposure, cancellation, and failure behavior on the installed platform.

A service-stored phrase appears in genuine prompts as a user verification cue. It is not a substitute for OS isolation or protection after administrator/root compromise. Never enter a master password into an AI conversation or an untrusted lookalike prompt.

Protected prompts time out after two minutes. Five failed password checks trigger a 15-minute lockout. Lowering Windows approval mode from hardcore to easy requires a protected password check.

## Authorization and authentication results

The service enforces one-attempt, timed, and permanent grants; the AI only proposes their scope. New/changed identity, hosts, selectors, duration, and success conditions require protected approval. Legacy callers omitting policy request permanent access, explicitly displayed in the prompt.

A once grant is consumed durably before login after preflight; a failed reserved attempt still counts. The shared queue prevents two calls from using the same once grant. Timed expiry is checked around credential acquisition and export/transfer. Detected backward-clock movement beyond the one-second tolerance invalidates affected persisted timed grants. Changes while the service is stopped are not reconstructible from wall-clock time alone.

An approved success condition is checked inside the isolated browser on an allowed host. Generic form disappearance or a blank page is insufficient confirmation. Legacy flows may transfer state but return `authentication_unconfirmed`; an unmet configured condition prevents transfer. User-approved selectors must themselves be meaningful evidence.

A shared deadline covers preflight, vault subprocesses, browser initialization, and transfer. Cancellation closes owned resources and disconnects the service's CDP transport without intentionally closing shared user Chrome. An already started transfer cannot be recalled.

**Expiry, revocation, and vault lock do not invalidate website sessions already transferred into Chrome.** Revocation waits behind an earlier queued login. Target-site authorization governs subsequent destructive actions.

## Diagnostics and management

Doctor is read-only: it returns fixed safe findings and next actions, without credential retrieval or automatic repair. A known browser-sharing mismatch fails diagnosis; unobservable sharing is advisory.

Management shows sanitized state/activity and supports lock, unlock, refresh, and revocation. It cannot create or extend grants. Native helper output requests an action; the service revalidates the action/target. Unlock requires the protected password flow after the management dialog closes.

V4 setup runs only as a non-elevated desktop process. Automatic configuration supports the official Codex CLI on Windows; it does not execute user-owned clients or Chrome under administrator authority. Default setup is read-only. Explicit flags permit narrow MCP registration changes and dedicated browser startup. Existing advanced settings are preserved, and existing config bytes are backed up before mutation. A partial failure never restores an obsolete whole configuration over unrelated concurrent changes.

Setup accepts only HTTP loopback browser origins without URL credentials, path, query, or fragment. Known service/desktop target mismatches block automatic configuration and startup. Setup never changes UAC or installs the service. Version checks use actual package metadata; absent or invalid metadata is unknown. Process arguments and saved registrations are configuration evidence, not proof of active AI-session browser ownership.

The V4 `allow` command proposes policy through the existing protected service approval. It cannot edit the protected grant store. Its default is one login attempt; omitting a success condition still permits an explicitly unconfirmed result. Protocol and protected-state schema remain version 3.

## Install, migration, and update integrity

Perform initial installation from a trusted shell before unrestricted AI access. Do not use `scripts/debug-install.bat` for V3 setup or upgrades: that legacy script invokes destructive uninstall and exports protected settings into the checkout. Use the [documented CLI installer](README.md#build-and-install-from-source).

Before grant-state mutation, V3 creates an administrator-owned pre-migration snapshot and schema marker. Protection is established before copying sensitive contents. Incomplete backup/invalid marker blocks mutation. Do not move privileged backups into user-readable storage.

Supported V3 tooling refuses incompatible V2 downgrade after migration. Historical V2 installers cannot enforce the new marker. Deliberate rollback requires stopped-service recovery of reviewed protected state; old permanent grants may return.

Compatible package updates verify registry signatures/integrity and preserve private dependencies. Dependency/native-helper changes require a trusted administrator reinstall. Reinstall and merge are not proof of live service health.

Version 3.0.3 verifies npm's ECDSA-SHA256 signature over `name@version:dist.integrity` using the pinned registry key and matching key ID. SHA-512 tarball integrity and a valid signature are both mandatory. Repository-attestation JSON is an additional metadata policy check; it is not cryptographic Sigstore verification and never substitutes for a signature. Empty custom verification keys fail closed. Unknown registry keys require a trusted verifier upgrade. Versions 3.0.0–3.0.2 require the documented trusted reinstall to bootstrap this correction.

## Verification and exclusions

Run the [manual attack checklist](docs/attack-checklist.md) with disposable state before release. Record PASS, FAIL, or UNAVAILABLE independently for each OS. Preserve separate evidence for source tests, CI, actual native execution, installation, and public/package release.

Windows Hello/Touch ID is [research only](docs/superpowers/research/2026-10-29-native-approval.md). V3 does not replace Bitwarden unlock with biometrics, support Linux, or automate general OAuth/passkeys/CAPTCHA challenges.
