# Security Policy

U-Chan Secrets handles real credentials, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please do **not** open a public issue. Report privately through GitHub:
**Security** tab → **Report a vulnerability**
(https://github.com/anchuwithdeadline/u-chan-secrets/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could gain. You should get a reply within 7 days.

## Scope

In scope: anything that lets a password, TOTP secret or Bitwarden session reach the model's context, logs, transcripts or disk outside the intended flow, or that bypasses the allowlist or the approval dialog.

Known limits are listed in the README's **Threat model (v1)** section. A report that only restates one of them is not a new vulnerability, but ideas for closing them are welcome.

## Supported versions

Only the latest commit on `main` gets fixes.
