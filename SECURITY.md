# Security Policy

U-Chan Secrets handles real-world credentials, vault access, and automated authentication. Security reports are taken seriously and prioritized.

---

## Reporting a Vulnerability

Please do **not** open a public issue. Report vulnerabilities privately via GitHub Security Advisories:

👉 **[Report a Vulnerability](https://github.com/anchuwithdeadline/u-chan-secrets/security/advisories/new)**

### Vulnerability Report Details
Please include:
- A clear description of the vulnerability and attack vector.
- Step-by-step reproduction instructions or proof-of-concept scripts.
- The affected operating system (Windows / macOS) and approval mode (Easy / Hardcore).
- Impact assessment of what an attacker or compromised agent could gain.

### Response SLA
You will receive an initial response within **7 days** of submission, followed by regular status updates as fixes are investigated, verified, and released.

---

## V2 Security Scope & Adversarial Threat Model

### Adversarial Model: Compromised AI Assistant
U-Chan Secrets V2 operates under an explicit zero-trust model regarding the AI assistant (Claude Code). We assume the AI assistant may be:
- Tricked by direct or indirect prompt injection from malicious webpages or repository files.
- Operating in bypass permissions mode (`--dangerously-skip-permissions`).
- Actively adversarial, attempting to exfiltrate credentials or escalate privileges.

### Attacker Capabilities
Under this threat model, the compromised agent possesses:
1. **Full User Shell:** Arbitrary command execution with the privileges of the host user account (via PowerShell, bash, cmd, Node, Python).
2. **User File Read/Write:** Full access to the user's home directory (`~`, `%USERPROFILE%`), temporary directories, environment variables, and dotfiles.
3. **Full Browser Automation:** Direct CDP control over the user's Google Chrome instance via Playwright MCP (`browser_evaluate`, page manipulation, DOM script injection).
4. **Arbitrary MCP Tool Invocations:** Ability to invoke any exposed MCP tool (`request_allow`, `login`, `status`, `list_allowed`, `revoke`) with arbitrary arguments.

### Out of Scope (Non-Goals)
- **Legitimate Post-Login Session Misuse:** Once authenticated, the AI is permitted to browse the site using the session cookies injected into Chrome. Defending against destructive actions taken within an authorized session is the responsibility of the target website's authorization model.
- **Denial of Service:** Claude deleting its own MCP config, user-side scripts, or killing local processes.
- **Pre-Existing Host Compromise:** Defending against attackers or malware already possessing `SYSTEM` or `root` administrative rights.
- **Physical Device Access:** Direct keyboard/hardware interception by someone physically present at the computer.

---

## Security Boundaries & Defenses

U-Chan Secrets V2 maintains six distinct security boundaries to protect credentials against a compromised agent:

```
+-------------------------------------------------------------------------+
|                              USER BOUNDARY                              |
|  Compromised Claude Code / Shell Scripts / User Chrome / Playwright MCP |
+-------------------------------------------------------------------------+
       |                                                    |
   (1) | Local IPC with Peer Auth                       (5) | Session Injection (CDP)
       v                                                    v
+-------------------------------------------------------------------------+
|                      PRIVILEGED SERVICE BOUNDARY                        |
|                     (Windows SYSTEM / macOS root)                       |
|                                                                         |
|  +-----------------------+  (2)  +------------------------------------+  |
|  | OS Identity Storage   | <---> | Memory-Only Bitwarden Session Key  |  |
|  | (allowlist, settings) |       | (auto-locks on 12h idle / reboot)  |  |
|  +-----------------------+       +------------------------------------+  |
|                                                                         |
|  +----------------------------------+  +-----------------------------+  |
|  | (3) Protected UI Prompt          |  | (4) Anti-Phishing Phrase    |  |
|  | (UIPI / Cocoa Secure Event Input)|  | (verifies authentic window)|  |
|  +----------------------------------+  +-----------------------------+  |
|                                                                         |
|  +----------------------------------+  +-----------------------------+  |
|  | Isolated Headless Browser        |  | (6) Signed Self-Update      |  |
|  | (internal login execution)       |  | (registry signature & SHA)  |  |
|  +----------------------------------+  +-----------------------------+  |
+-------------------------------------------------------------------------+
```

### 1. OS Identity Boundary
Sensitive service state—including `allowlist.json`, `audit.log`, `settings.json`, and Bitwarden CLI vault data—is stored in system directories (`%ProgramData%\u-chan-secrets` on Windows, `/Library/Application Support/u-chan-secrets` on macOS) configured with strict ACLs accessible only to `SYSTEM` / Administrators or `root`. Normal user shell commands cannot read or modify these files.

### 2. Memory-Only Session Key
The Bitwarden vault session key (`BW_SESSION`) is retained strictly in service process RAM. It is never written to disk, environment variables, or temporary files. The session automatically wipes and locks upon service restart, OS reboot, manual `u-chan lock`, or a 12-hour idle timeout.

### 3. Protected Window Isolation
All human interactions (unlocking the vault, approving new domains, switching approval modes) take place within protected windows rendered directly by the privileged service:
- **Windows:** WinForms/WPF windows rendered with High Integrity and User Interface Privilege Isolation (UIPI). Normal user processes cannot send synthetic mouse clicks or keystrokes (`SendKeys`, `PostMessage`) or install keyboard hooks.
- **macOS:** Cocoa dialogs utilizing `NSSecureTextField` with `EnableSecureEventInput` to block keystroke monitoring by CGEvent taps. (Note: Synthetic clicks are possible via Accessibility APIs on macOS, which is why macOS enforces Hardcore Mode exclusively).
- **Timeouts & Lockout:** Windows time out after 2 minutes (defaulting to denial). Entering 5 incorrect master passwords locks approvals for 15 minutes.

### 4. Anti-Phishing Secret Phrase
During `u-chan install`, the user configures or generates a personal secret phrase stored in the privileged settings. Every authentic U-Chan prompt displays this phrase prominently. If a compromised AI attempts to spawn a lookalike modal or terminal prompt asking for your master password, the missing or incorrect phrase exposes the attack.

### 5. Isolated Headless Browser (Credential Entry)
Credentials are typed exclusively inside a private, headless Chromium browser managed by the service with no exposed remote debugging port. Once authentication succeeds, only the resulting cookies and `localStorage` for allowlisted origins are transferred into the user's Chrome over CDP. A compromised AI running Playwright init scripts on user Chrome cannot intercept passwords during input.

### 6. Cryptographically Verified Updates
The privileged service manages its own updates via `u-chan update`. When triggered, the service fetches release packages directly from npm, verifying npm registry signatures and SHA-512 integrity hashes before replacing any admin-owned binaries. User-writable npm directories are never executed by the service.

---

## Operating System Prerequisites

### Windows
- **UAC Requirement:** The V2 security boundary holds on Windows **ONLY** if User Account Control is configured to **"Always Notify"** or if Claude Code is executed from a **Standard User account**. Default Windows UAC on administrator accounts allows silent elevation bypasses.

### macOS
- **Hardcore Mode Only:** Because macOS allows Accessibility-enabled applications to send synthetic clicks, Easy Mode is permanently disabled. Approvals always require master password re-entry.

---

## Manual Attack Verification Checklist

To verify these security boundaries against simulated attacks, refer to our comprehensive verification test suite:

👉 **[Attack Verification Checklist](docs/attack-checklist.md)**

---

## Supported Versions

| Version | Supported |
|---|---|
| 2.x (Latest on `main`) | :white_check_mark: |
| 1.x | :x: (Deprecated) |
