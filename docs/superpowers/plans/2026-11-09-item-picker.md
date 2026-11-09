# Protected Bitwarden Item Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `request_allow` / `u-chan allow` work without an item name: the service lists the vault items that match the login URL, and the user picks one in a protected window, so the AI never has to guess or ask for an item name.

**Architecture:** When `item` is omitted (empty string over IPC), `CoreService.requestAllow` calls a new secret-free `VaultClient.listItems(loginUrl)` (`bw list items --url`). With 0 matches it fails with a next step, with 1 it uses that item's id, and with more than one it calls a new `Approver.pick`, which runs a new native prompt-helper mode `pick`. The chosen id is stored. The existing approval prompt (confirm or password) then runs unchanged and shows the chosen item.

**Tech Stack:** TypeScript (ESM, Node ≥24), vitest, zod, C# WinForms (prompt helper, compiled at install).

**Spec:** No separate spec. This is the item deferred in `docs/superpowers/plans/2026-11-09-ux-upgrades.md` ("a protected item picker for `allow --item`"). The user asked to skip the design questions, and every choice below is the planner's call.

## Global Constraints

- No new dependencies.
- Native helper change: this release ships with the navy unlock dialog (branch `feat/navy-unlock-dialog`) and needs a trusted reinstall; `u-chan update` reports `native_helpers_changed`. The CHANGELOG must say so.
- Never return item usernames, passwords, notes or ids beyond the chosen id to the AI or the CLI. The picker labels (name and username) are shown only inside the protected window.
- An explicit `item` keeps today's behavior exactly: no listing, no picker.
- `pick` is optional on `ProtectedPrompt` and `Approver`. Where it is missing (macOS), an omitted item fails with `item is required on this platform; pass the Bitwarden item name or id`.
- At most 20 choices. More than 20 matches fail with `too many Bitwarden items match <host>; pass the item id`.
- Picker labels are `name` or `name — username`, cut to 120 chars, and run through `clean()` from `src/core/allowlist.ts`.
- Test command: `npx vitest run <file>`; full suite `npm test`; type check `npx tsc -p tsconfig.json --noEmit`; native layout `npm run build && node test/native/prompt-layout-fixture.mjs`.

## Review Focus

1. **Locked vault at allow time.** Today `allow` works with a locked vault; listing needs it unlocked. Expected: omitted item + locked vault gives the existing unlock message and code `vault_locked`, and the AI's `Next:` hint says to request unlock. An explicit item still works locked. Pinned in Task 3 test `omitted item with locked vault fails with vault_locked`.
2. **Helper returns garbage or an out-of-range index** (tampered stdout, cancel, timeout). Expected: treated as cancel; the request returns `denied` and nothing is stored. Pinned in Task 2 test `pick rejects out-of-range output`.
3. **Deleted or non-login items in the list** (trash, secure notes). Expected: only `type === 1` items without `deletedDate` are offered. Pinned in Task 1 test `listItems skips deleted and non-login items`.
4. **Item names with newlines or control characters** breaking the dialog or the `--choices` JSON. Expected: labels pass through `clean()` and are capped. Pinned in Task 1 test `listItems cleans and caps labels`.
5. **Picker cancelled, then approval never shown.** Expected: cancel in the picker returns `denied`, audited `denied`, with no second window. Pinned in Task 3 test `cancelled pick is denied without approval prompt`.

---

### Task 1: Secret-free vault listing

**Files:**
- Modify: `src/core/types.ts:19-24` (`VaultClient`)
- Modify: `src/core/vault.ts` (new public method beside `exactName`, ~line 178)
- Test: `test/vault.test.ts`

**Interfaces:**
- Produces: `export interface ItemChoice { id: string; label: string }` in `src/core/types.ts`; optional `listItems?(url: string, signal?: AbortSignal): Promise<ItemChoice[]>` on `VaultClient`; implemented on the bw vault class.

- [ ] **Step 1: Write the failing tests** in `test/vault.test.ts`, using the file's existing fake `run`:
  - `listItems runs bw list items --url`: asserts argv `['list','items','--url','https://moji.example/admin']` and the session is passed.
  - `listItems skips deleted and non-login items`: input `[{id:'a',type:1,name:'Moji Admin',login:{username:'me@x',password:'p'}},{id:'b',type:1,name:'Old',deletedDate:'2026-01-01',login:{}},{id:'c',type:2,name:'Note'}]` → `[{ id: 'a', label: 'Moji Admin — me@x' }]`.
  - `listItems cleans and caps labels`: name `'A\nB' + 'x'.repeat(200)` → label without `\n`, length ≤ 120.
  - `listItems never returns secrets`: `JSON.stringify(result)` does not contain `'p'`-valued password or totp from the fixture (use a distinctive value like `'S3CRET-PW'`).
  - `listItems with locked vault throws the unlock message`: no session → rejects with the same message `getItem` uses (`UNLOCK_MSG`).
