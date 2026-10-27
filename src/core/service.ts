import { buildEntry } from './allowlist.js'
import type { AllowlistStore } from './allowlist.js'
import type { BrowserProvider } from './browser.js'
import { fillLogin } from './login-filler.js'
import { redact } from './redact.js'
import {
  UserFacingError,
  type Approver,
  type AuditEvent,
  type AuditLog,
  type ToolResult,
  type VaultClient,
} from './types.js'

export interface CoreDeps {
  vault: VaultClient
  allowlist: AllowlistStore
  approver: Approver
  audit: AuditLog
  browser: BrowserProvider
}

/** Strips control, line- and paragraph-separator characters (incl. \r \n \t). */
const clean = (s: string): string => String(s ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '')

export class CoreService {
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
        await this.deps.audit.record({ action, domain: clean(domain), result: audit })
      } catch {
        console.error('audit write failed')
      }
    }
    return result
  }

  login(domain: string): Promise<ToolResult> {
    const secrets: string[] = []
    return this.guarded('login', domain, secrets, async () => {
      const entry = await this.deps.allowlist.get(clean(domain))
      if (!entry) throw new UserFacingError('domain chưa được cho phép — dùng request_allow')
      const getCreds = async () => {
        const c = await this.deps.vault.getLogin(entry.item)
        secrets.push(c.username, c.password)
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
      const d = clean(domain)
      const existing = await this.deps.allowlist.get(d)
      const entry = buildEntry(d, clean(loginUrl), clean(item), existing)
      const approved = await this.deps.approver.ask('U-Chan Secrets', [
        'Cho phép AI đăng nhập?',
        `Domain: ${entry.domain}`,
        `Login URL: ${entry.loginUrl}`,
        `Item Bitwarden: ${entry.item}`,
        `Hosts: ${entry.hosts.join(', ')}`,
      ])
      if (!approved) return { result: { ok: false, message: 'denied' }, audit: 'denied' }
      await this.deps.allowlist.upsert(entry)
      return { result: { ok: true, message: 'approved' }, audit: 'approved' }
    })
  }

  revoke(domain: string): Promise<ToolResult> {
    return this.guarded('revoke', domain, [], async () => {
      const removed = await this.deps.allowlist.remove(clean(domain))
      return removed
        ? { result: { ok: true, message: 'revoked' }, audit: 'ok' }
        : { result: { ok: false, message: 'domain không có trong allowlist' }, audit: 'not found' }
    })
  }

  listAllowed(): Promise<ToolResult> {
    return this.guarded(undefined, '', [], async () => {
      const all = await this.deps.allowlist.list()
      const message = all.map((e) => `${e.domain} — ${e.item} — ${e.hosts.join(', ')}`).join('\n')
      return { result: { ok: true, message }, audit: '' }
    })
  }

  status(): Promise<ToolResult> {
    return this.guarded(undefined, '', [], async () => {
      const vault = await this.deps.vault.status()
      const chrome = await this.deps.browser.connected()
      const ok = vault === 'unlocked' && chrome
      return { result: { ok, message: `vault: ${vault}; chrome: ${chrome ? 'connected' : 'not connected'}` }, audit: '' }
    })
  }
}
