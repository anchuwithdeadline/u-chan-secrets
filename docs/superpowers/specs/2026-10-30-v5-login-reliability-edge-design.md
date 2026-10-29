# V5: reliable login and selectable desktop browser

Status: proposed design for approval. Date: 2026-10-30.

## Intent and agreed choices

Make everyday login results trustworthy and support Microsoft Edge alongside Chrome. The user selected login reliability as the V5 direction and explicitly requested Edge support. Each installation chooses its own browser. Chrome is the default when no choice exists; this user's Windows installation will explicitly select Edge.

Windows is the verified release target. Retain the existing Node/TypeScript, Playwright, privileged service, CLI, and MCP architecture. These implementation choices are the author's recommendation. macOS native runtime remains unverified.

## Existing behavior to retain

V4 already persists approved login URLs, item labels, selectors, and optional URL/selector success conditions. Reuse those records; V5 must not create a duplicate site-profile store. Existing grants, expiry, reservation/concurrency rules, and one-attempt consumption semantics remain authoritative.

Credentials continue to be retrieved and entered only in the service-owned isolated Chromium browser. The selected desktop browser receives only filtered session state for approved hosts. Edge support concerns the desktop destination, launcher, setup, and diagnostics; it does not replace the isolated credential-entry runtime with the user's browser.

Do not expose passwords, TOTP material, session cookies, localStorage values, raw browser action errors, or page contents through CLI/MCP diagnostics. No automatic credential retries, approval bypass, or return of partial challenge-session state to the AI.

## Selectable Chrome and Edge

Add a persisted user-side browser choice (`chrome` or `edge`) and an explicit setup option, proposed as `u-chan setup --browser edge --apply --start-browser`. A read-only setup invocation never persists a choice. Existing configuration backup and effective-setting preservation apply to browser-selection changes as well as MCP registration changes.

Selection precedence is explicit setup choice for that operation, persisted choice, then Chrome. With `--apply`, persist the explicit choice and register the matching MCP environment through the existing supported Codex setup path. An invocation without `--apply` may inspect the proposed browser and report actions but must not claim its selection was saved. Existing Chrome users retain their configuration and profile. This user's rollout explicitly selects Edge after backup.

Use dedicated, separate `chrome-profile` and `edge-profile` directories. Never attach a default personal browser profile, copy its data, or terminate unrelated browser processes. Retain one active U-Chan desktop destination and the existing configured loopback CDP origin rather than adding simultaneous browser destinations or separate grant stores. Browser selection does not silently change the service endpoint or choose another port. Custom endpoints continue to require desktop/service agreement.

Refactor the existing Windows launcher into shared browser-selection logic, retaining the existing Chrome entry point as a compatibility wrapper. Locate the selected installed browser from known machine/user installation locations. Do not install a browser automatically, download an executable, or fall back to the other browser silently.

An occupied port is not proof that the selected browser is ready. Validate the listening process, selected browser executable, and dedicated profile using Windows process/listener metadata, together with a working CDP endpoint. Refuse unexpected or unobservable identity/profile bindings. If the endpoint belongs to the other browser, explain that its dedicated instance must be closed before switching. Leave personal Chrome/Edge windows untouched. Do not kill the existing instance automatically. If enterprise policy blocks debugging, report that limitation without weakening policy.

Setup, doctor, management status text, launcher errors, and MCP-facing results must name the actual browser rather than always saying Chrome. Keep the five existing public MCP tools. Report the configured browser and observed destination separately; do not turn process discovery into a claim about active AI-session ownership. CLI structured output may add fields without silently repurposing existing fields. Any renamed legacy result codes need explicit compatibility handling rather than accidental removal.

## Trustworthy login results

Use one bounded success-condition evaluator for the isolated login and the transferred destination session. It supports the existing approved exact HTTPS URL or visible selector. Wait for the condition within the existing overall login deadline; do not decide from one immediate snapshot. Reject unapproved hosts before navigation, during redirects, and before session collection/transfer. Do not extend the overall deadline for every stage.

Host-enforcement choice by the author: while credentials are present in the private isolated context, enforce approved hosts on every outbound HTTP request, including document navigation, redirects, form submission, fetch/XHR, frames, and subresources. Disable service workers in that disposable context and block unapproved WebSocket connections; do not rely solely on the visible page URL. Normal local bootstrap pages may exist, but only approved HTTPS hosts may receive network traffic; approved WSS hosts may be used for WebSockets. Do not silently broaden `entry.hosts`. External identity providers or third-party resources that cannot work inside that existing approved-host set may cause an unsupported-form outcome; report this honestly rather than weakening the boundary. A broader external-host approval model is outside V5. This may reduce compatibility with some sites and must be covered by fixture tests.

An absent login form is insufficient proof of authentication. With an approved success condition, verify it in the isolated context before collecting session state. Then transfer filtered state to the selected desktop browser and independently verify the same approved condition there. For an exact-URL condition, verify by visiting that approved URL and observing its final URL; for a selector condition, visit the approved final isolated URL and wait for the selector. The expected condition is user-approved evidence, not a universal guarantee that arbitrary page content proves identity.