- [ ] **Step 2: Run** `npx vitest run test/vault.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement `listItems(url: string, signal?: AbortSignal): Promise<ItemChoice[]>`.** Same session and error handling as `getItem` (no session → `LOGIN_MSG`/`UNLOCK_MSG`; non-zero exit → `bw failed (exit N)`). Map to `{ id, label }` only; drop everything else before returning.
- [ ] **Step 4: Run** `npx vitest run test/vault.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(vault): list login items for a URL without secrets`.

### Task 2: Native `pick` mode and approver plumbing

**Files:**
- Modify: `src/platform/windows/assets/prompt-src.ts` (dispatch near line 306; new `RunPickDialog` beside `RunPasswordDialog`)
- Modify: `src/platform/windows/prompt.ts:52-157`
- Modify: `src/core/types.ts:72-79` (`PromptRequest`, `ProtectedPrompt`, `Approver`)
- Modify: `src/service/policy-approver.ts`
- Modify: `test/native/prompt-layout-fixture.mjs` (add scenario `pick`)
- Test: `test/windows/prompt.test.ts`, `test/policy-approver.test.ts`

**Interfaces:**
- Consumes: `ItemChoice` (Task 1).
- Produces: `PromptRequest.choices?: string[]`; `ProtectedPrompt.pick?(req: PromptRequest): Promise<number | null>`; `Approver.pick?(title: string, lines: string[], choices: string[]): Promise<number | null>`; helper CLI `--mode pick --choices <JSON string[]>` writing the chosen zero-based index to stdout.

- [ ] **Step 1: Write the failing tests.**
  - `test/windows/prompt.test.ts` `pick passes choices and returns the index`: fake `execFile` captures args; asserts `--mode pick` and `--choices '["A","B"]'`; stdout `'1'` → `1`.
  - `pick rejects out-of-range output`: stdout `'2'` with 2 choices → `null`; `'x'`, `''`, `'-1'`, `'1\n2'` → `null`; exec error → `null`.
  - `test/policy-approver.test.ts` `pick shows the phrase and needs no password in hardcore`: hardcore settings; `prompt.pick` receives `phrase`; `askPassword` and `checker.verify` never called.
  - `pick is undefined when the prompt has none`: approver built with a prompt lacking `pick` → `approver.pick` is `undefined`.
- [ ] **Step 2: Run** `npx vitest run test/windows/prompt.test.ts test/policy-approver.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `WindowsPrompt.pick`: queued like `manage`; runner mode `'pick'` pushes `--choices JSON.stringify(req.choices ?? [])`; accept stdout only if it matches `^\d{1,2}$` and is `< choices.length`.
  - `PolicyApprover`: define `pick` in the constructor only when `d.prompt.pick` exists, run through `serial`, pass `phrase`. It is a selection, not an authorization: no limiter, no password.
  - `RunPickDialog(title, phrase, lines, choices)`: reuse the navy header, verification-phrase box, footer, buttons and 2-minute countdown from `RunPasswordDialog` (factor the shared header/footer into one private helper if it keeps the file shorter). Body: context lines, then a `ListBox` of choices (single select, first item selected, `AccessibleName` "Bitwarden item"), double-click = OK. Heading "Choose Bitwarden item", submit "Use item". On OK `Console.Write(index)`. Width 420.
  - Fixture: scenario `pick` with 3 choices; check no clipping, list has focus, Cancel → result 1.
- [ ] **Step 4: Run** the Step 2 tests, then `npm run build && node test/native/prompt-layout-fixture.mjs`, and look at `pick.png`. Expected: PASS, no clipping.
- [ ] **Step 5: Commit** `feat(prompt): protected Bitwarden item picker window`.

### Task 3: `requestAllow` resolves an omitted item

**Files:**
- Modify: `src/core/service.ts:120-153`
- Modify: `src/core/result-hints.ts` (hint for the new failures)
- Test: `test/service.test.ts`

