# V3 Windows closeout

Date: 2026-10-29. Candidate: 3.0.3. The user explicitly scoped V3 completion to Windows; macOS runtime verification is unavailable and is not claimed.

## Current status

- The production npm-verifier correction is independent of the new validation utilities. It requires SHA-512 integrity and a valid ECDSA-SHA256 signature using npm's current pinned key/key ID. Empty custom keys and unsigned repository-attestation JSON fail closed.
- Production fix: 356 tests across 47 files and TypeScript build passed; independent review found no remaining Critical/Important issue. Source integration is [PR #7](https://github.com/anchuwithdeadline/u-chan-secrets/pull/7).
- The tightened validation utilities passed a fresh Windows privileged/native run after the user returned. The merged non-elevated report confirmed genuine pipe-access denial, successful positive controls, zero captured canaries, and desktop restoration. The separate SYSTEM browser/update run also passed, including complete live-module inspection.
- Final trusted V3.0.3 reinstall passed. All 56 installed compiled files match the reviewed release artifact byte for byte. Settings (including owner SID), grants, and private Bitwarden data stayed unchanged; a fresh protected state backup was retained. No temporary fixture tasks remain.
- An earlier request was cancelled while the user slept; it was never counted as success. The resumed successful runs use new UUIDs and independent reports.
- npm 3.0.3 publication and the `next` tag change completed after browser account approval. Public `latest` and `next` both resolve to 3.0.3. The real registry signature verified, and the public tarball SHA-256 matched `a6f6a8ba8503e46992552b0f9def4365a6cdbbe9872c0e6de314614be1e51e2d`. The installed updater independently returned `already up to date (version 3.0.3)`.
- GitHub v3.0.3 is a stable release. GitHub publication, npm publication, installed files, and runtime verification were verified independently; initial registry metadata lagged the accepted asynchronous publish request before public propagation completed.

## Evidence obtained

| Boundary | Observed evidence | Limit |
|---|---|---|
| OS elevation prerequisite | User approved changing UAC from default to Always notify; read-back confirmed it. Previous values remain in administrator-only `#0 backup`. | Administrator/root compromise remains outside the threat model. |
| Protected files | Non-elevated read opens and write-access opens were denied for 11 settings/runtime/program targets. Bitwarden directory listing was denied. | No production file was overwritten or deleted to test this. |
| Raw IPC policy tampering | Ten malformed grant/success requests returned `bad request`. Grant listing matched its baseline afterward. | This does not authorize any new domain. |
| Prompt identity/desktop | Disposable actual SYSTEM helper ran in interactive session 1 and on a separate desktop. Timeout and forced failure restored the original desktop. | Fixture uses confirm-only dummy text; no vault password is involved. |
| Input/capture isolation | User-side hook and image-capture positive controls succeeded. A SYSTEM F24 canary reached the protected form; ordinary-user hook observed zero canary events. SendInput returned zero; direct button message failed; neither PrintWindow nor screen capture saw the marker. | Representative Windows APIs on this host, not proof against all malware or drivers. |
| Prompt reply pipe | Tightened runtime check confirmed SYSTEM-only DACL, genuine connection access denial on an idle pipe, and failed spoofing. | Earlier timeout code 121 was not accepted as access-denial proof. |
| Private execution | Fresh SYSTEM browser/Bitwarden fixture inspected 158 modules across 12 processes, with zero unreadable live processes, zero exited-before-inspection processes, and zero outside paths. Two Defender DLLs passed Microsoft signature and trusted ownership/ACL checks. | Earlier service observation found 39 Windows/protected modules. Dynamic observation is not every possible future lazy-loaded library. |
| Browser credential separation | Random fixture credentials existed only in SYSTEM memory. Confirmed isolated fixture login succeeded; user-Chrome input listener positive control worked and then observed zero credential-entry events. Filtered session transfer produced the signed-in fixture page. | Loopback HTTP is a disposable fixture with an explicit fixture-only host check. Production approval still requires HTTPS. |
| Once/timed grants | SYSTEM fixture exercised actual service/store classes: one of two concurrent once attempts succeeded, replay after reopening the store was exhausted, and backward-clock invalidation persisted to protected JSON. | Injected fixture clocks; the machine clock was not changed. Changes while stopped remain unreconstructible. |
| Update authentication | Original verifier rejected real npm 3.0.2 and accepted forged unsigned attestation metadata. Corrected verifier accepted the actual 65,072-byte registry tarball. Signed disposable update preserved private dependencies/settings and requested one restart. | Versions 3.0.0–3.0.2 need trusted administrator reinstall to bootstrap the fix. Registry-key rotation fails closed. |
| Test-secret leakage | Generated fixture username/password had zero matches in two service-log/audit artifacts. Fixtures emit only counts and safe result flags. | No local transcript files changed in the selected transcript directory during that run; no full transcript-history sweep or real-password search is claimed. |
| Actual use | Earlier protected unlock succeeded; user-authorized Moji Admin login transferred state. Independent reload showed the signed-in admin UI. Existing grant stayed unchanged. | Legacy grant returned `authentication_unconfirmed`, correctly; UI observation is separate evidence. |

## Review corrections to the utilities

The first utility revision was not accepted as a final merge candidate. Review identified privileged output following user-writable paths, stale result reuse, incomplete module-audit acceptance, and overly broad interpretation of pipe errors.

The tightened revision uses a fresh UUID and a read-public channel under `C:\ProgramData\UChanSecurityChecks`. Its owner, reparse state, write/DACL/owner/delete-child rights and parent deletion rights are checked; directories are created with restrictive ACLs and validated afterward. Administrator/SYSTEM never read user result files or write user-selected paths. Only the non-elevated preparer merges its own result with the administrator-owned summary, matching run IDs and successful positive controls. Summary publication is atomic. Reusing a run UUID is refused. Unreadable live runtime processes fail inspection.

The corrected utility revision now has static review, regression tests, and fresh native execution evidence on this Windows host.

## Resumed closeout receipts

- Native run UUID: `903d500e-02a3-4916-90db-03528e016570`; public merged report `C:\Users\ADMIN\AppData\Local\Temp\u-chan-security-gn9q9n\report.json`. Private evidence: `C:\ProgramData\u-chan-secrets\#0 backup\adversarial-f1cdefb2-6991-4bd4-897f-c08143ccf156`.
- Browser run UUID: `0593e44c-89ac-4671-9aed-48840cfa75b9`; administrator-owned public summary under `C:\ProgramData\UChanSecurityChecks\<UUID>\report.json`. Private evidence: `browser-probe-6e6fee03-c0c5-423b-bacd-e099b1b484ff` under protected `#0 backup`.
- Reinstall receipt UUID: `4d09df04-2b5c-450c-9330-2e016c58e4fa`; summary in the same controlled public root. It confirms reused-run refusal, exact installed artifact matching, unchanged protected state, and zero remaining fixture tasks.
- Two preflights stopped before installation: one found line-ending-only compiled-file differences; the other incorrectly required an `owner.json` file, whereas Windows stores `authorizedSid` inside `settings.json`. The final install used the exact reviewed artifact bytes and the actual Windows schema.
- After restart, the first cold Bitwarden diagnostic was unknown within its bounded probe; a subsequent full doctor report passed every required check with the vault locked. Process-discovery sharing remained advisory unknown. The non-elevated boundary test passed again afterward, with ten malformed IPC requests denied and grants unchanged.
- Fresh SDK-driven MCP checks exposed exactly the five expected U-Chan public tools and reported a locked vault. A separate fresh Playwright MCP process, explicitly configured for `http://127.0.0.1:9222`, successfully listed shared-Chrome tabs. This verifies fresh connection paths; it does not prove that an already-running AI session reloaded its MCP configuration.
- The desktop CLI was installed from public npm 3.0.3 after backing up its prior shims/link metadata. It is now a normal global registry installation rather than a link into the working checkout. Fresh MCP checks passed again using that installed package path. On this host, PowerShell blocks npm's `.ps1` shim; `u-chan.cmd` works without changing machine policy.

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

V4 planning/source work proceeded under the user's autonomous-work authorization and merged after independent review and green Windows/macOS source CI plus CodeQL. V3's tightened native, final reinstall, and package-publication gates are satisfied on this Windows host. V4 still requires its own matching installed-version/MCP verification before a deployment claim. The active installation remains V3.0.3. macOS, biometrics and cryptographic Sigstore verification remain outside this Windows closeout.
