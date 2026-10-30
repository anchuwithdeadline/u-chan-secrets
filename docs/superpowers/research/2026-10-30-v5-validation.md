# V5 Windows validation

Scope: documented Windows host, Chrome and Edge desktop destinations. macOS native runtime remains unverified. Source, CI, packaged artifact, native fixture, installation, and active AI-session ownership are separate claims.

## Implementation and independent review

V5 retains protocol 3, protected-state schema 3, the five public MCP tools, existing grant consumption/concurrency behavior, native prompt/auth/service helper sources, and runtime dependencies. It adds per-user browser choice, native destination validation, explicit browser binding, private network enforcement, and independent transferred-session evidence.

The first whole-branch review covered `7d3dc31..11261b0`. It rejected that candidate for a multi-hop redirect bypass, owned-tab cleanup on cancellation, OTP-only challenge transfer, quoted-decoy profile parsing, and missing login/browser binding. That candidate was never executed as SYSTEM, installed, or published. Its protected staging copy remains a backup. Disposable user-side browser preparations expired and closed their own instances while review was pending.

Each finding was reproduced with a failing test and corrected before release. Private traffic now uses a per-context HTTP/CONNECT proxy; HTTP/2 and QUIC are disabled in private Chromium. Owned desktop tabs use request-stage CDP document interception rather than rewritten redirect responses. Native command lines use Windows tokenization. Browser kind is bound through additive IPC fields, with legacy missing fields meaning Chrome; stale MCP environment versus saved choice refuses login. All destination operations repeat native owner/profile validation, and cancellation closes tracked owned pages before disconnecting.

Approved site metadata and success conditions remain authoritative. General SSO, automatic CAPTCHA solving, protected challenge continuation, and invalidating existing desktop sessions remain outside scope. An unrelated updater response/acknowledgement issue remains separately documented by V4.0.1 rollout evidence.

## Local evidence

