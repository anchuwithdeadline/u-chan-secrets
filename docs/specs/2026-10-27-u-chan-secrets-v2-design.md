# U-Chan Secrets V2 — Design

Date: 2026-10-27 · Status: draft · Builds on `2026-10-27-u-chan-secrets-design.md` (V1)

## 1. Purpose and motivation

V1 keeps the password out of the chat in the normal flow, but it trusts Claude not to go after it (V1 spec §5b). Claude runs in bypass permissions mode as the user's own OS account, so anything that account can do, Claude can do: read `bw-session`, run `bw get item`, edit `allowlist.json` and `audit.log`, send a fake click to the Yes/No dialog, or use Playwright (`browser_evaluate`, init scripts) to plant a script on the login page that records the password as it is filled.

V2 closes these holes so the password stays safe **even when Claude has been tricked by prompt injection, or is actively trying to get it**. The user wants it public: anyone can install it on Windows or macOS.

**Success means:** a tricked Claude, with full shell and browser access as the user, cannot obtain a password, TOTP seed or Bitwarden session, and cannot allowlist a new site without the user. Day-to-day use stays as close to V1 as possible.

## 2. Goals

- Move everything secret (Bitwarden session, Bitwarden CLI data, allowlist, audit log) into a **system service** that runs under its own OS identity, out of reach of the user's account.
- Approvals and vault unlock happen in **protected windows** owned by the service, which a normal-user process cannot click, type into, read or inject code into.
- The login itself runs in the **service's own browser**; only the resulting session is handed to the user's Chrome.
- Two approval modes (user's decision, see §6.4): **easy** (click OK) and **hardcore** (type the Bitwarden master password).
- Windows and macOS, installed by anyone from npm, **at zero cost**: no paid code signing (user's decision).
- Claude-facing MCP tools stay the same as V1.

## 3. Non-goals

- Linux.
- Protecting the session after login. As in V1 (§6.6), Claude may use the signed-in session; that is the point. What is protected is the password, the TOTP seed and the Bitwarden session.
- Stopping Claude from breaking U-Chan (deleting its MCP config, killing the client). Denial of service is acceptable; theft is not.
- Stopping Claude from calling `login` on a site the user already approved.
- Fingerprint / Windows Hello / Touch ID approvals (possible later).
- Defending against malware that already has admin/root, or against someone at the keyboard.
- SSO/OAuth, passkeys, SMS/email codes (unchanged from V1).

## 4. Anti-goals (failure even if it "works")

- Any secret readable by the user's account: a file, an environment variable, a process's memory, a command's output, a browser the user's account controls.
- Any code the service runs being writable by the user's account (that would hand Claude the service's privileges).
- A site added to the allowlist, an allowlist entry changed, or the mode lowered from hardcore to easy without a real human action in a protected window.
- In hardcore mode, a new site approved without the master password being typed by the human.
- Credentials filled into a host not in the entry's allowlist (unchanged from V1).
- Requiring paid code signing or showing "unidentified developer" / SmartScreen warnings on a normal install.

## 5. Constraints

- Claude Code runs in bypass permissions mode as the user; assume Claude can run any command the user can, use any MCP tool, and drive the user's Chrome fully.
- Claude cannot pass a UAC prompt (Windows secure desktop) and does not know the user's macOS login password or Bitwarden master password. Treat those as the human-only actions.
- **Windows UAC bypass (user's decision: warn, don't block).** On an admin account with the default UAC level, public UAC bypasses let a normal process gain admin silently, which defeats V2. The installer detects this setup and shows a clear warning recommending "Always notify" or a standard user account, then lets the user continue. The README states that the §1 guarantee holds on Windows only with one of those two setups.
- Install from npm (`npm install -g`) plus one admin step. No unsigned app downloads, so no Gatekeeper/SmartScreen warnings.
- Playwright MCP stays the user's browser tool, attached to a shared Chrome over CDP as in V1.

## 6. Design (decided)

### 6.1 Components

```
Claude Code (user account)
  ├─ Playwright MCP ──(CDP)──────────────┐
  └─ u-chan-secrets MCP (thin client)    │
        │  local IPC                     ▼
        ▼                     User's Chrome (dedicated profile, as in V1)
  U-Chan service (own OS identity)       ▲
        ├─ bw CLI + its own data dir     │ cookies/session only (CDP)
        ├─ allowlist, audit log, config  │
        ├─ its own headless browser ─────┘ (performs the login)
        └─ protected windows (unlock, approve, mode change, setup)
```

- **Service:** a Windows service or a macOS launchd daemon, running under an identity the user's account cannot impersonate. The core from V1 (`CoreService`, allowlist, audit, vault, login-filler, TOTP) moves into it largely unchanged; V1 §5b layering was built for this.
- **Thin client:** the MCP server Claude talks to. It holds nothing secret; it forwards the five tool calls over local IPC and returns the service's safe messages. It implements the existing `CoreApi` interface, so `src/mcp/server.ts` changes only in wording.
- **Program files are admin/root-owned.** The installer copies the service's code, its Node runtime, `bw` and the service's browser into an admin-owned location. The service never executes anything from the user's npm folder or any user-writable path. (`npm install -g` only delivers the installer.)

### 6.2 Daily flow

1. **Install once:** `npm install -g u-chan-secrets`, then `u-chan install` (one UAC prompt on Windows, login password via `sudo` on macOS). The installer asks which mode to use. A protected window then collects the Bitwarden email, master password and Bitwarden 2FA code if needed, and the service runs `bw login` under its own identity.
2. **Each day:** `u-chan unlock` asks the service to show its protected unlock window; the user types the master password. The service keeps the Bitwarden session **in memory only**. It locks on reboot, on service restart, on `u-chan lock`, and after an idle timeout (default 12 h, configurable through a protected window).
3. **New site:** Claude calls `request_allow`. The service shows a protected window with the domain (registrable domain prominent), login URL, Bitwarden item and hosts. Easy mode: click OK. Hardcore mode: type the master password.
4. **Login:** Claude calls `login(domain)`. The service signs in with its own browser, then copies the session into the user's Chrome. Claude continues with Playwright MCP as in V1.

### 6.3 Protected windows

Every window that confirms an action or takes the master password is **started by the service itself** in the user's desktop session, running under the service's identity. Nothing in the user's account ever reports "the user approved" to the service, so no helper identity check and no code signing is needed.

Required properties, per platform:
- A normal-user process cannot send clicks or keystrokes to it, read its contents, or inject code into it.
- Keystrokes typed into a password field cannot be captured by a normal-user process (keyboard hooks, event taps).
- Closing it, timing out (2 min) or any error means "denied".

Known platform limit: on macOS, a user-account app that holds the Accessibility permission can post synthetic clicks to any window, including the service's, and Screen Recording apps may be able to read it. **macOS therefore supports hardcore mode only (user's decision)**; a click-to-approve is not safe there. Windows UIPI blocks synthetic input to a SYSTEM-owned window, so Windows offers both modes. If a macOS protected window turns out to be readable by Screen Recording apps, that is acceptable (the window shows no secret beyond the anti-phishing phrase); keystroke capture of the master password is not.

