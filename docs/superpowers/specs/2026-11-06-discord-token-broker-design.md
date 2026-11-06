# Discord token broker for U-Chan Secrets

Status: scope approved by the user on 2026-11-06; implementation plan follows separately.

## Intent and confirmed scope

The user stores a bot token in a Bitwarden item named `VDN Discord Bot` and wants agents to use it through U-Chan. The user selected: “Manage channels, roles, and tournament setup.” The current website-login tools cannot use API tokens.

Keep the token, vault session, and authenticated HTTP requests inside the existing privileged service. Agents receive scoped tools and filtered results. Preserve website-login behavior and unrelated local files, including the existing untracked `.playwright-mcp/` directory.

## Proposed first release

Support setup within existing Discord servers where the bot is already installed:

- Inspect the selected server, its roles, and its channels/categories.
- Create and edit roles, including name, color, hoist, mentionability, and permissions.
- Create and edit categories, text channels, and voice channels, including parent category, topic where applicable, and permission overwrites.
- Set channel and role ordering.
- Add or remove a selected role for a selected member ID, after verifying both belong to the approved server.
- Compose these operations into a small, explicitly reviewed tournament setup batch. Return IDs after creation so the agent can use them in later batches.

First-release exclusions are builder proposals, not previously agreed requirements: no deletion, kicks/bans, server creation, bot invitations, webhook/token management, message reading/sending, arbitrary HTTP endpoints, shell execution with injected secrets, or hardcoded tournament templates. The agent chooses the requested structure; U-Chan authorizes and executes typed operations.

## Authorization experience

Expose a Discord-specific approval request taking a connection alias, the user-supplied Bitwarden item name/ID, token field selector, and one exact server ID. Prefer the item UUID; ambiguous name matches fail. The token field is either the login password or one explicitly named hidden custom field; never search all fields or return a field's value. Field choice is visible in protected approval and remains fixed for that connection. Do not fetch the token before approval. A missing field produces a fixed safe error and no fallback.

The protected native prompt displays the exact item reference, field selector, server ID, alias, read scope, and write policy. Approval grants permanent metadata reads for that server until revoked; it never grants unattended writes. A denied or cancelled prompt creates no connection. Server identity can be shown after the first authorized fetch; it cannot substitute for the exact approved ID.

Every write request contains an immutable, strictly validated operation list. A second protected prompt displays the exact target server, operations, affected IDs, requested names/settings, permission changes, and member-role changes. It authorizes that one batch only. No hidden fields, truncated payloads, or execution of an edited payload after approval. Reject a batch that cannot be completely reviewed in the native prompt. Initial limit: at most 10 operations and 8 KiB canonical JSON, reduced further if native rendering cannot display the complete proposal. Builder must verify actual rendering before claiming native usability.

The existing Windows helper uses fixed-height, ellipsized labels, so this upgrade must add a fully readable, wrapped and scrollable protected review surface. Preserve the separate input desktop and master-password controls. This native-helper change requires the trusted reinstall path rather than claiming the signed JavaScript-only updater can install it. First-release Discord support is Windows only; macOS broker requests fail closed with an explicit unsupported-platform message until its complete-review prompt is implemented and independently verified. Existing macOS website login remains unchanged.

Disallow granting `ADMINISTRATOR` in this first release, including assigning an existing administrator role to a member or modifying a role's permissions to include that bit. Inspect current role permissions again before member-role assignment. Other permission changes require explicit named-bit disclosure, including `MANAGE_ROLES`, `MANAGE_CHANNELS`, and overwrite changes that expose private channels. Reject unknown permission bits and decimal values outside the supported bitset. Never silently broaden permissions. Discord still enforces the bot's permissions and role hierarchy.

Revocation is available through MCP and a CLI command without a new approval. Listing shows aliases, server IDs, item references, token-field selectors, and scope, never secrets. Include Discord connections in management visibility and revocation; do not disguise them as website domains. Vault lock prevents subsequent credential acquisition. Revocation stops future requests; it cannot undo completed Discord changes or revoke a request already dispatched.

## MCP and CLI surface

Proposed MCP tools:

- `discord_request_allow`: request protected creation/replacement of one server connection.
- `discord_list_allowed`: list safe connection metadata.
- `discord_inspect`: retrieve approved server/channel/role metadata, optionally selected member metadata needed for role assignment.
- `discord_apply`: submit one exact typed batch and obtain protected approval before execution.
- `discord_revoke`: revoke one alias.

CLI equivalents cover connection approval, listing, inspection, applying an operations JSON file, and revocation. These use authenticated IPC; they never write protected configuration directly. Document argument shapes and one dummy tournament setup example. Do not embed actual server IDs or token values.

The desktop MCP client has no vault or network implementation. Add a `discord_broker` capability; refuse calls against older services with an actionable update message. Keep existing five website tools and their signatures intact.

## Service implementation and protected state

Reuse Bitwarden execution/session handling, authenticated IPC, protected prompts, approval-mode/lockout behavior, and audit infrastructure. Add a dedicated `DiscordService` rather than mixing Discord operations into browser-login code. Use native `fetch`; add no runtime dependency.

