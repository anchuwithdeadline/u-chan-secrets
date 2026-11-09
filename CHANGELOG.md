# Changelog

## 5.1.2

**Upgrade:** `u-chan update` from 5.1.0 or 5.1.1. This release is published without provenance so services that predate the fix can verify it by registry signature; later releases carry provenance again.

- Read the repository from the DSSE payload of npm trusted-publishing attestations. The update verifier previously rejected every provenance-bearing release with `provenance repository mismatch`, which is why `u-chan update` reported `update_check_failed` for 5.1.1.

## 5.1.1

**Upgrade:** `u-chan update` from 5.1.0 (no reinstall: native helpers and dependencies unchanged). The service restart relocks the vault this one time; later updates keep it unlocked.

- A coordinated update no longer relocks an unlocked vault. The old service hands its session to the new boot through a one-shot file in the admin-only transaction directory (expires after two minutes, deleted on read, adopted only inside that transaction). Reinstall, reboot, crash, idle timeout, and explicit lock behave as before. The update to this version still relocks once, because the installed service predates the handoff.
- `u-chan start` checks for a published update and applies it when it is compatible; one that needs a trusted reinstall is reported and skipped.
- `u-chan setup --apply --replace-existing` now replaces Codex and Claude Code registrations that still carry the V1 `U_CHAN_BW` desktop environment, which the thin client ignores, instead of reporting them as custom (`manual`). Its value is never reported.
- Resolve a Bitwarden item by exact name when `bw` search matches several.
- Sync Bitwarden before reading login credentials, so recently edited items are current.
- Wait for page scripts before filling a login form, and keep the real failure reason.
- Find the CDP port owner when Windows omits the listener; accept quoted `--cdp-endpoint` arguments in the Playwright check.
- Add a tag-triggered release workflow that tests on Windows/macOS and publishes to npm with provenance (trusted publishing or `NPM_TOKEN`).

## 5.1.0

**Upgrade:** 5.1.0 changes native helpers (unlock dialog, Discord review surface), so upgrading from 5.0.x requires a trusted administrator reinstall; `u-chan update` alone is not enough. Protocol 3, website state schema 3, runtime dependencies, and existing grants are unchanged.

### Setup and daily use

- Add `u-chan setup --client claude`: inspect Claude Code user-scope `u-chan-secrets` and `playwright` registrations read-only, and apply missing or simple replacements (including a Playwright entry without `--cdp-endpoint`) through the official `claude mcp` CLI after backing up `.claude.json`. Custom registrations and conflicting target environment are preserved.
- Add `u-chan start` (Windows): start the selected dedicated browser when its endpoint is down, open the protected unlock prompt only for a locked vault, then print doctor.
- Point the doctor Playwright hint at the setup command.
- `u-chan setup` without `--client` now detects Codex and Claude Code CLIs on PATH and inspects/configures each one, instead of assuming Codex. Add `--client all`. Per-client results appear in text and `--json` (`clients`) output; the overall client state is the least ready one, and a failure in one client does not skip the other. Explicit `--client codex|claude` is unchanged.

### Agent unlock and GitHub

- Add `request_unlock` through MCP and authenticated IPC, reusing the native prompt, shared unlock attempt, failed-password limiter, and a cooldown after prompt dismissal.
- Add repository-bound GitHub connections with bounded metadata, issue/PR, and CI-status reads, plus individually approved issue and draft-PR creation.
- Keep credentials inside the service; pin the API origin, refuse redirects and arbitrary routes, preserve uncertain write outcomes, and recheck authorization generation before dispatch.
- Add GitHub CLI setup/read/create/revoke commands. Source support requires a matching service upgrade; no live enrollment or rollout is implied.

### Unlock prompt

- Skip the master-password prompt when the service vault is already unlocked, and share concurrent unlock requests as one attempt.
- Prevent a pending unlock from reopening the vault after an explicit lock. Existing approval and failed-password limits remain in place.
- Replace the oversized Windows password dialog with a compact, DPI-aware layout, visible verification phrase, masked field, action-specific button, and keyboard controls. Long approval context remains scrollable.
- This changes the native helper and requires a trusted service reinstall; no installed rollout is implied by the source change.

### Coordinated updates

