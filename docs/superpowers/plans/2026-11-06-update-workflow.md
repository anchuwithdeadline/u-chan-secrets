# Coordinated Update Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user already selected native execution in this session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make compatible published updates one command with progress, observed readiness, retained recovery copies, and verified service recovery.

**Architecture:** A normal-user CLI coordinates one signed release with an authenticated service update job. The service stages a compatible release and launches a stable protected worker that outlives the old service child. The worker retains the previous program, restarts the child through the existing service host, and watches a protected readiness acknowledgement written only after an authenticated owner request reaches the new service.

**Tech Stack:** Existing TypeScript/Node standard library, verifier, Zod, authenticated IPC, Windows service manager, and Vitest. No new runtime dependency or native helper change.

**Spec:** `docs/superpowers/specs/2026-11-06-update-workflow-design.md` (approved).

## Global Constraints

- Keep signature, integrity, repository-policy, schema, dependency, native-helper, runtime, and protected-path gates.
- Initial scope is compatible published releases on Windows. Native/dependency/runtime changes require trusted reinstall before component mutation.
- Do not expose an arbitrary local-archive/path privileged update API. The service resolves and verifies exact registry versions itself.
- No automatic downgrade or same-version replacement of unknown local builds. Version equality alone is not artifact identity.
- Desktop-only updates do not restart the service. A required service restart clears its in-memory vault unlock; do not request passwords during updates.
- Stage before stopping/restarting. Keep recovery programs and journals; no automatic historical backup deletion.
- Do not run normal-user npm, MCP configuration clients, or browsers as SYSTEM.
- Preserve unrelated files and the existing untracked `#0 backup` and `.playwright-mcp` directories.
- Retain the previous connection-test commit as the base; no push, publication, or production replacement is implied by source implementation.

## Review Focus

- A service-host stop kills the current child process tree: the recovery worker must survive the old child and must not be killed with it.
- SYSTEM cannot use the owner-only IPC authorizer: readiness must preserve authorization without granting general new IPC access.
- Same version, different artifact: return identity unknown/local build rather than replacing or claiming a verified match.
- Desktop install failure after service success: report partial state and recovery information, not whole-update success.
- Client interruption or duplicate invocation: reconnect to one journaled job; never launch a competing replacement.

---

### Task 1: Read-only release inspection and update contracts

**Files:** Create `src/service/update/release.ts`, `src/service/update/protocol.ts`, `test/update-release.test.ts`, `test/update-protocol.test.ts`; extend existing verifier only where exact target metadata is needed.

**Interfaces:** `ReleaseIdentity = { version: string; integrity: string }`; `inspectRelease(tarball: Buffer): ReleaseManifest`; strict `UpdatePlan`, `UpdateJob`, `UpdatePhase`, and receipt schemas. Plans include desktop/service identity, target, compatibility, required work, and fixed next-action code. Phases: `checking`, `verifying`, `staging`, `ready_to_apply`, `switching`, `waiting_for_service`, `service_ready`, `updating_desktop`, `complete`, `failed`, `rolled_back`, `recovery_required`, `partial`.

- [ ] Write failing tests for unsafe archive paths/links, malformed metadata, incompatible helpers/dependencies/runtime, and same-version unknown identity.
- [ ] Run `rtk npm test -- test/update-release.test.ts test/update-protocol.test.ts`; observe missing behavior.
- [ ] Inspect verified archives in memory using standard library facilities: maximum compressed input 32 MiB, expanded content 64 MiB, 2,000 members. Accept only regular files/directories under approved package paths; reject links, traversal, absolute/Windows-special paths, ambiguous duplicate/case-colliding members, and unsupported metadata formats. Never extract merely to answer `--check`.
- [ ] Compare package name/version, required entry files, native helper bytes, exact dependency declarations, and supported runtime against the installed active program. Missing protected evidence fails closed. Return typed fixed findings, not raw archive content or errors.
- [ ] Rerun targeted tests; require PASS.

### Task 2: Protected transaction journal and maintenance admission

**Files:** Create `src/service/update/journal.ts`, `src/service/update/gate.ts`, `test/update-journal.test.ts`, `test/update-gate.test.ts`; modify `src/service/grants.ts`, `src/service/policy-approver.ts`, and `src/service/manage.ts` for narrow busy-state accessors.

**Interfaces:** `UpdateJournal.create(job)`, `read(jobId)`, `transition(jobId, phase, fields)`; protected paths derive from a validated UUID. `UpdateGate.tryPause(): boolean`, `resume()`, and `blocked`. Grant/approval/management busy accessors let the coordinator refuse switching while prior work or protected windows are active.

