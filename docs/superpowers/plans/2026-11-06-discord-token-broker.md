# Discord Token Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let agents configure tournament channels and roles through approved Discord operations while keeping the Bitwarden bot token inside U-Chan's privileged service.

**Architecture:** Add a Discord-specific service alongside browser login, reached through existing authenticated IPC. Reuse the vault, approval policy, shared coordinator, and audit log. Store non-secret Discord connections separately from website grants.

**Tech Stack:** Existing TypeScript, Node native fetch, Zod, Vitest, Windows protected C# helper. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-06-discord-token-broker-design.md` (user-approved scope).

## Global Constraints

- Windows-first broker; macOS broker requests fail closed; existing website behavior remains compatible.
- One exact server per approved connection. Permanent metadata reads; every write batch requires protected approval.
- At most 10 operations and 8 KiB canonical JSON per batch; reject anything that cannot be displayed completely.
- No administrator grants, including assignment of an existing administrator role.
- No deletion, messages, moderation, server creation, webhooks, arbitrary URLs, or secret-injected shell commands.
- Credential retrieval and `Authorization` headers exist only in the privileged service.
- Never copy real vault/protected state into this checkout. Preserve `.playwright-mcp/`.
- Snapshot tracked source into repository `#0 backup` before implementation; exclude backup from staging.
- Native-helper changes require trusted reinstall. Local tests do not establish installed native verification.
- No publication, installation, or real Discord changes during source implementation.

## Review Focus

- Existing administrator roles: member-role assignment must inspect current permissions, including after approval.
- Prompt text: long Unicode names, control characters, permission overwrites, and multi-operation batches must remain fully reviewable.
- Uncertain writes: a timeout after dispatch must stop the batch, report unknown outcome, and never automatically replay it.
- Scope races: channel moves, role changes, revocation, and vault lock must not silently expand the approved target or credential access.
- Token echo: transport errors and response fields containing the active token must never reach IPC, MCP, stderr, or audit.

---

### Task 1: Validated Discord contracts and service-only vault access

**Files:** Create `src/discord/policy.ts`, `test/discord-policy.test.ts`; modify `src/core/vault.ts`; extend `test/vault.test.ts`.

**Interfaces:** Produce `DiscordConnection`, `TokenField`, `DiscordOperation`, `connectionSchema`, and `batchSchema` in policy module. Add service-only `BitwardenVault.getToken(item: string, field: TokenField, signal?: AbortSignal): Promise<string>`. Keep `VaultClient.getLogin` compatible.

- [x] Add failing tests for exact connection schema, bounded safe alias/item/field, snowflake IDs, strict operation variants, unknown fields, 10-operation/8-KiB caps, and permission validation.
- [x] Add failing vault tests for password-only item, hidden custom field, duplicate field names, missing/ambiguous items, locked session, cancellation, and fixed errors without secret output.
- [x] Run `rtk npm test -- test/discord-policy.test.ts test/vault.test.ts`; observe the missing behavior.
- [x] Extract private item retrieval once; retain existing login results/errors. Add strict token-field retrieval without fallback, stdout/stderr logging, or token exposure through an API contract.
- [x] Define strict discriminated operation schemas: role create/edit/reorder, channel create/edit/reorder, member-role add/remove. Limit supported channel kinds to category/text/voice. Validate permission strings against supported named bits using BigInt; reject administrator grants.
- [x] Rerun targeted tests; require PASS.

### Task 2: Protected Discord connection state

**Files:** Create `src/discord/store.ts`, `test/discord-store.test.ts`; modify `src/core/config.ts`, `src/service/state.ts`, and protected-state tests as needed.

**Interfaces:** `DiscordStore.list(): Promise<DiscordConnection[]>`, `get(alias: string)`, `upsert(connection: DiscordConnection)`, and `remove(alias: string)`. Path comes from service config, never caller input. Writes run inside the existing coordinator.

- [x] Add failing tests for missing/invalid/duplicate state, atomic updates, symlink refusal, backup prerequisites, and no token persistence.
- [x] Run `rtk npm test -- test/discord-store.test.ts`; verify failure.
- [x] Implement strict whole-file validation, bounded reads, atomic private-file writes, safe temporary paths, and pre-mutation backup under protected `#0 backup`. Establish permissions before copying. Preserve website schema 3.
- [x] Add `discordAllowlistPath` to `serviceConfig`; keep installer preservation and protected-tree permission checks compatible.
- [x] Rerun targeted tests; require PASS.

### Task 3: Fixed-origin HTTP adapter and scoped Discord service

**Files:** Create `src/discord/http.ts`, `src/discord/service.ts`, `test/discord-http.test.ts`, `test/discord-service.test.ts`; modify `src/core/types.ts` for audit actions only.

**Interfaces:** `DiscordApi` has `discordRequestAllow(proposal)`, `discordListAllowed()`, `discordInspect(alias, memberId?)`, `discordApply(alias, operations)`, and `discordRevoke(alias)`, each returning `Promise<ToolResult>`. `DiscordService` consumes vault token access, store, approver, audit, shared coordinator, platform, and injectable transport. HTTP adapter accepts internally constructed routes, token, and AbortSignal; callers cannot choose origin or headers.

