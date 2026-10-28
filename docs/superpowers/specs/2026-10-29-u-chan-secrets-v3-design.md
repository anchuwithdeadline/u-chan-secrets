# U-Chan Secrets V3: easier daily use with temporary approvals

Date: 2026-10-29
Status: approved by the user on 2026-10-29; implemented locally, native release verification pending

## Intent and agreed direction

The user approved everyday usability with a small amount of stricter access control. V3 should make setup, diagnosis, approvals, and recovery easier while preserving V2's separation between the AI's user account and the privileged credential service.

The approved direction includes guided setup and repair, temporary approvals, a trusted control window, clearer login outcomes, and investigation of native approval. The delivery order and detailed defaults below are proposals, not previously approved user decisions.

## Approaches considered

1. Everyday usability: improve the existing service and native helpers. This provides immediate benefit without replacing the trust boundary.
2. Stricter access control: build a broader policy system. This adds policy complexity and does not control sessions already transferred to Chrome.
3. Broader authentication support: add SSO, passkeys, and more human challenges. This expands compatibility work and maintenance substantially.

The user chose approach 1 with temporary approvals from approach 2. Reuse the existing TypeScript service, CLI, MCP tools, protected prompts, and platform helpers. Do not add a web server, application framework, database, or new vault abstraction.

## Goals

- Give a user a safe next action when installation or login fails.
- Let a user approve one login, access for a fixed time, or permanent future logins.
- Make grant state and recent activity accessible without editing privileged files.
- Preserve existing V2 grants and existing MCP tool names.
- Keep all authorization decisions inside the privileged service.

## Non-goals and anti-goals

- No Linux, additional vault providers, general OAuth/SSO/passkey support, or automatic CAPTCHA solving.
- No browser-session proxy or control of actions performed after session transfer.
- No automatic privileged repair, permission weakening, or elevation in response to an AI request.
- No passwords, TOTP material, session cookies, vault keys, raw login-page content, or anti-phishing phrase in diagnostic responses.
- Native approval is an investigation, not a promised replacement for master-password verification.
- An unverified authentication outcome must never be reported as a confirmed successful login.

## Current implementation

`src/core/doctor.ts` checks a Windows process tree for Playwright's CDP flag. `status` adds that check to vault state and approval mode. There is no general doctor CLI.

`AllowEntry` stores a permanent domain grant. `CoreService.requestAllow` asks the protected approver and writes the entry. `AllowlistStore` uses atomic file replacement, but it does not serialize transactions across connections.

The isolated browser exports filtered session state and injects it into Chrome. The login filler sometimes infers success from the absence of form fields; it cannot reliably identify every wrong-password or authenticated page. V3 must report uncertainty explicitly.

The CLI already provides lock, unlock, mode, audit, import, update, and installation commands. Native helpers already provide protected confirmation and password prompts.

## Delivery stages

### Stage 1: guided diagnosis and clear outcomes

Add `u-chan doctor` and `u-chan doctor --json`. Report each check as pass, fail, or unknown with a fixed safe explanation and next action. A locked vault is a distinct state, not evidence of a broken installation.

Check platform support, service registration and reachability, IPC authorization, required service-owned assets and their permissions, Bitwarden authentication state, Chrome/CDP reachability, and browser-sharing configuration when observable. Use bounded timeouts. Never unlock the vault, fetch a credential, perform a login, or modify configuration during diagnosis.

Run desktop-side checks as the user and privileged checks through authenticated IPC. If the service is unreachable, report its checks as unknown; continue independent checks. On macOS, do not reuse the Windows-only process inspection. Report browser-sharing state as unknown if it cannot be established.

Return only fixed labels and allowlisted metadata. Do not return raw process command lines, environment variables, arbitrary subprocess output, or privileged file contents. The JSON report uses a versioned shape and an ordered array of check identifiers, states, messages, and next actions. Exit 0 if all required checks pass, 1 for a required failure, and 2 if required checks remain unknown without a failure.

Have installation show the same diagnostic summary after setup. Provide explicit repair instructions using existing commands; do not add an automatic repair engine.

Introduce optional safe result codes alongside the existing `ok` and `message` fields. Propagate codes through service, IPC, CLI, and MCP text. Keep old response readers functional by retaining the existing fields. Codes distinguish grant missing/expired/exhausted, vault locked/unauthenticated/unavailable, Chrome unavailable, unsupported form, human verification required, authentication unconfirmed, session transfer failed, and internal error.

Only classify rejection as confirmed when a supported flow supplies reliable evidence. Otherwise report authentication unconfirmed and offer a safe next action. Merely lacking a password field is insufficient evidence of success. For existing generic flows, document that form disappearance remains a heuristic; label it unconfirmed unless a protected, user-approved success condition can be evaluated. Add an optional success URL or visible-element condition to the entry and approval display. Validate its host and selector using the same trust rules as other login configuration. Evaluate an approved condition inside the isolated browser before transfer; an unmet configured condition prevents transfer. Never inspect or trust AI-controlled Chrome as proof of authentication.

Legacy entries and new entries without a success condition may still transfer host-filtered session state after the existing generic flow completes. Return `ok: false` with an authentication-unconfirmed code and explain that session state was transferred but sign-in was not confirmed. The user or AI may inspect the resulting site to decide how to proceed; that observation does not become trusted service evidence. No reapproval is required merely to keep a legacy grant usable. A confirmed service result requires an approved condition that passed and a successful transfer. This compatibility behavior is a proposed builder call, not a prior user decision.

### Stage 2: temporary approvals

Extend `request_allow` with an optional grant policy: once, timed, or permanent. Existing callers that omit the policy continue to request permanent approval; the protected prompt must prominently state that duration. New documentation recommends once for one-off work.

