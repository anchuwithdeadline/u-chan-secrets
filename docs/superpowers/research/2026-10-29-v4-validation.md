# V4 development validation

Date: 2026-10-29. Scope: Windows desktop guided setup, installed-version/browser diagnostics, native management details, and protected CLI grant proposals. This report does not announce a published or installed V4 release.

## Source verification

- Baseline: 356 tests across 47 files and TypeScript build passed before V4 implementation.
- Implementation: 377 tests across 51 files passed after Tasks 1–4. TypeScript build passed with source version 4.0.0.
- Tests cover exact service/client versions, missing/invalid metadata, browser-target values, UAC failure, advanced Codex configuration preservation, original-byte backups, redirected backup refusal, partial changes, elevated refusal, setup flags/states, and grant policy/success-condition parsing.
- Protocol 3, protected-state schema 3, native helpers, and dependency ranges remain unchanged.

## Real read-only host check

`node dist/cli.js setup --json` ran from the development worktree without apply/start flags. It returned exit 1 and `needs_attention`, with `changed: false`.

Service registration, authenticated IPC, protected assets/permissions, locked-vault state, desktop Chrome, and Always-notify UAC passed. The existing V3 service does not supply V4 version/browser metadata, so those required findings remained unknown. Codex registration differed from the unreleased worktree's desired entry path and remained unchanged. Process-level sharing was unobservable and reported as such.

No development registration was applied to the user's active client. No V4 service reinstall, protected vault unlock, real grant creation, or browser-session mutation was performed by this check.

## Release boundaries

- V3's tightened native adversarial/browser harness still needs a fresh privileged run with physical UAC consent. Earlier fixture evidence does not satisfy the tightened revision.
- npm 3.0.3 publication requires physical account 2FA; the GitHub prerelease artifact exists separately.
- V4 remains an isolated source branch until review, CI, matching installed-service verification, and inherited Windows security gates pass.
- macOS build/test CI is separate from runtime verification. No Mac runtime was tested.
- Active AI-session browser ownership remains independently unverified by process/configuration heuristics.

Independent review, final package inspection, and CI results are recorded below when available.
