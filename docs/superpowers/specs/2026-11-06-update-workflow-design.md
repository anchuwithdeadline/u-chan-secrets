# Coordinated U-Chan update workflow

Status: scope approved by the user on 2026-11-06. Native execution in the current session remains the selected method. Implementation plan follows separately.

## Problem and evidence

The local upgrade required separate desktop package installation, service replacement, setup repair, readiness checks, and repeated unlocks. Version 5.1.0 also identifies several different local source builds, so a source push or matching version strings alone do not establish an installed release.

Current source confirms:

- `u-chan update` delegates only to `ControlApi.update`; it does not coordinate the desktop package.
- `ServiceUpdater.swapDirs` deletes the old program backup after directory replacement, before any restarted-service health result.
- The update result says “updated … restarting service”; the restart implementation only exits the current service process.
- The Windows installer stops the service before staging and repeatedly normalizes the entire protected tree, including retained backups.
- Discord's first state write also normalizes the service home and backup parent recursively.

These observations explain separate usability, recovery, and performance gaps. This first change addresses the update workflow; a general backup/permission performance rewrite is excluded.

## Proposed first release

Keep `u-chan update` as the entry point. Add `u-chan update --check` for a read-only plan.

`--check` reports desktop and service versions, required coordinator capability, target published version and artifact integrity, whether each component needs updating, and whether the release is eligible for the compatible update path. It must not unlock the vault, retrieve credentials, mutate grants, update packages, or restart anything.

For compatible published releases, `update` stages and verifies one exact target artifact, updates the components that need it, waits for startup, verifies the installed target, and prints a final result. Existing signature, integrity, repository-policy, schema, dependency, and native-helper checks remain mandatory. The service independently verifies the same target; it never trusts a desktop assertion that a package is verified.

The initial scope is automatic compatible desktop/service updates. Native-helper, runtime, or dependency changes fail during preflight before component mutation, with an explicit trusted-reinstall instruction. This project does not remove the existing native/dependency trust boundary or promise unattended upgrades of every future release. The first installation of the coordinated updater itself needs the existing trusted bootstrap path.

No automatic downgrade to npm `latest` when a newer local build is installed. Matching version numbers with unknown/different artifact identity produce an explicit local-build/unknown result, not a false claim that a source change was installed. Unpublished source is not a signed published update. A generic local-archive privileged install option is excluded.

## User-visible flow

1. Check installed components and eligible target.
2. Verify and stage the exact release without stopping the current service.
3. Update/restart the service only if needed.
4. Wait for authenticated service readiness at the target version/artifact identity.
5. Update the normal-user desktop client to the same verified target if needed.
6. Preserve the managed command launcher and existing MCP/browser configuration; repair only recognized generated entries when necessary.
7. Report verified versions, artifact identity, rollback availability, vault state, and whether the active agent session must restart.

Every phase has a fixed safe label and elapsed time. Long operations expose progress/status so the client does not look frozen. `Ctrl+C` or client timeout does not imply a dispatched privileged update was cancelled; reconnecting can retrieve its status. Repeated invocations attach to the existing update job or report busy, never start conflicting replacements.

Desktop-only changes leave the service and vault session running. A service restart intentionally clears the in-memory vault session; update verification works while locked. Do not open unlock prompts automatically or retry a password. Later credential use requests one protected unlock through the existing path.

## Recovery and honest results

Keep the previous protected program until the target has passed readiness checks; retain it afterward as a manual recovery copy. Do not silently delete old recovery copies as part of this change. Preserve settings, website grants, Discord connections, vault data, browser selection/profiles, and MCP settings.

Record bounded, non-secret transaction state under the protected service home: job ID, source/target versions and integrity, fixed phase, timestamps, backup identity, and final outcome. Derive all protected paths from that state, never from arbitrary caller input. Keep raw credentials, environment values, registry response bodies, and raw exception text out of progress/status.

A stable protected update worker must remain available while the main service restarts. It stages/switches only verified compatible program content, waits for actual readiness, and restores the saved program if startup fails within the defined deadline. It must survive replacement of the active program directory. Admit no new credential operations during the switch; either finish earlier work first within a bounded wait or refuse the update as busy without altering the active installation.

If the desktop update fails after service success, preserve its rollback package and report a partial result with a concrete retry/recovery action. Do not label the whole update successful or silently restore over unrelated user configuration. Initial scope does not promise an atomic transaction across Windows service files and npm's user-level package installation.

A service readiness failure restores the previous program before claiming recovery. If restoration or old-service restart fails, report `recovery_required` and the retained recovery location. Never claim rollback succeeded from a file move alone. No live token/API call is required for update health verification.

## Platform and implementation constraints

Windows-first native runtime verification. Preserve existing macOS paths; either implement and verify the same coordinator semantics there or explicitly refuse coordinated application on macOS while retaining read-only planning. Do not imply Windows tests establish macOS runtime behavior.

Reuse the current verifier, authenticated IPC, service manager, and setup safeguards. Add no runtime dependency or general workflow engine. Exact module split and status transport are implementation choices. Keep protected metadata out of desktop-readable logs. Run normal-user package/MCP configuration commands only as that user; never execute user-owned npm, MCP clients, or browser code as SYSTEM.

Do not recursively rescan or repair historical backup trees on each compatible update. Verify the active executable/dependency paths being reused and protect/verify new staging/transaction paths. Refuse unsafe owners, ACLs, links/reparse points, or unknown permissions rather than weakening protection. Initial migration/security repair and full deep diagnostics remain separate operations.

## Acceptance and validation

- A compatible update needs one user command, with visible phases and a final observed readiness result.
- Desktop-only updates do not restart or relock the service.
- Target drift, unsigned/unverified archives, unsafe paths, incompatible dependencies/helpers, concurrent updates, malformed journals, interruption, and startup failure fail safely.
- Fault-injection tests cover staging, directory switch, restart timeout, rollback/restart failure, desktop installation failure, and reconnect/status behavior.
- Protected state preservation and existing website/Discord functionality retain regression coverage. Mock tests and source compilation remain separate from native installed verification.
- Validate with disposable signed-package/update fixtures before any real release change. Do not publish, push, replace the installed service, delete backups, or change real Discord resources merely to prove source behavior without the applicable user authorization.

## Calls proposed for approval

Prioritize one command, progress, readiness, and recovery over a broad installer rewrite. Keep native/dependency changes on the trusted-reinstall path for this first version. Keep the vault locked after a required service restart until the user needs credential access. Retain recovery copies and expose cleanup separately in future work.