- [ ] Write failing tests for malformed/oversized journals, unsafe links/ACL prerequisites, duplicate jobs, incompatible phase transitions, and credential-operation admission races.
- [ ] Run targeted tests; observe failure.
- [ ] Persist bounded JSON atomically under protected update transaction directories. Store only fixed phase/error codes, timestamps, versions/integrity, relative backup identity, and immutable transaction parameters. No environment values, credentials, raw registry bodies, or caller-chosen protected paths.
- [ ] Make the final busy-check and pause synchronous in one event-loop turn. If earlier grants/prompts/management are active, fail as busy without changing the active installation. New credential/control operations are rejected during switching; capabilities, safe job status, and readiness acknowledgement remain available.
- [ ] Retain journals and rollback programs; never clean historical backups implicitly.
- [ ] Rerun targeted tests; require PASS.

### Task 3: Stable compatible-update worker and rollback

**Files:** Create `src/service/update/worker.ts`, `src/service/update/worker-main.ts`, `test/update-worker.test.ts`; extend existing `src/service/update/updater.ts` through shared release/compatibility helpers without removing legacy security gates.

**Interfaces:** `runUpdateTransaction(jobId, deps): Promise<UpdateJob>` consumes only a validated protected journal. Production worker dependencies implement private filesystem staging, parent handoff, child readiness, service recovery, and permission checks; tests inject disposable implementations.

- [ ] Write failing fault tests for every switch/restart/rollback boundary, worker launch failure, parent death, readiness timeout, missing backup, rollback failure, and metadata preservation.
- [ ] Verify failures, then implement protected staging from the service-verified exact artifact. Revalidate active code/dependency ownership and links before reuse. Protect/verify new staging and worker paths; do not walk historical backup trees.
- [ ] Copy the stable worker code/runtime dependencies into a protected transaction runtime before launch. Validate all derived resolved paths stay within the protected service home and refuse unexpected links. The worker must not depend on a program path being replaced.
- [ ] Reuse unchanged private dependencies, preserve stable state outside the program directory, and store the verified release receipt in the incoming program. Generate immutable random handoff/readiness nonces inside protected state.
- [ ] Atomically move the old program into a unique retained recovery directory, verify the moved program, and activate the new program. Restore immediately if the second move fails.
- [ ] Production launch uses a hidden detached worker with closed desktop-facing stdio. Do not initially call SCM stop while the worker is still a descendant of the old child: the existing native service host uses `taskkill /T`. Switch the program while the old child is paused, signal it to exit only after activation, and confirm its exit before recovery operations that may stop the service host.
- [ ] Wait up to 90 seconds for protected new-service readiness acknowledgement; poll every 500 ms. On failure, stop the now-current service child/host safely after orphaning, restore the saved program, restart it, and verify old-program readiness for another 90 seconds. Never kill unrelated processes or modify native helper bytes.
- [ ] Preserve source identity as unknown when the saved local build had no signed receipt; recovery verifies the saved program and observed old service, without inventing an artifact identity.
- [ ] Report `recovery_required` if restoration or old-service readiness fails. Keep all evidence/recovery paths and return fixed safe errors. Power loss or worker death leaves a durable recovery journal and an explicit trusted recovery action; client cancellation alone does not cancel a dispatched transaction.
- [ ] Rerun targeted tests; require PASS.

### Task 4: Service coordinator, immutable boot identity, and IPC status

**Files:** Create `src/service/update/coordinator.ts`, `test/update-coordinator.test.ts`; modify `src/service/main.ts`, `src/service/control.ts`, `src/core/types.ts`, `src/ipc/protocol.ts`, `src/ipc/server.ts`, `src/ipc/client.ts`.

**Interfaces:** Optional coordinated update API methods: `planUpdate()`, `beginUpdate(target: ReleaseIdentity)`, `updateStatus(jobId: string)`, `activateUpdate(jobId: string)`, `confirmUpdateReady(jobId: string)`. Add `coordinated_update` capability. Keep website/Discord APIs and existing owner authorization intact.