Refactor the vault's internal item retrieval once so login and token retrieval share its bounded subprocess, cancellation, session, ambiguity, and fixed-error handling. Token retrieval is a service-internal method, never an IPC/MCP method. Accept only a nonempty bounded token without whitespace or control characters; do not depend on a guessed token format.

Store connection metadata, never tokens, in a separately validated `discord-allowlist.json` inside the protected service home. Validate every loaded record, deny malformed/duplicate records, write atomically, and reject symlink/reparse destinations. Reuse the service-wide coordinator to serialize approval, connection changes, and batch execution; no parallel changes to the same policy. An approved alias replacement never inherits write approval.

Back up affected protected files under the existing protected `#0 backup` directory before first upgrade mutation. Do not copy protected state into this checkout. Extend doctor, install/reinstall, update, and management handling for the new state. Keep website schema 3 compatible; older software must not reinterpret Discord records as website grants. An older service simply lacks the new capability. Preserve the Discord file across a compatible downgrade, inert until a supporting service runs again. Fail closed if protected permissions or backup prerequisites cannot be established.

## HTTP execution boundary

All routes are built internally against `https://discord.com/api/v10/`. Callers supply validated snowflake IDs and typed fields, never URLs, paths, headers, methods, or authorization values. Use `Authorization: Bot <token>` only inside the service. Disable redirects; never forward credentials to another origin. Do not fetch attachment/icon URLs, follow response links, use webhooks, or return raw upstream bodies/headers/errors.

Before any mutation, retrieve enough metadata to verify every target channel, parent category, role, overwrite target, and member belongs to the approved server. Validate operation-specific types and bot role constraints; reject malformed and out-of-scope requests before writes. Revalidate relevant state after protected approval and before dispatch. Refuse edits to managed roles and the bot's own authority roles, and role-hierarchy moves that make future safe management impossible. Changes to `@everyone` require explicit disclosure in the exact protected batch. Do not accept unresolved or agent-invented aliases as Discord IDs.

Use a fixed overall execution deadline and bounded response bodies. Respect documented rate-limit headers and server retry intervals; never retry earlier. Return a bounded retry-after result when it cannot fit the deadline. Do not automatically replay a write after a timeout, network error, ambiguous 5xx, or interrupted response: the write may already have succeeded. Safe reads may retry within bounds. A confirmed 429 may retry the same operation only within the approved deadline and documented wait.

Execute batches in order and stop on the first failure. Return each completed operation's safe result and the stopped/unknown operation. No automatic rollback, because rollback would create additional unapproved writes. After uncertain writes, require inspection before any new proposal. Created IDs become available only after that operation succeeds; dependent creation uses a later approved batch. Reordering operations use validated existing IDs.

Project response objects into a small documented schema. Bound names/topics and collection sizes; paginate or report explicit incompleteness rather than silently dropping entries. Strip the active token, vault session, and other fetched credential material from all serialized tool results. Suppress raw exception text after credential access. Audit action, alias/server/target IDs, operation type, approval/denial, completion, and unknown outcomes; never token values, full API bodies, member content, or raw upstream errors. Audit intent before dispatch; fail closed if that initial audit write fails. An audit failure after dispatch must report possible execution, not imply no change.

## Verification and completion

Use dummy vault items and fake transport responses for regression tests. Cover approved token field retrieval, ambiguous/missing items, locked vault, invalid policy, malformed state, denied/cancelled approval, revoked aliases, old-service capability refusal, read/write separation, cross-server targets, parent/overwrite/member validation, administrator rejection, immutable approval payloads, no hidden/truncated fields, batch size, redirects, body limits, deadlines, rate limiting, partial/unknown writes, and token/error leakage through IPC, MCP, logs, and audit. Preserve and run existing login tests. Run full tests, TypeScript checks, build, and diff checks.

Before structural edits, create a source snapshot under repository `#0 backup` without unrelated files or credentials. Do not stage source backups. Native verification uses disposable server fixtures only after explicit user authorization; never create real channels/roles merely to prove the implementation works.

Implementation, local verification, commit/push, package publication, privileged installation, and live Discord mutation are separate outcomes. This design proposes source implementation and local verification first. It does not authorize a production Discord change or claim an installed upgrade. Choose package version at release time, after verifying the existing release process.

## References checked during design

- https://docs.discord.com/developers/reference
- https://docs.discord.com/developers/resources/guild
- https://docs.discord.com/developers/resources/channel
- https://docs.discord.com/developers/topics/permissions
- https://docs.discord.com/developers/topics/rate-limits

## Decisions left to implementation

Exact module boundaries, internal type names, CLI grammar, prompt paging, response pagination, and test fixture organization follow existing conventions. No new dependency or generalized credential broker is required. Any broader action set or unattended-write policy needs a revised, explicit scope.

## Builder review

An independent builder review identified two decisions: initial native-platform support and assignment of existing administrator roles. The design now explicitly chooses Windows-first broker support and bans existing administrator-role assignment. The reviewer found the remaining scope buildable. Both choices are proposed defaults for the user's approval.
