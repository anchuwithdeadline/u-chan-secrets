import { buildEntry, normalizeDomain } from './allowlist.js'
import type { AllowlistStore } from './allowlist.js'
import { redact } from './redact.js'
import {
  UserFacingError,
  type Approver,
  type AuditEvent,
  type AuditLog,
  type ApprovalMode,
  type CoreApi,
  type LoginRunner,
  type Selectors,
  type ToolResult,
  type VaultClient,
} from './types.js'

export interface CoreDeps {
  vault: VaultClient
  allowlist: AllowlistStore
  approver: Approver
  audit: AuditLog
  login: LoginRunner
  mode: () => Promise<ApprovalMode>
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
      const out = await this.deps.login.run(entry, getCreds)
      if (out.status === 'logged_in') return { result: { ok: true, message: 'logged in' }, audit: 'ok' }
      if (out.status === 'already_logged_in') return { result: { ok: true, message: 'already logged in' }, audit: 'already' }
      const message = out.reason ?? 'login failed'
      return { result: { ok: false, message }, audit: `failed: ${message}` }
    })
  }

  requestAllow(domain: string, loginUrl: string, item: string, selectors?: Selectors): Promise<ToolResult> {
    return this.guarded('request_allow', domain, [], async () => {
      const d = domainOf(domain)
      const existing = await this.deps.allowlist.get(d)
      let entry = buildEntry(d, clean(loginUrl), clean(item), existing)
      const sel = Object.fromEntries(
        Object.entries(selectors ?? {}).flatMap(([k, v]) => (typeof v === 'string' && clean(v) ? [[k, clean(v)]] : [])),
      ) as Selectors
      if (Object.keys(sel).length) entry = { ...entry, selectors: sel }
      const approved = await this.deps.approver.ask('U-Chan Secrets', [
        'Allow the AI to sign in?',
        `Domain: ${entry.domain}`,
        `Login URL: ${new URL(entry.loginUrl).href}`,
        `Bitwarden item: ${entry.item}`,
        `Hosts: ${entry.hosts.join(', ')}`,
        ...(Object.keys(sel).length ? [`Selectors: ${Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(', ')}`] : []),
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
      const message = `vault: ${vault}; mode: ${await this.deps.mode()}`
      return { result: { ok: vault === 'unlocked', message }, audit: '' }
    })
  }
}