- Add read-only `u-chan update --check` and coordinated Windows desktop/service updates with capability-gated trusted bootstrap.
- Stage independently verified signed artifacts, report phase/elapsed time, reconnect through protected jobs, and verify immutable target boot readiness.
- Retain recovery programs and desktop packages; restore and verify the source service after target startup failure.
- Preserve owner IPC authorization and normal-user npm boundaries. Block incompatible schema/runtime/helper/dependency changes before activation.
- Recover completed desktop installations with missing receipts only after exact artifact verification; repair recognized launchers and report AI-session restart requirements.
- Avoid recursive permission scans of retained update runtimes. macOS application and installed rollout remain separate work.

### Discord broker

- Add `u-chan discord test <alias>` and `discord_test_connection`: reuse approved read-only metadata inspection to report connection status, server ID, and channel/role counts without raw metadata. No service, native-helper, permission, or dependency change is required.
- Allow Discord setup discovery from the user-supplied Bitwarden item when server/field metadata is already stored there. Require protected approval before lookup and another approval before saving the exact UUID-bound connection; never return token values or raw notes.
- Add a Windows-only privileged Discord token broker for approved existing servers: metadata inspection, channel/category and role setup, reordering, and member-role assignment.
- Keep Bitwarden token retrieval inside the service; require protected approval of every exact write batch. Reject administrator grants, unmanaged endpoints, and out-of-server targets. Add separate protected connection state, audit events, CLI/MCP tools, management revocation, and diagnostics.
- Replace clipped Windows approval details with a wrapped, read-only scrolling review surface. Native helper changes require trusted administrator reinstall; no package publication or installed/native Discord verification is implied.
- Preserve website-login APIs, protocol 3, website state schema 3, and runtime dependencies. Clarify a pre-existing setup-test fixture return type so whole-project type checking can pass.

## 5.0.1

- Resolve the installed Windows owner's shell-folder paths from raw registry values before expanding `%USERPROFILE%`. SYSTEM now verifies the owner's dedicated Edge/Chrome profile instead of its own profile.
- Include both browser policy scripts in Windows service installations and check their presence in service diagnostics.
- Make `setup --apply` retain the recognized npm PowerShell launcher in `#0 backup` so the short `u-chan` command resolves to `u-chan.cmd` under restrictive PowerShell execution policies. Preserve custom launchers and leave execution policy and shell profiles unchanged.
- Keep protocol 3, protected-state schema 3, native helpers, dependencies, and existing grants unchanged. Site-specific login success conditions still require local protected approval.
- Pin native-helper template line endings so unchanged helper bytes remain compatible with signed package-only updates across checkout platforms.

## 5.0.0

- Add per-user Chrome/Edge selection, defaulting to Chrome, with separate dedicated profiles, configuration backups, explicit apply, and matching Codex MCP environment.
- Validate the listening browser executable, desktop owner, dedicated profile, and loopback endpoint before reuse. The privileged service repeats owner/profile checks and reconnects between operations to avoid stale browser destinations.
- Require approved login evidence in both the isolated context and the transferred desktop session. Wait for delayed evidence; report unconfirmed/partial state honestly without modifying existing tabs or rolling back unrelated cookies.
- Block unapproved private-browser requests, redirects, and WebSockets; disable private service workers. Keep credentials private and do not expand approved hosts silently.
- Enforce redirect destinations with a per-attempt private HTTP/CONNECT proxy and request-stage CDP checks on owned desktop tabs. Retain TLS validation; private HTTP/2/QUIC are disabled. Close owned tabs before disconnecting on cancellation and parse native command lines with Windows tokenization.
- Return explicit human-action outcomes for recognized CAPTCHA/passkey/push challenges and missing/rejected TOTP. Preserve one-attempt semantics and avoid automatic credential retries.
- Require V5 verified-transfer capability before a V5 client sends login; retain protocol 3, state schema 3, existing grants, native helpers, and runtime dependencies.
- Source, artifact publication, installed verification, per-browser Windows fixtures, and macOS native verification remain separate claims.
- Publish 5.0.0 under npm `latest` and `next` with verified registry signature/integrity and a matching GitHub artifact. Verify installed Windows service/CLI bytes, disposable SYSTEM Chrome/Edge matrices, and explicit local Edge setup; keep macOS native runtime unverified.

## 4.0.1

- Allow up to 60 seconds for the full Windows protected-tree permission scan, with 65-second service and 70-second client deadlines. Growing protected backups could make the previous 15-second scan timeout return `unknown` despite safe ACLs. All paths remain checked; errors, unsafe permissions, and timeouts retain their existing results.

## 4.0.0

