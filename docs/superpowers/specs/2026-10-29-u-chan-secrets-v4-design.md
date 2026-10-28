# U-Chan Secrets V4: guided Windows setup and reliable status

Status: proposed design under the user's explicit autonomous V4 implementation authorization. Concrete defaults below are assistant decisions, not a claim that the user selected every interface. Work happens in an isolated checkout. V3 native closeout and release authentication remain separate gates.

## Intent

Make daily setup understandable: distinguish the desktop CLI from the installed service, configure the user's Codex connection without handling vault secrets, start shared Chrome when explicitly requested, and explain the next action. Add a small convenience for creating a grant with a meaningful success condition.

The V3 rehearsal exposed the problem: a V3 CLI could coexist with a V2 service; MCP could use another browser; and a successful source build did not establish native runtime health. V4 must report those states instead of guessing from npm metadata.

## Scope and defaults

- Windows first, Node >=24, TypeScript, existing MCP/Playwright/WinForms stack. No new runtime dependency or desktop framework.
- Reuse `u-chan manage` for the native status window. Add version, target-browser status and fixed next steps to its existing details. Do not change C# helpers, dialog identity, input desktop or reply transport.
- Automate Codex stdio registration only. Other AI clients retain manual MCP instructions; macOS runtime remains unverified and setup application is unavailable there.
- Keep protocol 3 and state schema 3. Add optional diagnostic metadata; existing clients and grants remain compatible.
- Keep Bitwarden credentials in protected prompts/service memory. No password/email wizard in the desktop CLI, browser automation or configuration files.
- No biometrics, OAuth/passkey/CAPTCHA automation, cloud dashboard, automatic login startup task, privilege bypass, or cryptographic Sigstore implementation.

## 1. Truthful version and readiness data

Extend `ServiceDiagnostic` with optional `serviceVersion: string`, `browser: DiagnosticState`, and `browserEndpoint: string`. `runService` reads the protected package version; unreadable/invalid metadata is unknown, never a guessed fallback. Its diagnostic closure includes that version and tests the same loopback CDP endpoint used by its session target. Expose only a validated HTTP loopback origin, never URL credentials/query/fragment. Capabilities may add `serviceVersion` without changing protocol 3.

The CLI reads its own package version. `runDoctor` accepts optional `clientVersion`, `clientEndpoint` and elevation-policy probe. When supplied, it adds a required version check: exact valid match passes, a known mismatch fails, missing/invalid service version is unknown. Versions are limited to 64 characters and a semver-shaped value. Add the server-browser check when provided; differing valid service/client origins fail a target check. An available desktop Chrome must not hide an unavailable or different service target.

Process inspection is a configuration heuristic, not proof of active AI-session ownership. When an expected endpoint is supplied, check the actual `--cdp-endpoint VALUE` or `--cdp-endpoint=VALUE`, after loopback-origin validation; any arbitrary endpoint flag is insufficient. Even a matching process flag does not promote setup to active-session verification.

On Windows the real CLI also checks UAC: enabled, secure desktop enabled, and Always notify pass; unsafe settings fail with fixed guidance. It never changes UAC automatically. Keep old injected doctor callers compatible when these optional dependencies are absent.

Management uses the existing diagnostic time budget, shows installed service version and service-browser result, and gives fixed instructions for locked vault, missing assets, bad permissions and unavailable browser. It does not claim knowledge of the active AI client's MCP sharing. Its existing refresh/lock/unlock/revoke actions and pagination remain intact.

## 2. `u-chan setup`

Syntax: `u-chan setup [--client codex] [--apply] [--replace-existing] [--start-browser] [--json]`.

- Default is read-only. `--apply` permits Codex configuration changes. `--replace-existing` requires `--apply` and only permits replacement of a simple managed registration. `--start-browser` separately permits starting dedicated Chrome.
- Never silently elevate. Setup refuses to execute a user-owned client CLI or start user Chrome from an elevated process. Service installation remains the explicit trusted administrator `u-chan install` step, shown as an action when needed.
- Start Chrome only on Windows and only for an HTTP loopback endpoint without user info. Use the existing packaged launcher from the normal user's identity. A running healthy endpoint is left alone. Poll briefly after launch; do not count an open unrelated TCP port as healthy Chrome.
- The launcher may use `--no-startup-window` so closing an initial empty window does not end the background endpoint. MCP can still open user-visible tabs. No service or scheduled logon task is added.
- Run diagnostics again after explicit changes. Return a versioned safe JSON report and a concise text equivalent.

