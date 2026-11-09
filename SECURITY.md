# Security Policy

## Item picker

`request_allow` without an item lists the vault login items matching the login URL inside the service. Only item ids and display labels (name and username) leave the vault, and labels are shown only in the protected window; the AI receives the chosen id through `list_allowed` and nothing else. Every outcome opens a protected window before the AI gets an answer (no match and too many matches show a Close-only notice), so the AI cannot probe which sites the vault holds without the user seeing it. Platforms without a protected picker (macOS) require an explicit item and never list the vault.

## Agent unlock and GitHub extension

`request_unlock` accepts no caller-controlled password, reason, or prompt text. It uses authenticated owner IPC and the existing native password collection path. Concurrent requests share one attempt, with a cooldown after dismissal and the existing shared failed-password limiter. Explicit lock invalidates pending unlock work. The tool returns status only. Clients must stop after cancellation or failure rather than retrying indefinitely.

GitHub connections require protected review of the exact repository and Bitwarden item/field reference. A numeric repository ID is captured at enrollment and checked on subsequent requests. The service uses `api.github.com` only, rejects redirects, constructs typed routes, bounds response size/time, projects metadata, and treats returned text as untrusted. No token value crosses MCP or IPC. Errors and audit entries exclude remote error bodies and credential values.

Every issue/draft-PR creation requires separate protected review. Exact content and branch tips are reviewed, vault/connection/repository state is checked again, and an audit intent is written before dispatch. An in-process vault authorization generation is captured immediately after approval and checked with unlocked status immediately before POST; lock, re-unlock, or idle expiry during any intervening await invalidates approval. No request is automatically replayed. Post-send transport failures and unverifiable successes report uncertainty. GitHub cannot atomically bind PR creation to the reviewed tips, so a changed returned tip is uncertain rather than success. The initial connector does not expose repository files, logs, workflow execution, pushes, merges, or deletion.

Tests and static review do not establish live token permissions or installed SYSTEM behavior. Live verification must use a user-selected item and repository; test writes require a separate explicit task and protected approval.

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

### Discord broker (unreleased source)

The Windows-only broker reads an approved Bitwarden item's password or one explicitly named hidden custom field inside the privileged service. Desktop IPC/MCP never exposes a token retrieval, authenticated generic fetch, or secret-injected execution primitive. Connections bind one alias to one exact server ID and token field, in protected `discord-allowlist.json`; tokens are not persisted there. Before the first broker policy mutation per process, the service creates a protected metadata snapshot under `#0 backup`.

Connection approval permits server/channel/role metadata reads until revoked. Every write batch separately requires protected approval of its exact typed operations and disclosed permission changes. The native review surface must show complete wrapped details without ellipsis. This changes the Windows native helper and therefore requires trusted reinstall; source compilation is not proof of installed input isolation or readability. macOS broker requests are refused.

The broker builds fixed Discord API v10 routes internally, refuses redirects and arbitrary caller URLs/headers, bounds responses and execution, projects response fields, redacts token echoes before returning results, and suppresses raw upstream exceptions. It revalidates server membership, hierarchy, policy, and vault state before dispatch. The limited operation set excludes deletion, messages, moderation, administrator grants, and assignment of an existing administrator role.

Metadata names/topics remain attacker-controlled data. An agent must never treat those strings as instructions. Protected approval is still a human decision: another approved role or overwrite change may grant substantial authority or expose private channels. The complete prompt must be reviewed, including `@everyone` changes and overwrite replacement.

Writes run sequentially, stop at first failure, and do not roll back. An interrupted/ambiguous write may have succeeded; inspect before proposing another batch. Revocation waits behind earlier queued work and blocks future broker access; it cannot undo completed changes, revoke the Discord token, or recall a dispatched HTTP request. Vault lock blocks subsequent credential acquisition/dispatch checks but does not invalidate a token already sent to Discord. Audit intent must succeed before dispatch; an audit failure after execution reports that the change may already exist.

Existing privileged-process integrity, native input isolation, UAC, and protected-tree permission requirements still apply. A protected source tree and successful mocked HTTP tests are not installed-service or live Discord verification.

### Website login and service integrity

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

A once grant is reserved durably before login after preflight and counts as used once the runner requests credentials, even if sign-in then fails. A failure or throw before credentials are requested refunds the use, only if the same grant (same grant id, count still decremented) is still stored, so a revoked or replaced grant is never restored. The shared queue prevents two calls from using the same once grant. Timed expiry is checked around credential acquisition and export/transfer. Detected backward-clock movement beyond the one-second tolerance invalidates affected persisted timed grants. Changes while the service is stopped are not reconstructible from wall-clock time alone.

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

The coordinated updater accepts only a version/integrity identity selected by its independent registry verifier, never a caller-provided local artifact path. Archive inspection bounds compressed/expanded size and rejects links, traversal, Windows special paths, collisions, and unsupported extended metadata. Protected schema compatibility is checked during planning, staging, and immediately before switching. Active/new executable trees receive recursive permission verification; retained transaction roots receive boundary checks without scanning historical runtimes.

Activation waits until authenticated requests are idle. The private detached worker switches programs before requesting old-child exit, then survives as an orphan under the unchanged Windows host. Rollback SCM operations occur only after the old child exits. Owner-only IPC authorization remains unchanged: the SYSTEM worker reads a protected nonce-bound readiness marker rather than obtaining general owner IPC access. Readiness compares the service's immutable boot identity, transaction identity, and a live process. Protected maintenance state blocks credential operations until success or verified rollback; failed recovery remains blocked.

Desktop npm and managed registration repair run only as a non-elevated user. An OS lock serializes desktop mutations. A normal-user checkpoint cannot authorize privileged writes. Desktop recovery verifies fresh signed artifact bytes before restoring a missing receipt. Restart requirements still apply after recovery. Rollback material is retained. Exact native SCM, ACL, and owner-IPC behavior requires separate disposable privileged validation before rollout; ordinary process fixtures do not establish those properties.

Version 3.0.3 verifies npm's ECDSA-SHA256 signature over `name@version:dist.integrity` using the pinned registry key and matching key ID. SHA-512 tarball integrity and a valid signature are both mandatory. Repository-attestation JSON is an additional metadata policy check; it is not cryptographic Sigstore verification and never substitutes for a signature. Empty custom verification keys fail closed. Unknown registry keys require a trusted verifier upgrade. Versions 3.0.0–3.0.2 require the documented trusted reinstall to bootstrap this correction.

## Verification and exclusions

Run the [manual attack checklist](docs/attack-checklist.md) with disposable state before release. Record PASS, FAIL, or UNAVAILABLE independently for each OS. Preserve separate evidence for source tests, CI, actual native execution, installation, and public/package release.

Windows Hello/Touch ID is [research only](docs/superpowers/research/2026-10-29-native-approval.md). V3 does not replace Bitwarden unlock with biometrics, support Linux, or automate general OAuth/passkeys/CAPTCHA challenges.
