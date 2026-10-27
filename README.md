# U-Chan Secrets

A local MCP server that lets Claude Code sign in to allowlisted websites with Bitwarden credentials, without the password ever passing through the model.

## Install

1. Install the native Bitwarden CLI (not npm's `.cmd` shim): `winget install Bitwarden.CLI`. If `bw.exe` is not on your PATH, point `U_CHAN_BW` at it.
2. Run `bw login` (once).
3. Build:
   ```
   npm install
   npm run build
   ```
   Output: `dist/index.js`.

## Register the MCP server

```
claude mcp add u-chan-secrets -- node <path-to>\u-chan-secrets\dist\index.js
```

Playwright MCP must share the same Chrome. If you already have Playwright MCP, reconfigure it instead of adding a second one:

```
claude mcp remove playwright   # remove the old one before re-adding it with --cdp-endpoint
claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
```

## Daily routine

```
powershell -File scripts\start-chrome.ps1   # dedicated Chrome, CDP from U_CHAN_CDP, default 127.0.0.1:9222 (skipped if the port is already open)
powershell -File scripts\unlock.ps1         # enter the master password; saves the session to bw-session
powershell -File scripts\unlock.ps1 -Lock   # lock the vault and delete the session
```

Chrome uses its own profile at `<data dir>\chrome-profile` and never touches your default Chrome profile.

## MCP tools

- `status`: vault state (unlocked/locked/...) and the Chrome connection. It reports an error only when you need to act (vault locked, Playwright missing `--cdp-endpoint`). A closed Chrome is not an error, because `login` starts it.
- `request_allow(domain, login_url, item)`: asks to allowlist a site. A Windows dialog appears and you must click Yes. `item` is a Bitwarden item name or id. Prefer the id: a name is only a search and can match the wrong item.
- `login(domain)`: signs in to an allowlisted site in the shared Chrome. Then use Playwright MCP to keep browsing.
- `list_allowed`: lists the allowlisted domains.
- `revoke(domain)`: removes a site from the allowlist.

## Data and configuration

Data directory: `U_CHAN_HOME`, default `%APPDATA%\u-chan-secrets`. It holds `allowlist.json`, `audit.log`, `bw-session` and `chrome-profile\`.

| Environment variable | Default | Meaning |
|---|---|---|
| `U_CHAN_HOME` | `%APPDATA%\u-chan-secrets` | Data directory |
| `U_CHAN_CDP` | `http://127.0.0.1:9222` | Chrome CDP endpoint (`start-chrome.ps1` takes its host and port from here) |
| `U_CHAN_BW` | `bw` | Path to `bw.exe` |

Each `allowlist.json` entry looks like this:

```json
{
  "domain": "admin.example.com",
  "hosts": ["admin.example.com"],
  "loginUrl": "https://admin.example.com/login",
  "item": "Bitwarden item name",
  "selectors": { "username": "#email", "password": "#password", "submit": "button[type=submit]", "otp": "#code" }
}
```

`selectors` is optional; set it only when automatic form detection gets the form wrong. `audit.log` records every `login`, `request_allow` and `revoke` call, never a password.

## 2FA (TOTP)

If a code field appears after the password step (`autocomplete="one-time-code"`, a name or id containing `otp` or `2fa`, or a name or id of `code`), `login` computes the code from the Bitwarden item's **Authenticator key (TOTP)** field and fills it in. The code is computed locally per RFC 6238: base32 secrets and `otpauth://totp/...` URIs with SHA1/256/512 and custom digits and period are supported, so Bitwarden Premium is not required. Neither the seed nor the code passes through the model.

- Each `login` fills the code only once and never retries, to avoid locking the account.
- If the code expires in under 3 seconds, U-Chan waits for the next period before filling it.
- Not supported yet: codes sent by SMS or email, passkeys, Steam Guard.

## Revoking access

Call `revoke(domain)`, or delete the entry from `allowlist.json`.

## Threat model (v1)

U-Chan protects against accidental leaks: in the normal flow the password never enters the chat or the model's context. It does not protect against an AI that is tricked into, or deliberately tries, extracting the password (running `bw` itself, editing the allowlist or log, faking a click on the dialog). Details: section 5b of `docs/specs/2026-10-27-u-chan-secrets-design.md` (in Vietnamese).

## End-to-end check

Run by hand after installing (needs a real Bitwarden account):

- [ ] Run `start-chrome.ps1` and `unlock.ps1`.
- [ ] In Claude Code, `status` returns unlocked + connected.
- [ ] `request_allow("admin.example.com", "<login url>", "<item name>")`: the dialog appears; click Yes.
- [ ] `login("admin.example.com")` returns `logged in`.
- [ ] Playwright MCP `browser_navigate` to the admin page shows the signed-in UI; take a screenshot.
- [ ] Leak check: grep for the real password in `audit.log`, the Claude Code transcript of the test session (`~/.claude/projects/...`) and the stderr log. There must be no hits.

## License

[MIT](LICENSE)
