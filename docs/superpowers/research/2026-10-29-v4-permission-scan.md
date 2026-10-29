# Windows permission diagnostic timeout

Date: 2026-10-29. Original installed version: 4.0.0.

## Reproduction

Repeated live doctor checks returned `permissions: unknown` while the service, authenticated IPC, installed version, browser, UAC, and private assets passed.

An independent elevated full-tree audit inspected 36,707 items: 30,457 under protected backups, 5,919 under the program directory, and 331 elsewhere. It found zero unsafe owner/allow-rule entries and zero reparse points. Administrator-owned receipt: `C:\ProgramData\UChanSecurityChecks\d49aa63e-4125-4980-a9e3-048db1cd4ba9\report.json`.

A disposable SYSTEM task ran the exact installed permission function twice. Its original 15-second child-process deadline killed PowerShell after 15,123 ms and returned `unknown`. The identical scan with only its child timeout extended completed in 16,508 ms, printed `SAFE`, and returned `pass`. Receipt: `C:\ProgramData\UChanSecurityChecks\c4f09a22-732f-4e09-af58-64db9293419d\report.json`. The disposable task was removed after completion.

## Correction

Version 4.0.1 allows 60 seconds for the native scan, 65 seconds for the service wrapper, and 70 seconds for the outer diagnostic/IPC deadline. It does not skip backups or change ACL acceptance rules. Unsafe owners, unexpected allow rules, reparse points, execution errors, and deadline expiry retain their fail/unknown behavior.

Regression checks exercise a successful 45-second native command and both enclosing diagnostic layers. Windows/macOS CI, CodeQL, build, and whole-project TypeScript checks passed before merge.

## Publication and installed verification

Completed on 2026-10-30 local time. npm `latest` and `next` point to 4.0.1. The production verifier accepted its public registry signature and integrity; SHA-256 is `a208f2ab6f23e0eec9b738bbcc94b4781af3170b0baee34d140154bcf649e0e5`. The stable GitHub release is [v4.0.1](https://github.com/anchuwithdeadline/u-chan-secrets/releases/tag/v4.0.1).

The Windows service applied the signed update. That invocation reported `U-Chan service closed the connection` during restart, so its exit status alone did not prove success. Independent checks then confirmed installed version 4.0.1, all 59 compiled files matching the verified artifact, and unchanged protected settings, grants, and private vault data against a fresh pre-update backup. Administrator-owned receipt: `C:\ProgramData\UChanSecurityChecks\edb33c2d-ce8b-416f-a7b8-4ceec00eecc0\report.json`. A later updater call returned `already up to date (version 4.0.1)`.

The global CLI was installed from public npm; all 77 packaged files match the verified artifact. Live doctor checks returned exit 0 with every required check passing, including the previously unknown permission scan. Read-only setup also reported `configured`, client `ready`, and no configuration changes. Fresh MCP checks observed version 4.0.1, exactly five expected U-Chan tools, and successful shared-Chrome tab listing through a separate Playwright MCP process. The vault remains locked. macOS native runtime and current AI-session browser ownership remain unverified; restart the AI session after the earlier MCP configuration change.
