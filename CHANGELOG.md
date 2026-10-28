# Changelog

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