### 6.4 Approval modes (user's decision)

| | Easy | Hardcore |
|---|---|---|
| Approve a new site or a changed entry | Click OK in protected window | Type master password in protected window |
| Everything else (service, own browser, no file access) | Same | Same |

- Easy mode exists on Windows only; macOS is always hardcore.
- Hardcore → easy: requires the master password in a protected window.
- Easy → hardcore: no confirmation (it only tightens).
- The mode lives in the service's config, not in any user-writable file.
- The master password in hardcore mode is verified by the service against Bitwarden; 5 wrong attempts lock approvals for 15 minutes.

### 6.5 Login in the service's browser

- The service launches its own headless Chromium with a fresh, throwaway context per login. The user's account cannot attach to it (no open debugging port reachable by the user).
- It runs V1's `fillLogin` there: same domain/host checks before every fill, same TOTP behavior.
- After success it exports the session for **the entry's hosts only** (cookies, plus localStorage for those origins) and injects it into the user's Chrome over CDP. The service browser context is then discarded.
- It uses the same user agent as the user's Chrome, so sites that bind sessions to the browser keep working.
- Nothing from the login page (DOM, screenshots, page text) is returned to the thin client; only `ok` / `failed: <safe reason>`.
- **Human checks (user's decision):** if the login hits a CAPTCHA, bot challenge, "is this you?" page or device-verification step, `login` returns `failed: needs you — sign in by hand this time`. No visible service browser is built.

### 6.6 MCP tools (unchanged surface)

`login`, `request_allow`, `revoke`, `list_allowed`, `status` keep V1's names and parameters. Changes:
- `request_allow` gains optional `selectors`, shown in the protected window; this replaces V1's hand-editing of `allowlist.json`, which the user can no longer edit.
- `status` also reports the mode and tells the user to run `u-chan unlock` instead of `scripts/unlock.ps1`.
- `revoke` stays approval-free (it only reduces access).
- The IPC endpoint accepts requests only from the installing user's account.

### 6.7 Admin CLI (`u-chan`)

`install`, `uninstall` (admin; removes the service and all its data), `update` (the service updates itself, see §6.9), `unlock`, `lock`, `mode` (opens the protected mode window), `import-v1`, `audit` (prints the audit log; read-only for the user).

### 6.8 Migration from V1

`u-chan import-v1` reads the V1 `allowlist.json`. Claude may have edited that file, so **every entry is shown in a protected approval window** under the current mode; nothing is imported silently. V1's `bw-session` file and `scripts/unlock.ps1` are retired; the installer offers to delete `bw-session` and runs `bw lock` for the user's own `bw`.

### 6.9 Calls made by Claude (not discussed with the user, open to change)

- Bitwarden session held in memory only; default idle lock 12 h.
- 2-minute timeout on protected windows; 5 attempts / 15-minute lockout.
- `request_allow` gains `selectors`; the allowlist is no longer hand-editable.
- On Windows the installer asks for the mode with **easy** preselected, since the user called it the most convenient.
- Fresh throwaway browser context per login; session transfer limited to the entry's hosts.
- V2 is a major version (2.0.0) and replaces V1; there is no coexistence.
- **Fake-prompt phishing is in scope.** Claude can draw a lookalike window and ask for the master password. Defenses:
  - At install, the user picks a **secret phrase**, which the service stores. Every real protected window shows it, and the docs say: never type the master password into a window without your phrase.
  - Unlock is started from an admin-owned launcher (Start menu / Applications entry) rather than only through the npm `u-chan` shim.
  - Protected windows never appear on their own; each follows a user command or a `request_allow`.
  - Migration runs `bw logout` (not just `bw lock`) on the user's own `bw`.
- **Install and update integrity.** The first install is trusted: the docs say to install before giving Claude bypass mode, or from a fresh shell. After that, the service updates itself (`u-chan update` asks it to): it downloads the package from the npm registry and checks the registry signature/provenance before replacing its admin-owned files. The user-writable npm copy is never run with admin rights again.
- **Every `login` signs in fresh** in the service browser; V1's "already logged in" shortcut is dropped.

## 7. Left to the builder

- The OS identity for the service (e.g. LocalSystem or a virtual service account on Windows; root or a dedicated hidden user on macOS), as long as §4 holds.
- The IPC mechanism (e.g. a named pipe with an ACL, a Unix socket with file permissions) and how the caller's account is checked.
- How protected windows are created on each platform (e.g. a SYSTEM process in the user's session or a separate secure desktop on Windows; a root process using a secure text field on macOS), and the language of any native helper. It must satisfy §6.3; the builder verifies the keystroke-capture property on each platform and picks a separate desktop on Windows if UIPI alone does not give it.
- How the service verifies the master password for hardcore approvals.
- How the Bitwarden CLI, Node runtime and Chromium are placed in the admin-owned location, and how updates work (`npm update -g` then `u-chan install` again is acceptable).
- How Chrome is started for the user on macOS (V1 has only `start-chrome.ps1`).
- Test strategy. It must include a manual **attack checklist** per platform: as the user, try to read the service's files, run `bw`, connect to the service browser, click/type into each protected window with automation tools, write to the program directory, edit the mode, and plant a Playwright init script before `login`; each must fail.
