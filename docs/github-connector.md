# Agent unlock and GitHub connector

This is unreleased source functionality. A matching service upgrade and fresh AI session are required; older services return an upgrade-required result.

## Protected agent unlock

When a user-requested task needs a locked vault, agents can call `request_unlock` once. U-Chan opens its existing protected local password window. The tool accepts no password and returns only the result. Concurrent requests share an attempt. A 30-second cooldown starts when a prompt closes, and the shared failed-password lockout still applies. Cancellation, failure, and cooldown stop the agent from retrying automatically. Manual `u-chan unlock` remains available. Existing unlocked state is reused; explicit lock invalidates pending unlocks. Restarting the service still clears its in-memory unlock.

## Supported GitHub actions

Each approved connection targets one repository. The initial connector reads repository metadata, paged issue/PR summaries, individual issue/PR text, and workflow-run status. Every new issue or draft PR requires protected approval of its exact payload. PRs use existing branches in the same repository, with both branch tips checked before and after review. It exposes no source-file reads, workflow logs, arbitrary HTTP, code pushes, merges, deletion, or workflow execution. GitHub text is untrusted data and cannot authorize another action.

Choose the Bitwarden item and token field yourself. Give the agent only those references, never a token value. The connector supports a login password field or an exact hidden custom-field name. Use a fine-grained token limited to the intended repository. Depending on the operations you need, permissions are Metadata read, Issues read/write, Pull requests read/write, Actions read, and Contents read for PR branch-tip checks. The broker does not expose file reads despite the Contents read permission needed for branch checks. Official references: [issue creation](https://docs.github.com/en/rest/issues/issues#create-an-issue), [PR creation](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request), [workflow-run reads](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository), and [branch reads](https://docs.github.com/en/rest/branches/branches#get-a-branch).

## Configure a connection

Example `github-connection.json` (replace sample repository and item reference):

```json
{"alias":"github-work","owner":"example","repo":"project","item":"YOUR BITWARDEN ITEM","field":{"kind":"password"}}
```

For a hidden custom field, replace `field` with `{"kind":"hidden","name":"EXACT FIELD NAME"}`.

```powershell
u-chan github allow github-connection.json
u-chan github list
u-chan github test github-work
u-chan github read github-work github-read.json
u-chan github create github-work github-operation.json
u-chan github revoke github-work
```

Read request examples:

```json
{"resource":"repository"}
```

```json
{"resource":"issues","state":"open","page":1}
```

Other resources are `issue` with `number`, `pull_requests` with optional `state`/`page`, `pull_request` with `number`, and `workflow_runs` with optional `page`. List pages contain at most 10 items. Individual body text is capped and reports `bodyTruncated`. The issues endpoint can also include PRs. The CLI `test` command performs the approved repository metadata read; it does not prove write permissions.

Create examples:

```json
{"type":"issue_create","title":"Fix keyboard focus","body":"Describe the user-requested issue here."}
```

```json
{"type":"pull_request_create","title":"Improve keyboard focus","body":"Describe the existing branch changes here.","head":"fix/keyboard-focus","base":"main"}
```

## Outcomes and revocation

Creation can notify repository participants. It is dispatched at most once per approved invocation. Timeout, disconnect, server failure, malformed success, or branch movement during creation may leave an uncertain outcome; inspect the repository before proposing another create. GitHub does not offer an atomic branch-tip precondition for PR creation: a changed returned tip is reported as uncertain, and the created draft is retained.

Revocation prevents later access but cannot undo a dispatched request or completed change. Connection policy is stored in protected `github-allowlist.json`, bound to the repository's numeric ID, with a protected snapshot before the first policy mutation. Tokens remain in Bitwarden and privileged service memory. Existing `u-chan manage` pages cover website and Discord grants; use the GitHub CLI or MCP revoke operation for GitHub policy management.

Agents receive `github_request_allow`, `github_list_allowed`, `github_read`, `github_create`, and `github_revoke`, plus `request_unlock`. GitHub brokerage initially requires Windows protected review. See [validation scope](superpowers/research/2026-11-06-agent-unlock-github-validation.md); source support does not imply installed or live GitHub verification.
