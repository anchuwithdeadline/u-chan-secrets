# V4 development validation

Date: 2026-10-29. Scope: Windows desktop guided setup, installed-version/browser diagnostics, native management details, and protected CLI grant proposals. This report does not announce a published or installed V4 release.

## Source verification

- Baseline: 356 tests across 47 files and TypeScript build passed before V4 implementation.
- Initial implementation passed 380 tests across 51 files. After merging the verified V3 closeout, the integrated suite passed 382 tests across 52 files. Production TypeScript build and whole-project `tsc --noEmit` passed with source version 4.0.0; the imported JavaScript fixture policy now has an explicit type declaration.
- Tests cover exact service/client versions, missing/invalid metadata, browser-target values, UAC failure, advanced Codex configuration preservation, original-byte backups, redirected backup refusal, partial changes, elevated refusal, setup flags/states, and grant policy/success-condition parsing.
- Protocol 3, protected-state schema 3, native helpers, and dependency ranges remain unchanged.

## Real read-only host check

`node dist/cli.js setup --json` ran from the development worktree without apply/start flags. It returned exit 1 and `needs_attention`, with `changed: false`.

Service registration, authenticated IPC, protected assets/permissions, locked-vault state, desktop Chrome, and Always-notify UAC passed. The existing V3 service does not supply V4 version/browser metadata, so those required findings remained unknown. Codex registration differed from the unreleased worktree's desired entry path and remained unchanged. Process-level sharing was unobservable and reported as such.

No development registration was applied to the user's active client. No V4 service reinstall, protected vault unlock, real grant creation, or browser-session mutation was performed by this check.

A repeated read-only host check compared SHA-256 before and after: the active Codex configuration bytes remained unchanged.

## Official CLI and launcher rehearsal

A real official Codex CLI rehearsal used a disposable config directory, never the active user's configuration. Inspection reported missing; explicit application saved both registrations; a repeat inspection reported ready without changes. Backup bytes matched the original file. Codex can prepend warnings to a missing-registration error, so the implementation recognizes the exact final error line while keeping raw stderr private.

The packaged Chrome launcher parsed and exited successfully against the existing healthy endpoint; no new browser was started by that first check. This host blocks unsigned PowerShell files under its normal execution policy. Explicit setup startup therefore uses a process-local execution policy for the packaged launcher, without changing machine policy or elevating.

A separate native Chrome rehearsal then used a fresh disposable user profile and its own ephemeral loopback port. It started without an initial page, opened an `about:blank` fixture tab through CDP, and kept the endpoint alive with zero page targets after closing the last tab. The fixture closed its own browser and verified the endpoint stopped. It never connected to the existing shared-browser endpoint or used vault credentials. This validates background persistence on this host; it does not establish installed V4/service security.

## Review and package

Independent review and follow-up review found no remaining material issue at `f0a7270`. Reproducing regressions covered compatible custom settings, conflicting target environment, duplicate CDP flags, normalized non-origin URL input, fixed action IDs, active-ownership caveats, and concurrent browser/permission probe timing. Review also corrected a validation-label error: build-config type checking excludes test types; whole-project checking passed separately after fixture alignment.

The initial pre-closeout worktree produced `u-chan-secrets-4.0.0.tgz`: 68 expected files, 73,172 bytes, zero unexpected package paths. SHA-256: `9392c517e67392fd7d798097870450daec1cfbc06b11257877ce66751660ecdf`. That unpublished artifact predates the merged V3 validation utilities and must be superseded by a fresh package before release.

After integrating V3 closeout and the fixture type declaration, a fresh V4 development package was prepared: 77 files, 85,180 bytes, zero unexpected package paths. SHA-256: `5cf1b23c909e60f31006f62c69de82dbc996c38019cf5b4beb595f630118a6c0`. The earlier package remains in `#0 backup`; this replacement is prepared only, not published or installed.

[Draft PR #9](https://github.com/anchuwithdeadline/u-chan-secrets/pull/9) carries the source, documentation, and live CI checks. Initial macOS CI exposed its system `/var` temporary-path alias in a disposable test fixture; `f204903` canonicalizes that fixture without relaxing production reparse-point checks. This is source-test evidence, not a macOS runtime rehearsal.

At `dbc5a34`, [Windows/macOS source CI](https://github.com/anchuwithdeadline/u-chan-secrets/actions/runs/40775910511) and [CodeQL](https://github.com/anchuwithdeadline/u-chan-secrets/actions/runs/40775905906) passed. The same canonical fixture correction resolved both hosted runners' backup-test failures. Later documentation-only commits have their own live checks on the PR.

## Release boundaries

- V3's tightened native/browser gates and final exact-artifact reinstall passed after the user resumed. The [Windows closeout](2026-10-29-v3-windows-closeout.md) records fresh reports, unchanged protected state, and zero remaining fixture tasks. PR #8 is merged; these inherited prerequisites are satisfied on the documented host.
- npm 3.0.3 is public under both `latest` and `next`; registry signature and exact tarball hash verified. Its GitHub release is stable and the documented host runs the exact reviewed 3.0.3 artifact.
- V4 source merged through PR #9 after independent review, 382 integrated tests, whole-project type checking, and green Windows/macOS source CI plus CodeQL. V4 remains unpublished and uninstalled; matching installed V4/service verification is a separate deployment prerequisite. The active host stays on V3.0.3.
- macOS build/test CI is separate from runtime verification. No Mac runtime was tested.
- Active AI-session browser ownership remains independently unverified by process/configuration heuristics.

Draft PR approval and source CI do not establish native release readiness.