**Interfaces:**
- Consumes: `VaultClient.listItems` (Task 1), `Approver.pick` (Task 2).
- Produces: `requestAllow(domain, loginUrl, item, …)` where `item === ''` means "pick for me". Signature unchanged.

- [ ] **Step 1: Write the failing tests** in `test/service.test.ts`:
  - `omitted item with one match stores its id`: `listItems` → `[{id:'id-1',label:'Moji Admin — me@x'}]`; `pick` never called; stored `entry.item === 'id-1'`; approval lines contain `Bitwarden item: Moji Admin — me@x`.
  - `omitted item with several matches uses the picked id`: 2 choices, `pick` → `1`; stored item is the second id; `pick` got the labels and lines naming the domain.
  - `cancelled pick is denied without approval prompt`: `pick` → `null`; result `{ ok:false, message:'denied' }`; `approver.ask` not called; nothing upserted; audit `denied`.
  - `omitted item with no match`: `listItems` → `[]`; `ok:false`, message `no Bitwarden login item matches moji.example; pass the item name or id`.
  - `omitted item with more than 20 matches` fails with `too many Bitwarden items match moji.example; pass the item id`.
  - `omitted item without pick support` (approver lacking `pick`, 2 matches) fails with `item is required on this platform; pass the Bitwarden item name or id`.
  - `omitted item with locked vault fails with vault_locked`: `listItems` rejects with the unlock error; result code `vault_locked`.
  - `explicit item never lists`: `listItems` not called; stored item is the given string.
- [ ] **Step 2: Run** `npx vitest run test/service.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Resolve the item before `buildEntry`: when `clean(item) === ''`, list by the cleaned `loginUrl`, apply the rules above, and remember the chosen label for the approval line (`Bitwarden item: <label>`; otherwise keep `entry.item`). Map the unlock/login errors to `vault_locked` / `vault_unauthenticated` the way `login` does. Add `Next:` hints for the three new messages in `result-hints.ts` (no match / too many → "Ask the user for the Bitwarden item name or id and pass it as item."; locked → the existing unlock hint).
- [ ] **Step 4: Run** `npx vitest run test/service.test.ts test/mcp.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(allow): pick the Bitwarden item when none is given`.

### Task 4: Make `item` optional on every surface

**Files:**
- Modify: `src/client/allow.ts:8-41`
- Modify: `src/ipc/server.ts:46-54`, `src/ipc/client.ts:68-78`
- Modify: `src/mcp/server.ts:26,83-96`
- Modify: `README.md`, `CHANGELOG.md`
- Test: `test/cli-allow.test.ts`, `test/ipc.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Consumes: `requestAllow` with `item === ''` (Task 3).

- [ ] **Step 1: Write the failing tests.**
  - `test/cli-allow.test.ts` `allow without --item asks the service to pick`: `['--login-url','https://moji.example/admin']` parses with `item: ''`; `--item ''` still returns `null`.
  - `test/ipc.test.ts` `request_allow accepts an empty item`: `item: ''` reaches `api.requestAllow`; a missing or non-string `item` is still BAD.
  - `test/mcp.test.ts` `request_allow without item sends an empty item`: the tool call omits `item`; core receives `''`. Also assert `INSTRUCTIONS` no longer contains `ask the user which Bitwarden item`.
- [ ] **Step 2: Run** `npx vitest run test/cli-allow.test.ts test/ipc.test.ts test/mcp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - CLI: `--item` optional; when absent pass `''` and skip the `buildEntry` validation for the item (validate domain and URL only). Update `USAGE` to show `[--item <name|id>]`.
  - IPC server: accept `typeof p.item === 'string'` (empty allowed) instead of `str(p.item)`.
  - MCP: `item: z.string().max(1000).optional()`, sent as `item ?? ''`. Tool description: "`item` (optional) is the Bitwarden item name or id. Leave it out and the user picks the item in a U-Chan window; pass it only when the user named one." INSTRUCTIONS line 26 becomes: `If the domain is not allowlisted, call request_allow; leave item out unless the user named one, and the user picks the item and approves in a U-Chan window.`
  - README: `allow` usage and the MCP flow. CHANGELOG `## Unreleased`: `- u-chan allow and request_allow can leave out the Bitwarden item: the user picks it from the matching vault items in a protected window (vault must be unlocked). Needs a trusted reinstall: the prompt helper changed.`
- [ ] **Step 4: Run** `npm test` and `npx tsc -p tsconfig.json --noEmit`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(allow): item is optional on CLI, IPC and MCP`.
