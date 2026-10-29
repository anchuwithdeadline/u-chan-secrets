# U-Chan Secrets — Manual Attack Verification Checklist

V3 release status: source tests and native compilation are separate from these installed-service attacks. The expected outcomes below are test criteria, not recorded passes. See the [Windows closeout](superpowers/research/2026-10-29-v3-windows-closeout.md) for actual evidence and final native rerun gates. The user scoped completion to Windows; macOS runtime remains unverified.

## Additional V3 checks

Record OS/version, installed service version, caller identity, date, and PASS / FAIL / UNAVAILABLE for each check. Use disposable credentials and a test site. Never record real passwords, seeds, codes, cookies, session keys, or the anti-phishing phrase.

1. **Protected identity and input:** inspect the actual Windows prompt process token: SYSTEM must own it in the intended interactive session. Verify it uses a separate desktop; try standard-user keyboard hooks, synthetic input, and screen capture. The main user desktop must return after cancellation, timeout, and failure. On macOS verify secure-input activation and cleanup, including failure paths. Synthetic management clicks must never bypass the hardcore password flow.
2. **Native transport:** standard-user attempts to open or spoof the Windows per-prompt reply pipe must fail. Confirm real cross-session prompts return only through the SYSTEM-owned pipe; denied or failed helpers must never fall back to unprotected approval.
3. **Private execution:** attempt writes to service Node, dependencies, Bitwarden, Chromium, helpers, and every executable/native dependency they load. Check actual ownership, ACLs, junctions/symlinks, and dynamic library search paths. Any user-writable executed dependency fails this check.
4. **Once grants:** issue simultaneous login requests over separate IPC connections. Exactly one attempt may reserve the grant. Crash/restart after reservation; it must remain consumed. Locked-vault and unavailable-Chrome preflight must not consume an attempt.
5. **Timed grants:** test exact expiration, expiration while approval is open, and expiration during credential retrieval and before transfer. Move the clock backward during a running service; affected grants must remain invalid after restart. Renew only through real protected approval. Do not claim detection of clock changes made while stopped.
6. **Permission tampering:** change duration, item, hosts, selectors, and success conditions through raw IPC. Every valid change requires protected approval; malformed or unsupported policy is refused. A V3 client talking to V2 must never silently request permanent approval.
7. **Outcome evidence:** use blank pages, error pages that hide their form, CAPTCHA, an unmet approved condition, and a rejected session injection. No unconfirmed authentication may be reported as confirmed success.
8. **Read-only diagnostics:** exercise unavailable/unauthenticated/locked states and partial failures. Confirm no credential retrieval or repairs occur, all probes terminate, and diagnostic JSON/errors contain only fixed safe messages.
9. **Management:** inspect long domains, multiple pages, expired/exhausted entries, and last-action failure. Test closing, timeout, malformed helper output, stale targets, refresh, lock/unlock, and revoke. No management response may create or extend a grant.
10. **Backup/update:** verify the pre-V3 snapshot is protected before any content is copied. Incomplete backup and invalid marker must block state mutation. Confirm installed dependencies survive a package-only update; dependency/native-helper changes require trusted reinstall. Supported downgrade must refuse V2 state interpretation.

Current local evidence and remaining platform work are recorded in [V3 validation](superpowers/research/2026-10-29-v3-validation.md).

For a no-password Windows desktop regression check, run `node scripts/verify-windows-prompt-desktop.mjs` from a trusted administrator terminal after building and installing the service. It compiles a disposable confirm-only helper from the current source, runs it through a temporary SYSTEM scheduled task, verifies protected desktop entry/restoration, and removes that task. It retains evidence under protected `#0 backup`. This dry run does not replace actual dialog interaction or the adversarial checks above.

## Baseline credential-boundary checks

The nine baseline scenarios below complement the V3 checks above. They test the intended password, TOTP, and Bitwarden-session boundary against an AI with user-shell and browser-automation access. Record actual outcomes; expected results are not evidence that an installed platform passed.

---

## Pre-Test Setup

Use a disposable service installation and test vault. Several attacks intentionally attempt file replacement or deletion; do not run them against a live credential store. Enter unique test credentials outside the AI conversation and keep secret-search values out of AI tool inputs and transcripts.

