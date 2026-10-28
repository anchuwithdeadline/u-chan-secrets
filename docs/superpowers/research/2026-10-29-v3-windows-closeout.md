# V3 Windows closeout

Date: 2026-10-29. Candidate: 3.0.3. The user explicitly scoped V3 completion to Windows; macOS runtime verification is unavailable and is not claimed.

## Current status

- The production npm-verifier correction is independent of the new validation utilities. It requires SHA-512 integrity and a valid ECDSA-SHA256 signature using npm's current pinned key/key ID. Empty custom keys and unsigned repository-attestation JSON fail closed.
- Production fix: 356 tests across 47 files and TypeScript build passed; independent review found no remaining Critical/Important issue. Source integration is [PR #7](https://github.com/anchuwithdeadline/u-chan-secrets/pull/7).
- New validation utilities add regression coverage for fresh run IDs, actual pipe access denial, and incomplete module inspection. Their final privileged rerun is **pending Windows UAC consent**. Earlier execution evidence below does not mark the tightened revision passed.
- A final UAC request was cancelled after the sleeping user's attacker fixture timed out. No stale request was intentionally left queued. No test failed approval is interpreted as success.
- npm publication requires physical 2FA when challenged. GitHub publication, npm publication, installed files, and runtime verification are recorded separately.

## Evidence obtained

| Boundary | Observed evidence | Limit |
|---|---|---|
| OS elevation prerequisite | User approved changing UAC from default to Always notify; read-back confirmed it. Previous values remain in administrator-only `#0 backup`. | Administrator/root compromise remains outside the threat model. |
| Protected files | Non-elevated read opens and write-access opens were denied for 11 settings/runtime/program targets. Bitwarden directory listing was denied. | No production file was overwritten or deleted to test this. |
| Raw IPC policy tampering | Ten malformed grant/success requests returned `bad request`. Grant listing matched its baseline afterward. | This does not authorize any new domain. |
| Prompt identity/desktop | Disposable actual SYSTEM helper ran in interactive session 1 and on a separate desktop. Timeout and forced failure restored the original desktop. | Fixture uses confirm-only dummy text; no vault password is involved. |
| Input/capture isolation | User-side hook and image-capture positive controls succeeded. A SYSTEM F24 canary reached the protected form; ordinary-user hook observed zero canary events. SendInput returned zero; direct button message failed; neither PrintWindow nor screen capture saw the marker. | Representative Windows APIs on this host, not proof against all malware or drivers. |
| Prompt reply pipe | Runtime DACL contained SYSTEM allow rules only. Connection/spoof attempts failed. | Original connection failure was timeout code 121, not an access-denied result. Tightened utility adds an idle SYSTEM-only pipe and requires genuine access denial; rerun pending. |
| Private execution | Actual service Node had 39 observed modules under Windows/protected service storage. SYSTEM browser/Bitwarden fixture observed 182 modules across 11 processes, with no uninspected process in that run. Two Defender DLLs were accepted only after Microsoft signature and ACL checks. | Tightened utility additionally checks trusted ownership, full path boundaries and live unreadable processes; rerun pending. Dynamic observation is not every possible future lazy-loaded library. |
| Browser credential separation | Random fixture credentials existed only in SYSTEM memory. Confirmed isolated fixture login succeeded; user-Chrome input listener positive control worked and then observed zero credential-entry events. Filtered session transfer produced the signed-in fixture page. | Loopback HTTP is a disposable fixture with an explicit fixture-only host check. Production approval still requires HTTPS. |
| Once/timed grants | SYSTEM fixture exercised actual service/store classes: one of two concurrent once attempts succeeded, replay after reopening the store was exhausted, and backward-clock invalidation persisted to protected JSON. | Injected fixture clocks; the machine clock was not changed. Changes while stopped remain unreconstructible. |
| Update authentication | Original verifier rejected real npm 3.0.2 and accepted forged unsigned attestation metadata. Corrected verifier accepted the actual 65,072-byte registry tarball. Signed disposable update preserved private dependencies/settings and requested one restart. | Versions 3.0.0–3.0.2 need trusted administrator reinstall to bootstrap the fix. Registry-key rotation fails closed. |
| Test-secret leakage | Generated fixture username/password had zero matches in two service-log/audit artifacts. Fixtures emit only counts and safe result flags. | No local transcript files changed in the selected transcript directory during that run; no full transcript-history sweep or real-password search is claimed. |
| Actual use | Earlier protected unlock succeeded; user-authorized Moji Admin login transferred state. Independent reload showed the signed-in admin UI. Existing grant stayed unchanged. | Legacy grant returned `authentication_unconfirmed`, correctly; UI observation is separate evidence. |

## Review corrections to the utilities

The first utility revision was not accepted as a final merge candidate. Review identified privileged output following user-writable paths, stale result reuse, incomplete module-audit acceptance, and overly broad interpretation of pipe errors.

The tightened revision uses a fresh UUID and a read-public channel under `C:\ProgramData\UChanSecurityChecks`. Its owner, reparse state, write/DACL/owner/delete-child rights and parent deletion rights are checked; directories are created with restrictive ACLs and validated afterward. Administrator/SYSTEM never read user result files or write user-selected paths. Only the non-elevated preparer merges its own result with the administrator-owned summary, matching run IDs and successful positive controls. Summary publication is atomic. Reusing a run UUID is refused. Unreadable live runtime processes fail inspection.

These are static-review and regression-tested corrections. Final native execution is still required for the corrected utility revision.

## Reproduce after the user returns

Keep the service vault locked. Use disposable fixtures; do not type a password into them.

1. Non-elevated terminal: `node scripts/verify-windows-user-boundary.mjs`. Expected `ok: true`; grants unchanged.
2. Non-elevated terminal: `node scripts/verify-windows-adversarial.mjs --prepare`. Keep it running. It prints a fresh UUID and the next command.
3. A second, trusted administrator terminal: execute the printed `node scripts/verify-windows-adversarial.mjs --run <UUID>` command. It briefly displays a disposable form. Do not interact with it.
4. Both terminals must finish. Use the final merged non-elevated report, not just the administrator component. Expected `ok: true`, matching run IDs, positive controls, real pipe access denial, zero captured canaries and successful restoration.
5. Trusted administrator terminal: `node scripts/verify-windows-adversarial.mjs --browser`. Expected `ok: true`, complete module inspection, real signature verification and signed-update rehearsal.
6. Repeat a used UUID: it must be refused before another fixture runs. Confirm temporary scheduled tasks exited and were unregistered.
7. Install the final matching package through the trusted administrator path if installed files differ. Run `u-chan doctor --json` and record the actual installed version separately from npm metadata.

Private fixture evidence remains under the service's `#0 backup`; public summaries contain only dummy metadata/counts under `UChanSecurityChecks`. Retain evidence; do not bulk-delete it during closeout.

## V4 dependency

V4 planning/source work can proceed under the user's autonomous-work authorization. Shipping V4 as Windows-verified still requires the final V3 native rerun, matching installed-version verification, and any physical npm 2FA step. macOS, biometrics and cryptographic Sigstore verification remain outside this Windows closeout.
