import { buildEntry, normalizeDomain } from './allowlist.js'
import type { AllowlistStore } from './allowlist.js'
import type { BrowserProvider } from './browser.js'
import type { PlaywrightCheck } from './doctor.js'
import { fillLogin } from './login-filler.js'
import { redact } from './redact.js'
import {
  UserFacingError,
  type Approver,
  type AuditEvent,
  type AuditLog,
  type CoreApi,
  type ToolResult,
  type VaultClient,
} from './types.js'

export interface CoreDeps {
  vault: VaultClient
  allowlist: AllowlistStore
  approver: Approver
  audit: AuditLog
  browser: BrowserProvider
  /** Optional check that the AI client's Playwright MCP is attached to the shared Chrome. */
  playwright?: () => Promise<PlaywrightCheck>
}

const PLAYWRIGHT_MSG: Record<PlaywrightCheck, string> = {
  ok: 'shared chrome',
  missing: 'missing --cdp-endpoint (using its own Chrome; restart the AI session)',
  not_found: 'not found',
  unknown: 'unknown',
}

/** Strips control, format (e.g. bidi overrides), line- and paragraph-separator characters (incl. \r \n \t). */
const clean = (s: string): string => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')

/** Normalized domain for lookups/audit; throws on unusable input. */
function domainOf(input: string): string {
  const d = normalizeDomain(clean(input))
  if (!d) throw new UserFacingError('domain is empty or invalid')
  return d
}

export class CoreService implements CoreApi {
  constructor(private readonly deps: CoreDeps) {}

  /** Runs `fn`, maps errors to ToolResults (never leaking details) and audits the outcome. */
  private async guarded(
    action: AuditEvent['action'] | undefined,
    domain: string,
    secrets: string[],
    fn: () => Promise<{ result: ToolResult; audit: string }>,
  ): Promise<ToolResult> {
    let result: ToolResult
    let audit: string
    try {
      ;({ result, audit } = await fn())
    } catch (err) {
      const message = err instanceof UserFacingError ? err.message : 'internal error'
      if (!(err instanceof UserFacingError)) {
        const e = err as { stack?: unknown } | null
        console.error(redact(String(e?.stack ?? err), secrets))
      }
      result = { ok: false, message }
      audit = `failed: ${message}`
    }
    if (action) {
      try {
        await this.deps.audit.record({ action, domain: normalizeDomain(clean(domain)) || clean(domain), result: audit })
      } catch {
        console.error('audit write failed')
      }
    }
    return result
  }

  login(domain: string): Promise<ToolResult> {
    const secrets: string[] = []
    return this.guarded('login', domain, secrets, async () => {
      const entry = await this.deps.allowlist.get(domainOf(domain))
      if (!entry) throw new UserFacingError('domain is not allowlisted — use request_allow')
      const getCreds = async () => {
        const c = await this.deps.vault.getLogin(entry.item)
        secrets.push(c.username, c.password, ...(c.totp ? [c.totp] : []))
        return c
      }
      const out = await this.deps.browser.withPage((page) => fillLogin(page, entry, getCreds))
      if (out.status === 'logged_in') return { result: { ok: true, message: 'logged in' }, audit: 'ok' }
      if (out.status === 'already_logged_in') return { result: { ok: true, message: 'already logged in' }, audit: 'already' }
      const message = out.reason ?? 'login failed'
      return { result: { ok: false, message }, audit: `failed: ${message}` }
    })
  }

  requestAllow(domain: string, loginUrl: string, item: string): Promise<ToolResult> {
    return this.guarded('request_allow', domain, [], async () => {
      const d = domainOf(domain)
      const existing = await this.deps.allowlist.get(d)
      const entry = buildEntry(d, clean(loginUrl), clean(item), existing)
      const approved = await this.deps.approver.ask('U-Chan Secrets', [
        'Allow the AI to sign in?',
        `Domain: ${entry.domain}`,
        `Login URL: ${new URL(entry.loginUrl).href}`,
        `Bitwarden item: ${entry.item}`,
        `Hosts: ${entry.hosts.join(', ')}`,
      ])
      if (!approved) return { result: { ok: false, message: 'denied' }, audit: 'denied' }
      await this.deps.allowlist.upsert(entry)
      return { result: { ok: true, message: 'approved' }, audit: 'approved' }
    })
  }

  revoke(domain: string): Promise<ToolResult> {
    return this.guarded('revoke', domain, [], async () => {
      const removed = await this.deps.allowlist.remove(domainOf(domain))
      return removed
        ? { result: { ok: true, message: 'revoked' }, audit: 'ok' }
        : { result: { ok: false, message: 'domain is not in the allowlist' }, audit: 'not found' }
    })
  }

  listAllowed(): Promise<ToolResult> {
    return this.guarded(undefined, '', [], async () => {
      const all = await this.deps.allowlist.list()
      if (all.length === 0) return { result: { ok: true, message: 'allowlist is empty' }, audit: '' }
      const message = all.map((e) => `${e.domain} — ${e.item} — ${e.hosts.join(', ')}`).join('\n')
      return { result: { ok: true, message }, audit: '' }
    })
  }

  status(): Promise<ToolResult> {
    return this.guarded(undefined, '', [], async () => {
      const vault = await this.deps.vault.status()
      const chrome = await this.deps.browser.connected()
      let message = `vault: ${vault}; chrome: ${chrome ? 'connected' : 'not connected (login will start it)'}`
      const pw = await this.deps.playwright?.()
      if (pw) message += `; playwright: ${PLAYWRIGHT_MSG[pw]}`
      const ok = vault === 'unlocked' && pw !== 'missing'
      return { result: { ok, message }, audit: '' }
    })
  }
}