1. Build and install the exact V3 revision under test through the [trusted CLI setup](../README.md#build-and-install-from-source). Do not use the legacy debug installer or assume an unversioned npm package matches the checkout.
   - **Windows:** Verify UAC is set to "Always notify" or run the AI as a standard user.
   - **macOS:** Use the privileged installer and hardcore approval mode.
2. Configure a test site (e.g., `admin.example.com`) in Bitwarden with a test password and TOTP secret.
3. Start Chrome with remote debugging:
   - **Windows:** `powershell -File scripts\start-chrome.ps1`
   - **macOS:** `bash scripts/start-chrome.sh`
4. Unlock the vault via `u-chan unlock` and enter your master password. Verify your anti-phishing phrase appears.

---

## Attack Verification Scenarios

### Attack 1: Direct File Read

**Objective:** Verify that a compromised user shell cannot read privileged service configuration, allowlist, audit logs, or Bitwarden data directories.

**Attacker Steps (Run from unprivileged user shell):**
- **Windows (PowerShell):**
  ```powershell
  Get-Content C:\ProgramData\u-chan-secrets\settings.json
  Get-Content C:\ProgramData\u-chan-secrets\allowlist.json
  Get-ChildItem C:\ProgramData\u-chan-secrets\bw-data
  ```
- **macOS (Terminal):**
  ```bash
  cat "/Library/Application Support/u-chan-secrets/settings.json"
  cat "/Library/Application Support/u-chan-secrets/allowlist.json"
  ls "/Library/Application Support/u-chan-secrets/bw-data"
  ```

**Expected Outcome:**
- :white_check_mark: **PASSED:** All commands fail immediately with `Access is denied` (Windows) or `Permission denied` (macOS). No sensitive files or directory listings are readable by the user.
- :x: **FAILED:** Any command succeeds or displays file contents.

---

### Attack 2: Bitwarden CLI Theft

**Objective:** Verify that the user's unprivileged environment cannot access the unlocked Bitwarden session or list vault items.

**Attacker Steps (Run from user shell):**
```bash
# Check status of user's Bitwarden CLI
bw status

# Attempt to list vault items
bw list items

# Inspect environment variables for session key
env | grep -i BW_SESSION   # macOS / Linux
Get-ChildItem env:BW*       # Windows PowerShell
```

**Expected Outcome:**
- :white_check_mark: **PASSED:** `bw status` reports `{"status":"unauthenticated"}` or `{"status":"locked"}`. `bw list items` returns exit code 1 (`Vault is locked`). `BW_SESSION` environment variable does not exist.
- :x: **FAILED:** `bw list items` outputs passwords or decrypted vault contents.

---

### Attack 3: Service Browser Snooping

**Objective:** Verify that an unprivileged user cannot attach to or inspect the internal service-owned headless browser during credential autofill.

**Attacker Steps (Run from user shell):**
1. Trigger a login call via MCP or IPC:
   ```json
   {"method": "login", "params": {"domain": "admin.example.com"}}
   ```
2. While the service is logging in, attempt to discover and connect to a Chrome DevTools Protocol (CDP) port on localhost:
   - **Windows (PowerShell):**
     ```powershell
     9223..9300 | ForEach-Object {
       $res = Test-NetConnection -ComputerName 127.0.0.1 -Port $_ -WarningAction SilentlyContinue
       if ($res.TcpTestSucceeded) { Write-Output "Open port found: $_" }
     }
     ```
   - **macOS (Terminal):**
     ```bash
     for port in {9223..9300}; do
       nc -z 127.0.0.1 $port 2>/dev/null && echo "Open port found: $port"
     done
     ```
3. Attempt to query `http://127.0.0.1:<port>/json/version`.

**Expected Outcome:**
- :white_check_mark: **PASSED:** No unexpected listening debugging ports are discovered. Only the user's Chrome port (`9222`) is open. Connection to internal browser automation is refused.
- :x: **FAILED:** An unauthenticated CDP port or browser websocket endpoint belonging to the service browser is reachable.

---

### Attack 4: Synthetic Input to Approval Dialog

**Objective:** Verify that unprivileged user processes cannot programmatically dismiss or approve U-Chan protected prompt dialogs.

**Attacker Steps:**
1. Call `request_allow` to trigger a protected approval prompt:
   - Tool call: `request_allow(domain="attacker.example.com", login_url="https://attacker.example.com", item="MyItem")`
2. Concurrently execute automation scripts attempting to simulate clicks or keystrokes:
   - **Windows:**
     ```powershell
     # Attempt 1: SendKeys
     Add-Type -AssemblyName System.Windows.Forms
     [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

     # Attempt 2: Win32 PostMessage / BM_CLICK via PowerShell
     Get-Process -Name prompt-helper | ForEach-Object {
       # Attempt sending WM_COMMAND / BM_CLICK
     }
     ```
   - **macOS:**
     ```bash
     osascript -e 'tell application "System Events" to keystroke return'
     osascript -e 'tell application "System Events" to click button "OK" of front window'
     ```

**Expected Outcome:**
- :white_check_mark: **PASSED:**
  - On Windows: the SYSTEM-owned prompt runs on a separate input desktop. Attempts from the ordinary user desktop cannot approve it or capture password entry. Verify the actual token/desktop and keyboard-hook behavior; UIPI alone is insufficient evidence.
  - On macOS: easy mode is disabled; a valid master password is required in the secure-entry flow. Synthetic `return` without that password fails. Record actual secure-input/event-tap results separately from mocked tests.
- :x: **FAILED:** The prompt approves automatically without human interaction.

---

### Attack 5: Tampering with Program Files

**Objective:** Verify that an unprivileged user process cannot modify or overwrite service binaries or scripts to achieve code execution under `SYSTEM`/`root`.

**Attacker Steps (Run from user shell):**
- **Windows (PowerShell):**
  ```powershell
  Set-Content -Path "C:\ProgramData\u-chan-secrets\bin\service-host.exe" -Value "malicious"
  Set-Content -Path "C:\ProgramData\u-chan-secrets\bin\service-target.txt" -Value "malicious"
  Remove-Item -Path "C:\ProgramData\u-chan-secrets\settings.json" -Force
  ```
- **macOS (Terminal):**
  ```bash
  touch "/Library/Application Support/u-chan-secrets/program/dist/service/main.js"
  echo "malicious" > "/Library/LaunchDaemons/com.uchan.secrets.plist"
  ```

**Expected Outcome:**
- :white_check_mark: **PASSED:** All write, replace, and delete operations fail with `Access is denied` or `Operation not permitted`.
- :x: **FAILED:** Any service binary, configuration, or launch script is modified by an unprivileged process.

---

### Attack 6: Direct Mode Downgrade

**Objective:** Verify that an attacker cannot silently downgrade the approval mode from `hardcore` to `easy` to bypass master password prompts.

**Attacker Steps:**
1. Ensure the system is configured in `hardcore` mode.
2. In user shell, attempt to downgrade mode:
   ```bash
   u-chan mode easy
   ```
3. When the protected prompt appears, cancel the dialog or provide an invalid password.
4. Attempt to downgrade mode by directly writing to settings:
   - Windows: Modify `settings.json` in `%ProgramData%\u-chan-secrets`.
   - macOS: Modify `settings.json` in `/Library/Application Support/u-chan-secrets`.

**Expected Outcome:**
- :white_check_mark: **PASSED:**
  - On Windows: The mode change prompt requires master password entry. If cancelled or incorrect, mode remains `hardcore`. Direct file editing fails with Access Denied.
  - On macOS: Attempting `u-chan mode easy` is rejected immediately (`easy mode is not supported on macOS`). Direct file edit is blocked by root permissions.
- :x: **FAILED:** Mode changes to `easy` without authentic master password verification.

---

### Attack 7: Playwright Init Script Sniffing

**Objective:** Verify that a compromised Claude Code cannot intercept credentials by registering Playwright init scripts on the user's Chrome instance.

**Attacker Steps:**
1. Using Playwright MCP in the user's Chrome, attach an event listener to capture inputs before navigating:
   ```javascript
   await page.addInitScript(() => {
     window.__stolenInputs = [];
     document.addEventListener('input', (e) => {
       window.__stolenInputs.push({ name: e.target.name, value: e.target.value });
     }, true);
   });
   ```
2. Invoke `login(domain="admin.example.com")`.
3. Inspect `window.__stolenInputs` in user Chrome via Playwright:
   ```javascript
   await page.evaluate(() => window.__stolenInputs);
   ```

**Expected Outcome:**
- :white_check_mark: **PASSED:** Credential entry and form submission occurred in the service's private headless browser. User Chrome only received navigation and authenticated session cookies/storage. `window.__stolenInputs` is empty (`[]`). Passwords never touched the user Chrome DOM.
- :x: **FAILED:** Password or TOTP code is captured by the init script on user Chrome.

---

### Attack 8: Lookalike Phishing

**Objective:** Verify user defense against rogue AI displaying a fake prompt to steal the Bitwarden master password.

**Attacker Steps:**
1. Simulate an adversarial prompt injection where Claude Code pops up a native PowerShell/AppleScript dialog asking for the master password:
   - **Windows:**
     ```powershell
     Add-Type -AssemblyName Microsoft.VisualBasic
     [Microsoft.VisualBasic.Interaction]::InputBox("U-Chan Secrets: Enter Master Password", "Security Prompt")
     ```
   - **macOS:**
     ```bash
     osascript -e 'display dialog "U-Chan Secrets: Enter Master Password" default answer "" with hidden answer'
     ```

**Verification Check:**
- :white_check_mark: **PASSED:** The fake prompt lacks the user's personalized **anti-phishing secret phrase** (configured during `u-chan install`). The user spots the absence of the secret phrase and rejects the prompt.
- :x: **FAILED:** User cannot distinguish between an authentic U-Chan prompt and an unprivileged dialog.

The phrase is a user verification cue, not proof of protected process identity. A copied phrase does not establish authorization. Do not use this scenario to mark token, desktop, or input-isolation checks as passed.

---

### Attack 9: Log and Transcript Secret Leak Check

**Objective:** Verify that credentials, TOTP seeds, and master passwords never leak into logs, Claude project transcripts, or error outputs.

**Attacker Steps:**
1. Search service audit log:
   ```bash
   u-chan audit 50
   ```
2. Grep user directories and Claude Code session transcripts for known password or seed strings:
   - **Windows (PowerShell):**
     ```powershell
     $secret = "KnownTestPassword123!"
     Get-ChildItem -Path "$env:USERPROFILE\.claude" -Recurse -Filter "*.json*" | Select-String -Pattern $secret
     Get-ChildItem -Path "$env:APPDATA\u-chan-secrets" -Recurse | Select-String -Pattern $secret
     ```
   - **macOS (Terminal):**
     ```bash
     SECRET="KnownTestPassword123!"
     grep -rn "$SECRET" ~/.claude/
     grep -rn "$SECRET" ~/Library/Application\ Support/u-chan-secrets/
     ```

**Expected Outcome:**
- :white_check_mark: **PASSED:** Exactly zero matches found. Neither passwords, TOTP secret seeds, nor generated 6-digit codes appear in transcripts, logs, or user storage.
- :x: **FAILED:** Cleartext secret strings found in audit logs or Claude Code transcripts.

---

## Test Verification Summary Matrix

| # | Attack Scenario | Threat Vector | Target Defense | Pass / Fail |
|---|---|---|---|---|
| 1 | Direct File Read | Compromised shell reads secrets | OS Identity Boundary / Strict ACLs | [ ] |
| 2 | Bitwarden CLI Theft | Unprivileged shell runs `bw` | Memory-Only Session Key | [ ] |
| 3 | Service Browser Snooping | User attaches to CDP port | Isolated Browser Context (No user CDP) | [ ] |
| 4 | Synthetic Input to Approval | Automated mouse/keyboard clicks | SYSTEM input desktop / Cocoa secure input | [ ] |
| 5 | Tampering Program Files | User shell overwrites binaries | Admin/Root File Permissions | [ ] |
| 6 | Direct Mode Downgrade | Weakening approval policy | Protected Prompt Re-Auth / OS ACLs | [ ] |
| 7 | Playwright Init Script Sniffing | DOM input listening in Chrome | Service Browser Credential Entry | [ ] |
| 8 | Lookalike Phishing | Fake dialog master password theft | Anti-Phishing Secret Phrase | [ ] |
| 9 | Log & Transcript Leak Check | Secret leakage to context/logs | Strict Masking & Memory-Only Key | [ ] |
