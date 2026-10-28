# V3 local validation and release boundary

Date: 2026-10-29. Branch: feat/v3-usability. No package publication, live installation, deployment, or push was performed.

## Verified locally

- Baseline before implementation: 309 tests passed; TypeScript build passed.
- Regression suites exercise real JSON storage, actual IPC connections, Playwright fixture pages, grant concurrency/reservation/restart/expiry, clock rollback, protected migration logic, management routing, pagination, and updater dependency preservation.
- Windows C# helpers compile through PowerShell Add-Type.
- Windows management layout was inspected using an offscreen native preview with dummy values. Selected-domain metadata was checked separately because DrawToBitmap does not render the combo-box text reliably.
- Read-only doctor was executed against this machine. It reported a registered but unreachable service and unavailable dedicated Chrome. These failures were reported, not repaired.
- No actual vault credentials were needed for these checks.

The final test count and branch review outcome are recorded at completion below; earlier intermediate runs are not release proof.

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