For timed requests, accept an integer duration from 1 to 1,440 minutes. Compute and show the absolute expiration in the protected prompt and recheck it after approval. An expired request is not silently extended. The model may propose a duration, but the human approves the exact policy displayed. Changing duration, identity, hosts, selectors, or success conditions always requires a new approval.

Store optional `expiresAt` and `remainingUses` on the existing grant entry. Legacy entries without either field remain permanent. Reject malformed present policy fields; never reinterpret them as permanent. One active grant per normalized domain remains the model.

A once grant permits one attempt, including an attempt that fails after reservation. Preflight failures before reservation, such as a locked vault or unavailable Chrome, do not consume it. After preflight, reserve by atomically decrementing and persisting the use before starting isolated login. A crash after reservation consumes the attempt. This avoids retry and concurrency ambiguity; the prompt explains this behavior.

Serialize all grant operations through one service-owned queue, including request approval/write, imports, reads, revocation, and login execution. This intentionally limits throughput for a local single-user tool and provides a simple linear order across IPC connections. Login has a bounded total execution deadline. A revoke waits for an earlier login to finish; disclose this behavior and do not claim it cancels an active login.

Check timed expiry before reserving an attempt, before acquiring credentials, and immediately before session export/transfer. If expired, abort and discard isolated state. An already-started transfer cannot be recalled. Use wall-clock expiration across restarts and monotonic elapsed time within a running process so detected backward clock changes do not extend timed access; fail closed for affected timed grants and request renewed approval when a rollback is detected. Administrator-controlled clock changes remain outside the threat model.

Lists show permanent, expiration, remaining uses, expired, or exhausted. Keep expired/exhausted entries visible until replacement or revocation. Audit approval policy and safe denial reason without recording credentials. Grant extension requires the existing protected approval mode. macOS remains hardcore only.

Expiration and revocation stop future U-Chan authorization. They do not invalidate cookies or sessions already delivered to Chrome, lock the vault, or log out a website. Show this limitation in the protected approval and management surfaces.

### Stage 3: trusted local control window

Add `u-chan manage`, launched through the service using the existing protected native helper infrastructure. Show vault state, grant duration/state, recent safe audit events, and diagnostic status. Provide lock, unlock, and revoke actions. Do not include an entry editor, secret viewer, or full settings dashboard.

The service supplies the displayed state and revalidates action targets. No user-writable files or UI assertions confer approval. Unlock uses the existing protected password flow; permission reduction remains approval-free. Any future grant extension goes through protected approval.

Use existing platform-native UI facilities. The management surface must not receive the vault session or credentials. Handle close, timeout, and helper failure safely. The anti-phishing phrase remains inside trusted UI and never enters IPC responses to the desktop client. Native layout details are left to the builder; visual review is required before calling this stage complete.

### Separate investigation: native approval

Investigate Windows Hello and Touch ID with a disposable proof of concept only after the main stages. Determine whether approval can be bound to the exact pending action, verified by the privileged service, and protected against user-account automation and replay. Also distinguish approving a grant from obtaining material required to unlock Bitwarden; biometric success alone does not supply the vault password.

No production authentication change or new dependency is authorized by this design's investigation alone. Report platform limits and evidence before proposing a production design. Retain current password verification and modes unless a later design is approved.

## Compatibility, data integrity, and rollout

- Keep the five existing MCP tool names and existing required parameters. Grant and success-condition parameters are optional additions.
- Extend JSON storage without rewriting existing entries solely to add defaults. Back up privileged state to an administrator-owned location before the first V3 state mutation. Never copy secrets to a user-readable project backup.
- V2 services do not enforce V3 grant fields. Detect protocol capabilities before sending V3 policy requests. Refuse temporary grants against an old service.
- Once V3 policy fields have been written, supported V3 installation/update/rollback commands must refuse a downgrade that would let V2 interpret them as permanent. Use an administrator-owned schema marker checked by that tooling. A supported rollback requires restoring the pre-V3 backup and explicit acknowledgement that those old permanent grants return; otherwise keep the service stopped. Historical V2 tooling cannot be made to honor a new marker; deliberate administrator replacement with V2 is outside the threat model and must be documented, not claimed as prevented.
- Ship stages in order. Complete Windows and macOS verification separately. Source tests do not prove native prompt isolation or successful deployment.

## Acceptance and verification

- Doctor is bounded, read-only, secret-free, and distinguishes unreachable, locked, failed, and unknown states. Test partial failure and macOS fallback.
- Old grants remain usable. Old MCP request shapes remain valid. Missing or malformed V3 capabilities cannot silently produce permanent grants.
- Two concurrent login requests cannot both use one once grant. Restart/crash behavior never restores a consumed use.
- Test expiration boundaries, rollback detection, queued operations, revocation ordering, invalid policy, approval cancellation, and approval timing out.
- Test misleading or absent login fields, approved success conditions, challenges, and session injection failures. No unconfirmed authentication is reported as confirmed success.
- Add regression checks to the existing Vitest suites. Run tests and TypeScript build for each implementation stage.
- Extend the manual attack checklist for duration tampering, replay, concurrent requests, rollback, diagnostics leakage, and the management window. Perform Windows and macOS native checks before platform release claims.
- Management window can inspect grants, lock/unlock, and revoke without exposing secrets or changing the approval boundary.

## Builder decisions

The builder may choose exact result-code names, native layout, diagnostic report formatting, timeout constants, and test-file placement. Use installed dependencies and existing platform adapters. Preserve existing comments and unrelated work. Any additional dependency, broader login support, or change to the credential boundary requires a separate rationale and scope discussion.
