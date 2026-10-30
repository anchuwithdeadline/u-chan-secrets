# V5 Windows validation

Scope: documented Windows host, Chrome and Edge desktop destinations. macOS native runtime remains unverified. Source, CI, packaged artifact, native fixture, installation, and active AI-session ownership are separate claims.

## Implementation and independent review

V5 retains protocol 3, protected-state schema 3, the five public MCP tools, existing grant consumption/concurrency behavior, native prompt/auth/service helper sources, and runtime dependencies. It adds per-user browser choice, native destination validation, explicit browser binding, private network enforcement, and independent transferred-session evidence.

The first whole-branch review covered `7d3dc31..11261b0`. It rejected that candidate for a multi-hop redirect bypass, owned-tab cleanup on cancellation, OTP-only challenge transfer, quoted-decoy profile parsing, and missing login/browser binding. That candidate was never executed as SYSTEM, installed, or published. Its protected staging copy remains a backup. Disposable user-side browser preparations expired and closed their own instances while review was pending.

Each finding was reproduced with a failing test and corrected before release. Private traffic now uses a per-context HTTP/CONNECT proxy; HTTP/2 and QUIC are disabled in private Chromium. Owned desktop tabs use request-stage CDP document interception rather than rewritten redirect responses. Native command lines use Windows tokenization. Browser kind is bound through additive IPC fields, with legacy missing fields meaning Chrome; stale MCP environment versus saved choice refuses login. All destination operations repeat native owner/profile validation, and cancellation closes tracked owned pages before disconnecting.

Approved site metadata and success conditions remain authoritative. General SSO, automatic CAPTCHA solving, protected challenge continuation, and invalidating existing desktop sessions remain outside scope. An unrelated updater response/acknowledgement issue remains separately documented by V4.0.1 rollout evidence.

## Local evidence

- Initial implementation: 407 existing/added tests passed, plus build and whole-project type checks.
- After the review fix pass: all 416 tests passed across 56 files. Build, whole-project type checks, and diff checks passed. Exact-head CI remains a separate gate.
- Added fix-pass regressions cover multi-hop 302/303/307/308 navigation, credential-bearing 307 chains, fetch/frames/subresources/workers, owned-tab cancellation and delayed page creation, OTP-only/post-OTP challenges, quoted native arguments, exact Edge IPC binding, and pre-reservation mismatch refusal.
- A disposable local TLS fixture verified an allowed HTTPS tunnel, blocked multi-hop HTTPS destination, HTTP/1.1-only negotiation, and continued default rejection of an untrusted certificate. Only the positive self-signed fixture context used `ignoreHTTPSErrors`; production settings retain normal certificate validation. No test keys were printed or committed.
- A parallel-suite PowerShell startup timeout exposed a test-harness cleanup issue. The fixture now backs up/restores only its DACL and allows bounded startup time without requesting audit/SACL privileges. The production ACL assertion remains unchanged.

Final suite counts, exact-head CI, real per-browser SYSTEM reports, public artifact signatures/hashes, and installed-state comparisons are recorded below only after execution. No active-session or macOS runtime result is inferred from unit tests or configuration discovery.

## Pending release observations

Real Chrome/Edge SYSTEM matrix, public publication, live update, explicit local Edge selection, and final installed verification are pending at this source snapshot.
