# Coordinated update validation — 2026-11-06

## Scope and source

Implementation lives on `feat/coordinated-updates`, based on `6c99131` (the earlier connection-test feature). The original checkout and its unrelated artifacts remain untouched. A tracked-source backup was verified at the original checkout's `#0 backup/before-update-workflow.zip`. No real installed service replacement, registry publication, remote push, or Discord mutation formed part of this validation.

## Automated evidence

The pre-change baseline was 468 tests in 67 files. Targeted suites cover release validation, strict IPC fields, private journal transitions, maintenance admission, staged activation, rollback/source readiness, identity mismatch, duplicate transactions, read-only plans, desktop-only updates, partial desktop failure, target drift, and checkpoint recovery. TypeScript and production build are checked separately from tests. Final command results and counts are recorded in the implementation handoff.

Final source checks passed: `npm test` — 492 tests in 76 files, `npx tsc --noEmit`, `npm run build`, and `git diff --check`. A separate affected-suite rerun passed 15 tests after the final review fixes. These are local results; no CI result is claimed.

An actual `npm pack --ignore-scripts` archive was accepted by the conservative inspector: version `5.1.0`, 103 files. This establishes compatibility with the current npm archive layout; it does not establish registry signatures or validate a future release.

## Native Windows process fixture

`node test/native/update-process-fixture.mjs` passed on Windows with Node `v24.19.0`. It used temporary programs and the production transaction/journal code, plus fixture-only process adapters. Both scenarios observed old-parent exit, detached-worker survival, a live boot process acknowledging its expected identity, terminal status, and worker termination checked twice:

| Scenario | Terminal phase | Program after completion | Metadata |
| --- | --- | --- | --- |
| Target starts | `service_ready` | target | preserved |
| Target fails, source starts | `rolled_back` | source | preserved |

Temporary fixture directories and recovery copies were retained. The fixture does not call SCM, install a Windows service, validate SYSTEM ACL inheritance, or traverse authenticated production owner IPC. Those privileged properties remain **unverified for this implementation** and require a disposable service fixture before installed rollout. The test driver exposes no production trust override or caller artifact endpoint.

The built CLI's `update --check` against the existing installed service safely returned `coordinated updater bootstrap required; install the matching trusted service first`. It dispatched no legacy update or desktop install. This is expected: the installed service lacks the new capability. No token or vault credential was fetched for readiness testing.

## Independent security review

A separate read-only reviewer examined the whole change. Three initial findings were corrected:

1. Restore protected-schema checks during planning/staging and immediately before switching.
2. Recover successful npm installations with missing receipts from a bounded matching checkpoint, a retained rollback package, and independently reverified exact artifact bytes.
3. Check protected journal boundaries without recursively scanning retained runtimes on startup.

A follow-up finding was corrected: recovered desktop installations still repair recognized registrations and report session restart and retained rollback material. Regressions exercise the schema refusal and recovery ordering/flags. Production worker polling uses monotonic deadlines and requires the same live readiness PID in consecutive observations.

The reviewer rechecked the corrections and reported all findings closed, with no remaining concrete blockers from static review. This does not close the privileged native validation gaps above.

## Implementation rulings

- Maintenance admission wraps authenticated IPC dispatch, covering unlock, management, and grant work without introducing separate active-state counters in each subsystem.
- The activation hook runs after the socket write completes, or after a disconnected caller's accepted request is dispatched. The prior begin response already supplies the reconnectable job ID; response delivery is not a claim that activation completed.
- Duplicate desktop processes report busy under an OS lock. Protected service transactions attach by identity and survive client interruption.
- Legacy `ServiceUpdater` remains as historical/tested code, but service production wiring refuses its unsafe one-component update path.
- macOS planning remains read-only. Coordinated application fails explicitly on unsupported platforms.
- No version bump, npm publication, CI run, real installed upgrade, or live Discord check was performed for this change.
