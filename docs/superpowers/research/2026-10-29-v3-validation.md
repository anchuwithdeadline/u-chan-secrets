# V3 local validation and release boundary

Date: 2026-10-29. Branch: feat/v3-usability. No package publication, live installation, deployment, or push was performed.

## Verified locally

- Baseline before implementation: 309 tests passed; TypeScript build passed.
- Regression suites exercise real JSON storage, actual IPC connections, Playwright fixture pages, grant concurrency/reservation/restart/expiry, clock rollback, protected migration logic, management routing, pagination, and updater dependency preservation.
- Windows C# helpers compile through PowerShell Add-Type.
- An ordinary-user launch of the compiled production helper was denied with zero stdout bytes. This tests the identity guard, not privileged-session interaction.
- Windows management layout was inspected using an offscreen native preview with dummy values. Selected-domain metadata was checked separately because DrawToBitmap does not render the combo-box text reliably.
- Read-only doctor was executed against this machine. It reported a registered but unreachable service and unavailable dedicated Chrome. These failures were reported, not repaired.
- No actual vault credentials were needed for these checks.

Final local verification: **352 tests passed across 46 test files; TypeScript build passed; git diff --check passed.** Packaging dry run contained 64 expected files and no unexpected paths. No CI run or publication is claimed.

## Pending platform checks

- Actual installed Windows SYSTEM/session/desktop isolation, keyboard hooks, synthetic input, per-prompt pipe ACLs, permission inheritance, native dependency search paths, and desktop restoration.
- A trusted elevated install/reinstall/update rehearsal with disposable state.
- macOS daemon ownership, secure-input behavior, management visual review, private executable/native library ownership, and equivalent adversarial checks.
- Biometric hardware proof of concept. Only documentation research is complete.

These checks are release prerequisites. Unit tests and compilation do not establish them.

## Implementation choices

- Single service queue serializes grant operations. Revocation does not cancel an earlier login.
- Generic form completion remains an internal heuristic; the isolated runner returns unconfirmed unless an approved success condition passes.
- Playwright sharing is advisory when the current process tree cannot identify an AI client.
- A backward-clock change greater than the one-second tolerance invalidates affected persisted timed grants; newly approved grants remain possible.
- Management shows 20 domains per page to bound native transport size.
- Initial V3 and dependency/native-helper upgrades require trusted administrator installation. Package-only updates preserve existing private dependencies.
- Protected state migration is isolated in `src/service/state.ts`.
- Integration timeout is 15 seconds because a fresh-TOTP wait and a rejected-form wait can exceed five seconds together.
- Native runtime evidence is retained in local scratch space. It is not a claim of privileged-service verification.

## Independent review and fixes

The independent read-only review of the initial candidate found four Important issues and no Critical or Minor issues. Regression checks reproduced each issue before its fix:

1. Windows ownership/DACL protection accepted user-owned/readable state. Protection now replaces ownership and DACLs for the protected tree, rejects reparse points, and checks descendants. A real Windows ACL fixture now fails closed.
2. Windows reinstall did not stop/reuse the existing service. It now waits through pending shutdown, stages fresh program files, preserves the prior program in protected backup, and reuses registration.
3. Login cancellation did not cover preflight/initialization/transfer. A shared deadline now propagates to vault subprocesses and owned browser/CDP operations. A real CDP cancellation test confirms shared Chrome remains running.
4. A success selector could match after navigation to an unapproved host. Host checks now run after initial form detection and around success evaluation/export/transfer.

The fixes are verified by regressions and the final suite, not by a second independent review. Actual installed-service and macOS checks above remain pending.

An additional diagnostic regression now makes a known Playwright browser-sharing mismatch fail doctor, while unobservable sharing remains advisory.

## Rulings and tradeoffs

- Native runtime isolation remains a release gate. Cost if assumptions are wrong: a platform could fail or be unsafe until verified.
- Unknown Playwright sharing remains advisory; known mismatch fails. Cost: the user still checks sharing inside the actual AI session.
- Form completion stays an internal heuristic, with unconfirmed service results unless approved evidence matches. Cost: legacy flows may require inspecting Chrome.
- Migration logic uses a focused `service/state.ts` module. Cost: one additional module to maintain.
- Clock rollback uses a one-second tolerance and persists invalidation. Cost: clock adjustment can require renewed approvals.
- Windows cross-session replies use a SYSTEM-only named pipe instead of unsupported handle inheritance. Cost: a transport problem denies the prompt.
- Management uses 20 grants per page. Cost: more navigation for large allowlists.
- Private runtime/browser staging and upgrades that change native helpers or dependencies require trusted administrator setup. Cost: some upgrades need an administrator step.
- Integration timeout is 15 seconds. Cost: genuinely stuck tests can take longer to fail.
- The managed worktree and local scratch evidence are preserved. Cost: additional disk use; no bulk deletion was performed.

No Minor findings were deferred. The original checkout remains on main; implementation is committed separately on feat/v3-usability.
