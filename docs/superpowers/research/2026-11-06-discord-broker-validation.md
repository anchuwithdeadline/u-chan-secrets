# Discord broker validation

Scope: user-approved Windows-first token broker; native execution in `feat/discord-broker`. No real token was retrieved, no installed service was changed, and no real Discord request was made.

## Baseline

- Original checkout baseline: 435 tests across 59 files passed.
- Whole-project baseline type checking failed at `test/setup.test.ts:108` because its mock inferred only `state: 'ready'`. The fixture now declares the existing `CodexSetupResult` return type; no setup runtime behavior changed.
- Tracked-source ZIP backup retained in original checkout `#0 backup/discord-broker-before-20261106.zip` (387,821 bytes).
- Implementation uses a linked worktree under ignored `.superpowers/worktrees/discord-broker`. Original `.playwright-mcp/` and user checkout files remain untouched.

## Local verification

Targeted red/green checks cover token field retrieval, existing vault-login compatibility, strict batch schemas, connection-state validation and junction refusal, audit prerequisites, fixed-origin HTTP/redirect/body limits, denied and immutable approval, cross-server targets, existing administrator-role assignment, vault-lock/partial failures, uncertain writes, missing create IDs, escaped token echo redaction, IPC capability refusal, MCP schemas, CLI parsing, and distinct management revocation.

The Windows compiler test compiled all three C# assets, including the changed prompt helper. That verifies compilation only, not installed protected input or rendering.

Before final review fixes, the complete suite passed 455 tests across 66 files; build, whole-project type checking, and diff checks also passed. Final results follow below.

## Independent review and fixes

The independent reviewer found no Critical or Important security findings. It found one behavior issue: overlapping edits could stop after the first edit changed the original review baseline. A failing regression reproduced this; batches now reject direct overlapping targets before approval. Same-role assignments to different members remain supported. The reviewer rechecked this fix and found no actionable Important issue.

Self-review added failing rate-limit regressions for body-only `retry_after` and delays longer than one day. The adapter now honors the maximum supplied header/body interval without shortening it or replaying writes. The reviewer rechecked that fix too.

Residual conservative behavior: creating/reordering roles can indirectly shift another role's position. A later existing-target operation can then stop safely as changed state, returning completed results. Split dependent setup into separate batches and inspect before retrying.

The final spec check also reproduced assignment of an existing role with unsupported permission bits. Such assignments are now refused before approval and during revalidation; unknown bits are explicitly labeled in protected review. Audit intents/outcomes now include fixed internal routes so member/role target IDs are retained without raw payloads. The reviewer checked these final deltas and found no Important security concerns.

## Final local results

- Full suite: **459 tests passed across 66 files**, zero failures (43.31 seconds).
- Whole-project TypeScript: `npx tsc --noEmit` passed.
- Production build: `npm run build` passed.
- `git diff --check` passed; staged whitespace is checked before commit.
- Independent review and narrow rechecks: no Critical or Important security findings; direct-target conflict behavior fixed.
- Actual Windows C# compilation passed within the complete test suite. Installed rendering and input isolation remain NOT VERIFIED.
- Runtime dependencies, package version, website protocol/schema, installed service, and real Discord state were not changed.

## Not performed

- CI, commit/push, merge, package version bump, publication, or signed artifact verification.
- Privileged reinstall, protected production-state migration, installed-helper rendering, or native input-isolation rehearsal.
- Retrieval/use of `VDN Discord Bot` credentials or creation/modification of any real server resource.
- macOS native broker runtime: unsupported in this release.

Native-helper source changes require trusted reinstall. Existing updater code refuses differing native helper source; desktop-package update alone is insufficient.