- [x] Add failing transport tests for fixed HTTPS origin/API v10, no redirects, bounded bodies, safe projections, sanitized exceptions, deadline, rate-limit delays, and no write replay after ambiguous failure.
- [x] Add failing service tests for denied grants, old/invalid connections, locked vault, Windows-only behavior, foreign targets, hierarchy/managed-role restrictions, administrator-role assignment, exact immutable write approval, and no execution on audit-intent failure.
- [x] Run `rtk npm test -- test/discord-http.test.ts test/discord-service.test.ts`; verify failure.
- [x] Implement protected connection approval without credential acquisition before approval. Implement metadata reads, including complete/incomplete indicators and bounded member lookup.
- [x] Implement validate/inspect/approve/revalidate/dispatch pipeline. Verify server ownership for channels, parents, roles, overwrites, members, and reorder targets. Display named permission changes and reject unsafe authority changes.
- [x] Execute approved operations sequentially with a fixed deadline. Stop on first failure, preserve completed safe results, and distinguish failed from unknown writes. Do not roll back or retry uncertain mutations.
- [x] Audit sanitized intent before dispatch and safe outcomes after dispatch. Return explicit possible-execution status on post-dispatch audit failure. Redact active credential material from final serialized results.
- [x] Rerun targeted tests; require PASS, including token echo, revocation ordering, vault lock, and changed role permissions after approval.

### Task 4: Fully readable protected write review

**Files:** Modify `src/platform/windows/assets/prompt-src.ts`, extend existing native-prompt tests and add `test/discord-prompt.test.ts` if needed.

**Interfaces:** Preserve existing `ProtectedPrompt` and `PolicyApprover` contracts. Change the native details surface so all supplied lines are wrapped, read-only, and scrollable without ellipsis. Preserve secure desktop, password input, phrase banner, cancellation, and timeout.

- [x] Add failing tests for long/multiline Unicode details, batch display completeness, bounded native arguments, and retained secure-input controls.
- [x] Run targeted native-source/prompt tests; verify failure.
- [x] Replace the clipped label presentation with a bounded scrollable read-only detail control. Render canonical operation details without suppressing fields or using user-controlled formatting that changes meaning.
- [x] Add broker capability gating tied to support for complete protected review; do not claim an old installed helper can execute the new broker.
- [x] Run prompt tests and existing native helper build checks. Record Windows installed rendering and input isolation as NOT VERIFIED until trusted disposable native rehearsal occurs.

### Task 5: IPC, MCP, CLI, management, and diagnostics

**Files:** Modify `src/ipc/protocol.ts`, `src/ipc/server.ts`, `src/ipc/client.ts`, `src/mcp/server.ts`, `src/index.ts`, `src/service/main.ts`, `src/service/control.ts`, `src/service/manage.ts`, `src/service/doctor.ts`, `src/cli.ts`; add `src/client/discord.ts`; extend relevant tests.

**Interfaces:** Advertise `discord_broker` capability only on supporting service/platform. IPC methods use snake_case names matching the five proposed MCP tools. Keep Discord API separate from `CoreApi` so existing website callers/fixtures remain compatible. Thin client validates capability and forwards only typed arguments.

- [x] Add failing IPC/MCP tests for capability refusal, malformed arguments, exact method forwarding, service-only credential access, and unchanged website tool signatures.
- [x] Add failing CLI tests for `u-chan discord allow <connection-json-path>`, `list`, `inspect <alias> [member-id]`, `apply <alias> <operations-json-path>`, and `revoke <alias>`; reject extra arguments and oversized files.
- [x] Wire service, transport, store, and shared coordinator. Register five Discord tools without moving HTTP/vault logic into the desktop process.
- [x] Add CLI parser and usage; JSON files contain policy or operations only, never token values. Return nonzero on denial, unsupported service/platform, and partial/unknown execution.
- [x] Extend management with visibly prefixed Discord targets, separately validated revocation, and safe audit labels. Add doctor findings for malformed Discord policy and broker readiness without fetching credentials.
- [x] Extend install/update regression checks: preserve connection metadata, detect changed helper requiring trusted reinstall, never erase unrelated state.
- [x] Run targeted IPC/MCP/CLI/management/doctor/installer/updater tests; require PASS.

### Task 6: Documentation and complete local verification

**Files:** Modify `README.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/attack-checklist.md`; add `docs/superpowers/research/2026-11-06-discord-broker-validation.md`.

- [x] Document field selection, alias/server approval, exact-batch writes, revoke, dummy setup example, Windows-first support, no administrator grants, partial outcomes, and trusted reinstall requirement.
- [x] Document separate claims for source tests, CI, publication, native installation, and live Discord outcomes. Leave version unchanged until release is separately scoped.
- [x] Run `rtk npm test`, `rtk proxy npx tsc --noEmit`, `rtk npm run build`, and `rtk git diff --check`; require all checks PASS.
- [x] Obtain a fresh security review of the complete diff, fix actionable findings, and rerun affected checks.
- [x] Inspect final diff/status for unrelated changes, backups, credentials, and untracked `.playwright-mcp/` preservation. Record exact counts/results and limitations.
- [x] Report source implementation and local verification. Do not publish, reinstall, or mutate a real Discord server without that separate authorization.

## Execution recommendation

Native execution is the proposed approach: one implementer keeps the shared service contracts consistent, followed by one independent security review. The user selected native execution. Commit only scoped implementation after successful checks; do not push without user instruction.
