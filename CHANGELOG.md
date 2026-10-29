# Changelog

## 4.0.0

- Add read-only guided setup for Windows/Codex, with explicit flags for registration changes and dedicated Chrome startup.
- Preserve advanced Codex settings, back up existing configuration before mutation, and retain completed changes on partial failure.
- Refuse elevated setup and unsafe or known mismatched browser targets. Service installation and UAC configuration remain separate trusted operations.
- Compare actual CLI/service versions and browser targets; display installed service version, browser health, and fixed next actions in native management.
- Distinguish observed process configuration from unverified active AI-session ownership.
- Add `u-chan allow` with one-attempt default, explicit timed/permanent policy, and optional login success URL/selector.
- Keep protocol 3, protected-state schema 3, native helpers, and runtime dependencies unchanged. Source integration does not establish publication, installation, or native security verification.
- Verify a state-preserving Windows rollout with matching 4.0.0 service/CLI versions, real Codex registration, fresh MCP/shared-Chrome checks, and a disposable SYSTEM browser/update fixture. Publication and macOS runtime verification remain separate claims.

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