Use a newly created verification tab owned by the login operation. Do not navigate, read, or close pre-existing user tabs. For this desktop verification tab, constrain top-level navigation and redirects to approved HTTPS hosts; ordinary subresources retain the desktop site's behavior. No vault credentials or private challenge state enter that tab. Do not install context-wide routes or modify service workers in the existing desktop context. Close only the operation's verification tab on completion/cancellation. Never return its page text, screenshot, HTML, or selector contents to the AI.

Return `logged_in` only when both verifications succeed. A private-context success followed by a missing/failed desktop condition is unconfirmed, with a fixed safe reason explaining that transferred state did not establish a verified login. Do not claim the transferred session was removed or logged out. Do not delete pre-existing target cookies or attempt rollback that could damage a user's existing session. Filtered state may already exist after a transfer or partial failure, and the result must state that accurately.

Without an approved success condition, preserve the ability to use an existing grant but return an unconfirmed result. Do not silently invent a condition from AI-generated page analysis, change a saved grant, or return success because form fields disappeared. Adding/changing approval-bearing site details or success conditions uses the existing protected approval flow. Reusing a permanent/timed grant must not ask for redundant approval unless its details change.

## Clear failures and manual action

Use stable result codes and fixed public messages to distinguish unavailable browser, locked vault, expired/exhausted grant, unsupported form, human challenge, rejected success condition, transfer failure, unconfirmed destination session, and cancellation/timeout. Determine these outcomes from explicit states rather than substring matching in English error messages. Preserve safe audit redaction.

When CAPTCHA, passkey, push approval, or missing/rejected TOTP prevents automatic login, stop without repeated credential submissions. Return a precise `needs_human` outcome and a safe next action. The initial V5 scope provides manual sign-in guidance in the selected dedicated desktop browser; it does not expose or resume the private credential-entry context. Do not transfer its partial challenge state. The user may complete a separate manual login without AI observation of password/code entry. A seamless protected challenge-resume interface would require a separate security design and is outside this release.

Do not add credential retries. A failed, cancelled, or human-required attempt does not refund a consumed once grant. Repairing/starting the selected browser during preflight happens before credentials are fetched and before an attempt is reserved, following the current grant ordering.

## Boundaries and implementation choices

Keep existing grants and vault data compatible. Add only the minimum configuration/capability fields needed for browser choice and honest result reporting. Preserve existing five-tool names and service authorization boundaries. The builder determines whether additive fields can retain the current protocol; any incompatible wire/schema change must be explicit and covered by old/new client mismatch tests. New runtime dependencies and a new GUI/dashboard are unnecessary.

This release does not add Firefox/Safari, multiple simultaneous browser destinations, multi-account grant redesign, unattended CAPTCHA solving, automatic Mac support claims, browser installation, or automatic invalidation of sessions already transferred into the desktop browser. Fixes to unrelated updater acknowledgement behavior remain separate from this feature design.

## Acceptance and release evidence

- Chrome is the default with no saved/explicit choice. Each user's saved choice is independent. Explicit Edge selection persists only with apply and survives restart; omission on later runs does not reset it.
- Existing Chrome launch/configuration entry points remain functional. An existing default personal Chrome/Edge instance is never reused as the dedicated target.
- Real Windows disposable fixtures cover Chrome and Edge independently: launch, process/profile/endpoint validation, protected login, filtered transfer, desktop success verification, and fresh Playwright MCP connection to the selected destination. Never infer Edge runtime success solely from Chrome fixtures.
- Cover unavailable browser, enterprise/debugging refusal, wrong browser on occupied port, mismatched profile, unknown ownership, non-loopback target, desktop/service endpoint mismatch, and interrupted browser switching. Refusal leaves existing profiles and unrelated settings intact.
- Login fixtures cover delayed success, absent form with no success evidence, rejected credentials, delayed SPA rendering, approved redirect, unapproved navigation, challenge/manual action, private-success/desktop-failure, partial transfer, timeout/cancellation, no secret leakage, no extra submissions, and once-grant concurrency/consumption.
- Configuration tests verify exact precedence, backup-before-write, semantic preservation of unrelated client settings, read-only behavior, explicit selection persistence, and compatibility of existing grants. Verify result-code compatibility and fail-closed client/service mismatches.
- Run scoped tests, the existing suite, build/type checks, independent review, and Windows/macOS CI before merge. macOS CI remains separate from native runtime verification.
- Publish/verify the exact npm/GitHub artifact separately from source merge. Back up protected state and user configuration before installing; compare protected data before/after. On this host select Edge explicitly, verify matching CLI/service versions, required diagnostics, real setup, and fresh MCP/browser behavior. Report any required restart and unverified current-session ownership honestly.

## References

- Microsoft documents Edge remote debugging with a dedicated user-data directory: https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/
- Playwright supports Chrome/Edge channels and Chromium CDP connections: https://playwright.dev/docs/browsers and https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