Setup states are `needs_attention` and `configured`. Required failed/unknown installation/version/UAC/browser checks or unusable Codex registration produce `needs_attention`. Correct prerequisites and registration produce `configured`; V4 never claims verified active-session ownership. Include `sharing: 'unobserved'|'mismatch'|'process_configured'` and `restartRequired: boolean` in every report. A known process endpoint mismatch requires attention/restart. Changes require restart. Exit 1 for `needs_attention`, 2 for configured with restart required, otherwise 0. Text always explains that active browser sharing still requires verification inside the actual AI session.

A known service/client target-origin mismatch blocks both configuration application and browser launch until corrected. Do not helpfully configure the wrong browser. No new active-session handshake is invented in this release.

Use fixed action IDs: `install_service`, `update_service`, `start_browser`, `configure_mcp`, `authenticate_vault`, `unlock_vault`, `restart_client`, `repair_permissions`, `review_uac`. Locked vault is a valid installed state; unlocking is an optional next action before login, not a broken installation.

## 3. Conservative Codex configuration

Use the installed official `codex mcp get/add/remove` commands with argument arrays and bounded execution; do not create a TOML parser. Inspect `u_chan_secrets` and `playwright`. Expected U-Chan registration uses the current Node executable and this package's `dist/index.js`. Playwright must share the chosen loopback endpoint.

Keep raw CLI configuration/output internal. It may contain API environment variables. Public reports contain fixed status messages, server names and changed/backup flags only, never raw transport objects, stderr, environment values or arbitrary existing arguments.

Readiness statuses are `ready`, `missing`, `needs_update`, `manual`, `unavailable`. Preserve enabled correct registrations even when they have custom environment/options. Disabled entries, HTTP transports, custom environment/cwd/tool controls/timeouts, unknown non-default settings, or unrecognized launch arguments cannot be overwritten automatically. They produce manual guidance when incompatible. Supported simple registrations are the usual Node U-Chan command or npx Playwright package with the known shared-CDP arguments; command/argument matching must not expose values.

Before the first mutation, copy the existing config to an exclusive timestamp/UUID file under the Codex home's `#0 backup`. Reject a redirected backup directory; preserve its existing contents. Use the actual user's Codex home and do not repurpose global environment variables for testing.

Missing registrations may be added with `--apply`. Simple mismatches require both `--apply --replace-existing`; remove/add only that named server using official CLI commands. Do not replace the whole config or copy environment secrets into command-line flags. If a command fails after a prior server changed, report partial changes and retain the backup; do not roll back the whole file over unrelated concurrent edits. A later retry is safe. Changed registration requires a client restart.

## 4. Small login-confirmation convenience

Syntax: `u-chan allow <domain> --login-url <https-url> --item <label> [--once|--minutes N|--permanent] [--success-url <https-url>|--success-selector <selector>]`.

Default new CLI grants to once. Duration flags are mutually exclusive; timed duration is an integer 1–1440 minutes. Success URL/selector flags are mutually exclusive. Reject repeated/unknown/incomplete options before IPC. URLs must be HTTPS without embedded credentials; selectors must be nonempty and at most 1000 characters. Reuse existing policy validation and service approval. No grant is stored directly by the CLI.

Forward the proposal through `requestAllow`, including the explicit policy. A genuine protected approval still displays domain/item/hosts/duration/success evidence. Do not infer a success condition from generic form disappearance, and do not silently upgrade an existing grant. Exact success URL and selector semantics stay unchanged. With no success condition, the existing unconfirmed behavior remains and the CLI explains that limitation.

## Security and release gates

- No new privilege-bearing IPC action, credential store, native helper or login algorithm.
- Config/browser application refuses elevated callers before running any user-owned client program.
- Version/status text is bounded and sanitized; readiness cannot turn missing evidence into pass.
- Preserve unrelated Codex entries/settings and all existing protected owner/settings/grants.
- Tests use injected executors and temporary config files; never mutate the actual user's config during automated tests.
- Baseline is V3.0.3 verifier correction. [V3 native closeout draft](https://github.com/anchuwithdeadline/u-chan-secrets/pull/8) still needs physical UAC verification. npm publication may require physical 2FA. Do not bypass either.
- Source V4 can be reviewed and tested while those gates wait. Do not claim V4 deployed or Windows-verified until the matching installed service and fresh MCP/browser paths are observed.

## Acceptance

An ordinary user can run setup and see whether the CLI/service versions match, whether the protected runtime and browser are reachable, whether Codex is configured, and which exact step remains. Explicit simple configuration changes are backed up and narrowly applied; complex/custom settings survive. Existing management can show actual service health. A user can propose a once/timed grant and success condition without writing MCP JSON, with approval and credential isolation unchanged.
