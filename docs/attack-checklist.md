# U-Chan Secrets V2 — Manual Attack Verification Checklist

This checklist defines 9 manual verification attack scenarios corresponding to Spec §7. These tests verify that U-Chan Secrets V2 defends passwords, TOTP seeds, and Bitwarden sessions against a compromised AI assistant operating with full user shell permissions and browser automation.

---

## Pre-Test Setup

1. Install and initialize U-Chan Secrets V2:
   - **Windows:** Run `npm install -g u-chan-secrets` and `u-chan install` in an elevated shell. Verify UAC is set to "Always Notify" or perform tests from a Standard User account.
   - **macOS:** Run `npm install -g u-chan-secrets` and `sudo u-chan install`.
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
  - On Windows: UIPI blocks window messages and synthetic inputs from standard user processes. Dialog remains waiting for real user action.
  - On macOS: Easy mode is disabled; prompt demands master password input inside `NSSecureTextField`. Synthetic `return` without valid password fails. Keystrokes cannot be snooped via event taps.
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
  touch "/Library/Application Support/u-chan-secrets/dist/service/main.js"
  echo "malicious" > "/Library/LaunchDaemons/com.u-chan.secrets.plist"
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
| 4 | Synthetic Input to Approval | Automated mouse/keyboard clicks | UIPI / Cocoa NSSecureTextField | [ ] |
| 5 | Tampering Program Files | User shell overwrites binaries | Admin/Root File Permissions | [ ] |
| 6 | Direct Mode Downgrade | Weakening approval policy | Protected Prompt Re-Auth / OS ACLs | [ ] |
| 7 | Playwright Init Script Sniffing | DOM input listening in Chrome | Service Browser Credential Entry | [ ] |
| 8 | Lookalike Phishing | Fake dialog master password theft | Anti-Phishing Secret Phrase | [ ] |
| 9 | Log & Transcript Leak Check | Secret leakage to context/logs | Strict Masking & Memory-Only Key | [ ] |