- [ ] Add failing tests for old-service capability refusal, target drift, incompatible targets before mutation, conflicting jobs, response-before-handoff ordering, owner-only readiness acknowledgement, and status after reconnect.
- [ ] Stage one independently verified exact registry target, journal its progress, and return/attach to the existing job. Do not trust a desktop-provided digest without verifier equality. One active privileged update at a time.
- [ ] Add strict bounded IPC argument validation. A response-written hook triggers activation only after the owner receives an accepted job response; the protected worker handoff then determines when the old process exits. Write audit intent before activation and keep error/status payloads fixed.
- [ ] Capture package/receipt identity once at service boot. A readiness request must match the active job and this immutable boot identity; an old process cannot acknowledge a newly written receipt by rereading it. Write the protected readiness marker only after the service is listening and authenticated owner IPC has reached that boot instance.
- [ ] Keep the SYSTEM worker out of the owner-only general IPC API. It observes protected journal/marker state; the normal-user CLI confirms readiness through existing authenticated IPC. Do not broaden SID authorization.
- [ ] On boot, admit safe status/readiness only for a pending switch and block credential work until resolution. Return exact versions/integrity in capability/status metadata without fetching vault credentials.
- [ ] Refuse coordinated apply on macOS initially; keep read-only plan and existing legacy paths explicit. Existing services without the capability require one trusted bootstrap rather than unsafe fallback.
- [ ] Rerun service/IPC/control/grant/approval/management tests; require PASS.

### Task 5: Normal-user update command and desktop package adapter

**Files:** Create `src/client/update.ts`, `src/client/update-package.ts`, `test/client-update.test.ts`, `test/update-package.test.ts`; modify `src/cli.ts`, plus CLI tests.

**Interfaces:** `runCoordinatedUpdate(options: { checkOnly: boolean }, deps): Promise<ToolResult>`; desktop adapter independently verifies the exact release, retains an existing desktop rollback package, installs the verified artifact as the normal user with package scripts disabled, repairs recognized managed launchers, and verifies installed package identity.

- [ ] Write failing tests for `--check` with no mutation, desktop-only update with zero service restarts, service target readiness before desktop installation, partial npm failure, Ctrl+C/reconnect, unknown local identities, and duplicate invocation attachment.
- [ ] Run targeted tests; observe failure.
- [ ] Implement `u-chan update --check` and `u-chan update`, with fixed phase labels plus elapsed time and a final typed summary. Poll safe status every 1 second; give explicit in-progress/reconnect guidance on client interruption or a 15-minute client observation deadline. Do not assert cancellation.
- [ ] Keep the protected journal authoritative for the service transaction. Store desktop progress/rollback-package identity in a bounded normal-user checkpoint and label it as client-observed; do not give desktop callers permission to write protected journals. Combine both records on reconnect. Use a normal-user exclusive update lock so duplicate CLI processes attach instead of concurrently invoking npm; final verification rechecks both component identities.
- [ ] Prepare/verify the desktop target and rollback artifact before service activation. Coordinate the exact same target version/integrity with service preflight. Do not mutate either component when compatibility fails.
- [ ] For a service change, poll capabilities and confirm readiness against the immutable target identity. For a desktop-only change, do not dispatch service activation, restart, lock, or unlock.
- [ ] Install the user package only after service readiness, using typed subprocess arguments and no arbitrary caller flags. Retain rollback artifacts; on failure return `partial` with observed component states and a concrete retry action. Do not overwrite unrelated user configuration.
- [ ] Preserve current MCP/browser registrations and use existing managed-launcher safeguards. Report session restart requirements; never launch a browser, change UAC, or open password prompts during update.
- [ ] Rerun CLI/setup/update tests; require PASS.

### Task 6: Documentation, review, and bounded validation

**Files:** Modify `README.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/attack-checklist.md`; create `docs/superpowers/research/2026-11-06-update-workflow-validation.md`.

- [ ] Document compatible scope, trusted bootstrap, signature checks, phase/status/reconnect behavior, retained recovery copies, unknown local builds, vault lock semantics, macOS limitation, partial desktop failure, and trusted recovery instructions.
- [ ] Run full tests, whole-project TypeScript, build, and diff checks. Require PASS; retain separate evidence for each.
- [ ] Obtain one independent whole-change security review after native implementation, address actionable findings with regressions, and rerun affected checks.
- [ ] Prepare disposable Windows worker/service fixtures with fake credentials and test-signed archives; keep test trust injection outside production entry points. Verify actual worker survival, parent exit, target startup, rollback startup, permissions, metadata preservation, and status reconnect. Label any unavailable native check explicitly.
- [ ] Do not replace the real installed service, publish, push, or delete backups as part of source validation without the applicable user instruction. Keep the real approved Discord connection intact.
- [ ] Commit only scoped verified source and report source tests, native fixtures, installed rollout, CI, and publication as separate outcomes.

## Execution handoff

Native execution remains selected. This plan adds no new user-facing scope beyond the approved design; it resolves worker lifetime, owner-only readiness, archive inspection, and partial desktop failure. The Writing Plans skill requires plan review before implementation. Preserve the already selected execution method rather than asking the user to choose again.