- Add read-only guided setup for Windows/Codex, with explicit flags for registration changes and dedicated Chrome startup.
- Preserve advanced Codex settings, back up existing configuration before mutation, and retain completed changes on partial failure.
- Refuse elevated setup and unsafe or known mismatched browser targets. Service installation and UAC configuration remain separate trusted operations.
- Compare actual CLI/service versions and browser targets; display installed service version, browser health, and fixed next actions in native management.
- Distinguish observed process configuration from unverified active AI-session ownership.
- Add `u-chan allow` with one-attempt default, explicit timed/permanent policy, and optional login success URL/selector.
- Keep protocol 3, protected-state schema 3, native helpers, and runtime dependencies unchanged. Source integration does not establish publication, installation, or native security verification.
- Verify a state-preserving Windows rollout with matching 4.0.0 service/CLI versions, real Codex registration, fresh MCP/shared-Chrome checks, and a disposable SYSTEM browser/update fixture. Publication and macOS runtime verification remain separate claims.
- Publish 4.0.0 on npm under `latest` and `next`; verify its registry signature and artifact hash, then align all 77 global CLI package files with the public artifact. Required Windows setup diagnostics pass after dedicated Chrome startup; macOS runtime remains unverified.

## 3.0.3

- Correct npm update verification to use the current pinned registry key and ECDSA-SHA256 over `name@version:dist.integrity`.
- Require a valid registry signature even when attestation JSON claims the expected repository. Empty custom public keys fail closed.
- Keep SHA-512 integrity checks mandatory. Repository metadata is not a claim of cryptographic Sigstore verification.
- Versions 3.0.0–3.0.2 need a trusted administrator reinstall to bootstrap the corrected verifier. Native helpers and runtime dependencies are unchanged from 3.0.2.

## 3.0.2

- Run Windows protected dialogs on a clean STA thread. The relay thread could already own CLR/COM windows, causing desktop assignment to fail with Windows error 170 before any prompt appeared.
- Inspect Windows ACL rules as SIDs directly, avoiding repeated account-name translation while retaining explicit and inherited rule checks across the full protected tree.
- Add an administrator-run, no-password native regression probe for actual SYSTEM relay, protected desktop entry, desktop restoration, and reply transport. Evidence remains under protected `#0 backup`; its temporary scheduled task is removed.
- This native-helper change requires a trusted administrator reinstall. Existing owner, settings, and grants remain intact.

## 3.0.1

- Allow a full native permission scan to finish before `doctor` times out. A reachable installed service previously appeared unavailable when the five-second client deadline raced the service reply.
- Keep permission checks bounded: 15 seconds for the Windows probe, 20 seconds for service aggregation, and 25 seconds for diagnostic IPC.
- No grant, authentication, or credential-boundary behavior changed.

## 3.0.0 source changes

This entry describes source integration. It does not announce npm publication, deployment, or completion of native security verification.

### Added

- Read-only `doctor` diagnostics with JSON output and safe next actions.
- Native `manage` window for vault status, paginated grants, sanitized activity, lock/unlock, and revocation.
- One-attempt, timed, and permanent approvals with service capability negotiation.
- User-approved login success URL/selector conditions and fixed safe result codes.
- Protected pre-V3 backup, schema marker, and supported downgrade refusal.

### Changed

- Legacy flows without approved success evidence can transfer filtered session state but return `authentication_unconfirmed` with `ok: false`.
- Once approval counts a failed attempt after reservation; preflight failure does not consume it.
- Expiry/revocation prevent future login authorization, not use of existing Chrome sessions. Revocation waits behind an earlier login.
- Native helpers, runtime, browser assets, ownership/DACL handling, and state-preserving Windows reinstall use the V3 privileged path.
- Compatible package updates retain private dependencies; dependency/native-helper changes require trusted administrator reinstall.

### Fixed

- Concurrent reuse of a once grant and rollback-driven extension of timed approval.
- Authentication confirmation after an unapproved-host redirect.
- Cancellation gaps in preflight, initialization, and CDP transfer.
- Windows service shutdown/registration handling during reinstall.
- Canonical path assumptions and PowerShell Security-module dependencies exposed by hosted CI.

### Verification and migration

- Local verification: 352 tests across 46 files, TypeScript build, native compilation, and package-content dry run.
- Windows/macOS CI and CodeQL passed for implementation commit `92e644c`; later documentation/merge checks have their own runs.
- Actual SYSTEM/root native isolation, elevated installation rehearsals, and native library ownership remain release gates.
- Use the CLI reinstall flow in [README](README.md#upgrade-backup-and-rollback). Do not use the legacy destructive debug installer.
- Windows Hello/Touch ID remains research only. Linux and broader authentication mechanisms are outside this version.
