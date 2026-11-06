# Agent unlock and GitHub validation

## Scope and implementation choices

The user requested agent-triggered protected unlock and an additional API connector, then delegated the initial GitHub action set to implementation judgment. Source work branches from `cc78735` on `feat/agent-unlock-github`. No dependencies or new native prompt helper were added. Existing protected prompt, token lookup, authenticated owner IPC, shared approval/failed-password mechanisms, and serialized grants queue are reused.

Agent unlock accepts no password or caller-controlled display text. Concurrent calls share one existing unlock attempt; cancellation, success, and failure settle before a 30-second agent cooldown begins. Manual unlock remains usable. An already unlocked vault is reused. Explicit lock invalidates pending unlock work, and no in-memory session is persisted across service restarts.

GitHub scope is intentionally repository metadata, issue/PR text, workflow status, issue creation, and same-repository draft PR creation. Connections require exact protected enrollment and bind the repository's numeric ID. Every create has complete protected review, post-approval state checks, audit intent, and one POST attempt. API routes, host, payloads, result projections, sizes, deadlines, and token redaction are bounded. Unknown writes must be inspected before any retry. Branch movement during POST is checked in the response but cannot be atomically prevented by this API; an uncertain draft is retained.

## Verification

- New agent-unlock regressions failed before implementation, then passed with shared attempts and cooldown behavior.
- Targeted tests cover protected enrollment before credential fetch, missing/locked grants, repository ID drift, invalid routes/payloads, fixed origin and redirect policy, token redaction, rate limiting, uncertain writes, branch drift, exact creation payloads, draft-only PRs, failed audit, corrupt state, and revocation without an unlocked vault.
- IPC/MCP integration verifies capability gating, rejection of password and arbitrary URL inputs, authentication refusal, update maintenance blocking, and uncertainty after post-send disconnect/malformed response.
- Vault authorization generations invalidate approvals across explicit lock, new unlock, idle expiry, and lock/re-unlock during token lookup. Final dispatch checks occur after all post-approval awaits.
- Full local suite: 518 tests passed in 79 files. Build, whole-project TypeScript, and diff whitespace checks passed. This is local evidence, not a CI result.
- Fresh stdio MCP discovery from the built source exposed 17 tools: the existing 11, `request_unlock`, and five GitHub tools. No tools were invoked during this discovery check. The pre-change source ZIP passed its integrity check with 249 archived entries.

## Independent review

A separate read-only reviewer found two blocking issues: IPC failures after create dispatch lost uncertain-outcome wording, and authorization could change between protected approval and POST. Both were fixed with regressions. A follow-up review closed both findings after the epoch snapshot moved before all post-approval awaits. The reviewer reported no remaining blockers in the reviewed changes.

## Boundaries

No GitHub token was read, no live connection was enrolled, and no GitHub write was sent during validation. The installed service was not upgraded or restarted for these features. Live verification is pending a user-selected Bitwarden item and repository, followed by protected enrollment. Existing installed helper behavior is reused, but this source verification does not prove live SYSTEM prompt delivery or live token permissions. Source backup remains in `#0 backup/before-agent-unlock-github.zip`.

REST contracts and permission guidance were checked against official GitHub documentation: [issues](https://docs.github.com/en/rest/issues/issues), [pull requests](https://docs.github.com/en/rest/pulls/pulls), [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), and [branches](https://docs.github.com/en/rest/branches/branches). The transport pins API version `2026-03-10` as shown in the consulted documentation.