- Initial implementation: 407 existing/added tests passed, plus build and whole-project type checks.
- After the review fix pass: all 416 tests passed across 56 files. The final CI/fixture fixes passed 417 tests across 56 files, build, whole-project type checks, and diff checks.
- Implementation commit `2937040` passed [Windows/macOS CI](https://github.com/anchuwithdeadline/u-chan-secrets/actions/runs/40994624379) and [CodeQL](https://github.com/anchuwithdeadline/u-chan-secrets/actions/runs/40994617917), including the proxy request-forgery gate. Plain HTTP forwarding is disabled in production; injected fixtures are restricted to one exact loopback origin. Canonical temporary fixture paths account for macOS aliases and Windows short paths without weakening production path checks.
- Added fix-pass regressions cover multi-hop 302/303/307/308 navigation, credential-bearing 307 chains, fetch/frames/subresources/workers, owned-tab cancellation and delayed page creation, OTP-only/post-OTP challenges, quoted native arguments, exact Edge IPC binding, and pre-reservation mismatch refusal.
- A disposable local TLS fixture verified an allowed HTTPS tunnel, blocked multi-hop HTTPS destination, HTTP/1.1-only negotiation, and continued default rejection of an untrusted certificate. Only the positive self-signed fixture context used `ignoreHTTPSErrors`; production settings retain normal certificate validation. No test keys were printed or committed.
- A parallel-suite PowerShell startup timeout exposed a test-harness cleanup issue. The fixture now backs up/restores only its DACL and allows bounded startup time without requesting audit/SACL privileges. The production ACL assertion remains unchanged.

Final suite counts, exact-head CI, real per-browser SYSTEM reports, public artifact signatures/hashes, and installed-state comparisons are recorded below only after execution. No active-session or macOS runtime result is inferred from unit tests or configuration discovery.

## Disposable Windows browser matrix

Candidate D was frozen from implementation commit `2937040`: SHA256 `bf6e5dfe7f5b8c9b27e4a0928d9641faa2a43782bf643e12901a7382234e2b27`, 84 files, 97,281 bytes. Staging independently checked its archive, unchanged native helper bytes, and unchanged runtime dependencies before SYSTEM execution. The live service was not replaced by this rehearsal.

| Observation | Chrome | Edge |
| --- | --- | --- |
| Run ID | `428e2aa2-f605-4440-9a06-e1680d47546b` | `b463683d-1113-4bde-be55-44bc188698d5` |
| Dedicated owner/profile identity; wrong-browser refusal | Passed | Passed |
| Confirmed private login and verified transferred session | Passed | Passed |
| Shared input events; instrumentation positive controls | 0; passed | 0; passed |
| Once-grant concurrency and persisted clock rollback | Passed | Passed |
| Normal HTTPS certificate validation | HTTP 200, TLS 1.3 | HTTP 200, TLS 1.3 |
| Native processes/modules inspected | 11 / 185 | 12 / 185 |
| Outside or unreadable live modules | 0 / 0 | 0 / 0 |
| Signed registry/update rehearsal | Passed | Passed |
| Dummy-secret scan | 0 matches in 3 scoped artifacts | 0 matches in 3 scoped artifacts |

Both reports observed private Bitwarden and browser processes and verified two Defender modules. The input controls include a separate CDP connection. Both user-side coordinators passed fresh Playwright MCP connections with 25 tools and shared tab listing, then closed only their own verified disposable browsers. These fixtures use dummy credentials and fresh profiles; they do not claim arbitrary website compatibility or ownership by this already-running AI session.

Candidate A was rejected for review findings. Candidate B was rejected because concurrent testing left transient test executables in the archive. Candidate C passed the functional matrix but used a brittle page-heading assertion for its public TLS probe; Candidate D uses actual response security details with normal browser validation. All candidates and evidence remain retained separately.

## Publication and Windows installation

- [PR #15](https://github.com/anchuwithdeadline/u-chan-secrets/pull/15) merged as `7e605d9c8db79163b614bf42b325a6e29620c4ec`. Its documentation head passed [Windows/macOS CI](https://github.com/anchuwithdeadline/u-chan-secrets/actions/runs/40995123156) and [CodeQL](https://github.com/anchuwithdeadline/u-chan-secrets/actions/runs/40995120228); the [main CI](https://github.com/anchuwithdeadline/u-chan-secrets/actions/runs/40995404724) also passed.
- Public npm `latest` and `next` both resolve to `5.0.0`. Registry signature and SHA512 integrity verification passed. Public artifact SHA256 is `e837db7a5d42bca86a03f78aea65148c1861f2d9e913b259c70e33783a5e0eaa` (84 files, 97,298 bytes). Compared with SYSTEM-tested Candidate D, only README bytes differ; all compiled and script bytes are identical.
- The stable [GitHub V5.0.0 release](https://github.com/anchuwithdeadline/u-chan-secrets/releases/tag/v5.0.0) targets the merge commit and carries the same artifact digest.
- Protected settings, grants, and Bitwarden data were backed up under protected `#0 backup` before update. The previous global CLI and shims were backed up separately. The supported signed updater installed service `5.0.0`; its initiating CLI connection closed during restart, so installation was checked independently. All 63 installed compiled files match the public artifact. The matching global CLI was installed from public npm; all 84 package files match byte-for-byte. A subsequent update reports `already up to date (version 5.0.0)`.
- Protected settings and grants remain byte-identical to their baseline. A privileged read-only comparison resolved Bitwarden cache byte drift: only `global_config_byServer` differs, containing one changed feature-state boolean and a later `utcDate` timestamp. Every other stored Bitwarden field matches the pre-upgrade baseline. This is server-configuration metadata drift; the observed change does not affect stored vault/account fields. Reports contain field names, types, counts, and equality checks without secret values. No vault unlock or real credential retrieval was performed for these checks.
- With explicit user approval, only the verified dedicated Chrome instance on port 9222 was closed. Normal Chrome remained open. `setup --browser edge --apply --replace-existing --start-browser --json` saved Edge, backed up Codex configuration, and registered matching `U_CHAN_BROWSER=edge` and loopback `U_CHAN_CDP` values. Playwright retains the matching endpoint. Other users still default to Chrome unless they choose otherwise.
- Final doctor checks pass for matching versions, authenticated IPC, service assets/permissions, UAC policy, locked vault, browser target, and the actual dedicated Edge executable/owner/profile. Fresh processes expose exactly five U-Chan tools and 25 Playwright tools, with shared Edge tab listing succeeding.

The already-running AI session must restart to load the saved registrations. Doctor continues to report Playwright configuration/session sharing as unknown where current ownership cannot be established; the successful fresh-process check is a separate observation. macOS native runtime and general website/SSO compatibility remain unverified.
