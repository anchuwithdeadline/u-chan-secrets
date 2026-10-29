# Windows permission diagnostic timeout

Date: 2026-10-29. Original installed version: 4.0.0.

## Reproduction

Repeated live doctor checks returned `permissions: unknown` while the service, authenticated IPC, installed version, browser, UAC, and private assets passed.

An independent elevated full-tree audit inspected 36,707 items: 30,457 under protected backups, 5,919 under the program directory, and 331 elsewhere. It found zero unsafe owner/allow-rule entries and zero reparse points. Administrator-owned receipt: `C:\ProgramData\UChanSecurityChecks\d49aa63e-4125-4980-a9e3-048db1cd4ba9\report.json`.

A disposable SYSTEM task ran the exact installed permission function twice. Its original 15-second child-process deadline killed PowerShell after 15,123 ms and returned `unknown`. The identical scan with only its child timeout extended completed in 16,508 ms, printed `SAFE`, and returned `pass`. Receipt: `C:\ProgramData\UChanSecurityChecks\c4f09a22-732f-4e09-af58-64db9293419d\report.json`. The disposable task was removed after completion.

## Correction

Version 4.0.1 allows 60 seconds for the native scan, 65 seconds for the service wrapper, and 70 seconds for the outer diagnostic/IPC deadline. It does not skip backups or change ACL acceptance rules. Unsafe owners, unexpected allow rules, reparse points, execution errors, and deadline expiry retain their fail/unknown behavior.

Regression checks exercise successful 45-second scans through both enclosing diagnostic layers. Publication and installed verification are recorded separately after those steps occur. macOS native runtime and current AI-session browser ownership remain unverified.
