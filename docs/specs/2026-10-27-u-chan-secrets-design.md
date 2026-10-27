# U-Chan Secrets — Design

Date: 2026-10-27 · Status: draft · Built for personal use

Product name: **U-Chan Secrets** (folder/package slug: `u-chan-secrets`).

## 1. Purpose and motivation

The user works with Claude Code on a personal Windows machine and often asks the AI to open a browser (Playwright MCP) to check the UI on a live site, for example `admin.example.com`. The AI gets stuck at the login screen. Today the user has to type or paste the password into the chat, which leaks it into the model's context.

Existing solutions do not fit:
- Bitwarden MCP returns the plaintext password to the model.
- 1Password for Claude keeps secrets away from the model, but it is paid, was initially Mac-only, and requires manual approval every time.

**Core principle:** the AI only says "sign in to site X"; a local tool fetches the credentials from Bitwarden and fills them straight into the browser. The password never appears in the chat, a tool result, a log, or the model's context.

**Success means:** the user says "check the admin.example.com UI on live" → the AI opens it, signs in, takes a screenshot and reports back, with no manual steps from the user (apart from unlocking Bitwarden at the start of the day).

## 2. Goals

- A local MCP server (stdio) plugged into Claude Code that offers a sign-in tool per domain.
- Credentials come from Bitwarden (the user's existing personal vault) via the Bitwarden CLI (`bw`).
- Sign in only to allowlisted sites; for an allowed site the AI acts on its own without asking again.
- Share the browser with the existing Playwright MCP, so after signing in the AI keeps browsing and taking screenshots with Playwright MCP as usual.
- The AI may propose adding a site to the allowlist, but it takes effect only when the user clicks approve in a native Windows dialog shown by the tool.
- An audit log of every sign-in and every allowlist change.

## 3. Non-goals (first version)

- Google / SSO / OAuth sign-in.
- 2FA, OTP, TOTP, passkeys. (TOTP support was added later; see the README.)
- A custom vault or custom crypto.
- Multiple users, sharing, commercial use.
- macOS/Linux support (not deliberately broken, but not tested).
- Agents other than Claude Code.

## 4. Anti-goals (treated as failure even if it "works")

- The password appears anywhere the AI can read: a tool result, an error message, a log, the MCP server's stdout/stderr, a browser snapshot.
- The AI adds a site to the allowlist without a real click from the user (including when web content tricks the AI — prompt injection).
- Credentials are filled into a domain that does not match the allowlist (for example a phishing page or a redirect to another domain).

## 5. Constraints

- Windows 11, with Claude Code running in **bypass permissions mode** → Claude Code's permission prompts cannot serve as the approval step.
- Playwright MCP (`mcp__playwright__*`) is already installed and the user wants to keep using it.
- The user unlocks Bitwarden once a day (`bw unlock`); the tool then works until the vault is locked again or the machine shuts down.
- Email/password only (ordinary login forms).

## 5b. Threat model (chosen by the user)

**v1 — prevent accidental leaks.** In the normal flow the password never enters the chat or context. Claude is trusted not to deliberately extract the password through the shell or Playwright (`browser_evaluate`, network requests). Not defended against: Claude running `bw` itself, editing the allowlist or log files, simulating a click on the dialog.

**It must be possible to upgrade to "resist a tricked AI" later** without a rewrite. Consequences for v1:
- Two clearly separated layers: (1) **core** — vault access, allowlist, approval, audit, form filling; (2) a thin **MCP adapter** that only forwards tool calls to the core. The layers talk through an interface, so the core can later run as a separate process/service under another Windows account (IPC, for example a named pipe) without changing the adapter.
- The Bitwarden session, allowlist and audit log must not depend on a fixed location inside the AI's user folder — paths are configurable.
- The form-filling logic takes a browser/context as a parameter, so it can later sign in inside a separate context and hand only the session over to the shared Chrome.
- The approval dialog sits behind an interface, so it can later be replaced by a stronger mechanism (secure desktop, confirmation on a phone).

## 6. Design (decided)

### 6.1 Components

```
Claude Code
  ├─ Playwright MCP  ──(--cdp-endpoint)──┐
  └─ u-chan-secrets MCP ──(CDP)─────────┤
                                         ▼
                              Chrome (remote debugging port)
u-chan-secrets ── bw CLI ── Bitwarden vault (unlocked)
u-chan-secrets ── native Windows dialog (allowlist approval)
```

- **Shared browser:** one Chrome runs with a remote debugging port; Playwright MCP is configured with `--cdp-endpoint` pointing at it; the broker also connects over CDP (Playwright `connectOverCDP`). The signed-in session is therefore shared, with no cookie copying.
- **Stack (Claude's decision):** TypeScript/Node, `@modelcontextprotocol/sdk`, `playwright`.

### 6.2 MCP tools

| Tool | Behavior | Returned to the AI |
|---|---|---|
| `login(domain)` | Check the allowlist → fetch credentials from Bitwarden → open/navigate to the login URL in the shared Chrome → fill email + password and submit in a single step → confirm the sign-in succeeded | `ok` or `failed: <reason without secrets>` |
| `request_allow(domain, item)` | Show a native Windows dialog: "Allow the AI to sign in to <domain> with item <item>?" [Yes] [No]. Write to the allowlist only when the user clicks Yes | `approved` / `denied` |
| `revoke(domain)` | Remove a site from the allowlist, no approval needed (it only reduces permissions) | `ok` |
| `list_allowed()` | List domains + item names (no secrets) | list |
| `status()` | Whether Bitwarden is unlocked and Chrome is connected | status |

### 6.3 Allowlist

- A local config file (JSON); each entry has a domain, a Bitwarden item name/ID, and a login URL.
- The user may edit it by hand; the AI can change it only through `request_allow` (with approval) and `revoke`.

### 6.4 Protections

- Right before filling (after any redirect), the page's actual domain must match the allowlist.
- Fill and submit in one operation, so there is no window in which the password field holds a value the AI could snapshot.
- Every error/exception is filtered and never includes credentials.
- Audit log: time, domain, result; allowlist changes (approved/denied/revoked).

### 6.5 Additional decisions (chosen by Claude after the builder check)

- **Multi-step login:** support both single-page forms and split forms (email first, password on the next screen). The domain check repeats before every fill.
- **Dedicated Chrome profile:** the shared Chrome runs with a user-data-dir dedicated to U-Chan Secrets, not the user's everyday profile (recent Chrome versions also block remote debugging on the default profile).
- **`request_allow(domain, login_url, item)`:** the AI passes the login URL and the item name; the dialog shows all three so the user can check them. The AI has no tool to list vault items — the item name comes from what the user says in the chat.
- **Domain matching:** each entry has a list of allowed hosts (by default only the exact approved host, no wildcard subdomains). Adding a host (for example a separate `auth.` host) goes through the same approval flow.

### 6.6 Accepted risk

After sign-in, the AI can use the session (cookies) through Playwright — that is the whole point. What is protected is the password, not the session.

## 7. Left to the builder

- How to locate the email field, password field and submit button (a general heuristic, possibly with per-site selector overrides in the allowlist).
- How to detect a successful sign-in.
- How the broker receives the Bitwarden session after `bw unlock` (the `BW_SESSION` environment variable, a file, or a helper command).
- How to launch Chrome with remote debugging and configure Playwright MCP (a startup script).
- The technology for the native Windows dialog.
- Where the allowlist file and the audit log live.
- The test strategy.
