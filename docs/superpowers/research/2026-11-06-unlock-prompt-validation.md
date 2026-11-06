# Unlock prompt improvement validation

The approved scope addresses repeated U-Chan master-password prompts and the native Windows password dialog. Windows UAC, per-action approval requirements, and master-password storage policy are unchanged.

## Behavior

`ControlService.unlock` first observes vault state. An unlocked vault returns `already unlocked` without requesting a password; a locked vault still requires the protected prompt. Concurrent unlock requests share one in-flight attempt, including cancellation or failure, so a rejected password counts once. A later invocation can retry normally. An explicit lock invalidates pending unlock work; if Bitwarden was already unlocking, the service locks again before returning a cancellation result. No password or session is persisted for update recovery. Service restart still clears the in-memory unlock.

The Windows password dialog uses a compact native layout with an action heading, full verification phrase, masked password field, action-specific submit button, cancel button, and countdown. Empty passwords cannot submit. Enter and Escape retain their native meanings. Long verification phrases wrap; long action context remains available through scrolling. Non-password approval and management surfaces retain their existing behavior.

## Evidence

- New regression tests failed against the original behavior, then passed after the control-layer fix.
- Full local suite: 497 tests passed in 76 files. Production build and whole-project TypeScript passed. Diff whitespace check passed.
- Native C# compilation passed through the existing compiler tests.
- `node test/native/prompt-layout-fixture.mjs` renders the actual password-dialog method with fake values under the desktop user. Normal, long-context/phrase, and simulated 150% layouts pass containment and label-clipping checks. The fixture checks masking, initial input focus, empty/nonempty submit state, and cancel behavior. Rendered images were visually inspected.
- Simulated scaling is not a claim of physical multi-monitor DPI verification. The rendering fixture does not run the SYSTEM entry point, switch protected desktops, access Bitwarden, or read any real password.

Protected-desktop and SYSTEM routing code was not modified. Installed-service isolation remains a separate native validation step. No deployment, npm publication, push, or installed-service restart was performed for this change. The changed helper requires a trusted reinstall before users see the new dialog.

Source backup: `#0 backup/before-unlock-prompt-ux.zip`. Temporary render fixtures and recovery artifacts were retained.
