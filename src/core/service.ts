import { buildEntry, clean, cleanSelectors, normalizeDomain, selectorsLine } from './allowlist.js'
import type { AllowlistStore } from './allowlist.js'
import { redact } from './redact.js'
import { validOptions } from './policy.js'
import { isHostAllowed } from './allowlist.js'
import type { AllowOptions } from './types.js'
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
      result = { ok: false, message, ...(err instanceof UserFacingError && err.code ? { code: err.code } : {}) }
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
      return { result: { ok: false, message, ...(out.code ? { code: out.code } : {}) }, audit: `failed: ${message}` }
    })
  }

  requestAllow(domain: string, loginUrl: string, item: string, selectors?: Selectors, options?: AllowOptions): Promise<ToolResult> {
    return this.guarded('request_allow', domain, [], async () => {
      if (options !== undefined && !validOptions(options)) throw new UserFacingError('invalid approval policy or success condition', 'invalid_policy')
      if (options?.grant) throw new UserFacingError('temporary approval is not available yet', 'unsupported_service')
      const d = domainOf(domain)
      const existing = await this.deps.allowlist.get(d)
      let entry = buildEntry(d, clean(loginUrl), clean(item), existing)
      const sel = cleanSelectors(selectors)
      if (sel) entry = { ...entry, selectors: sel }
      if (options?.success) entry = { ...entry, success: options.success }
      if (entry.success && 'url' in entry.success && !isHostAllowed(entry, entry.success.url)) throw new UserFacingError('success URL must use an approved HTTPS host', 'invalid_policy')
      const approved = await this.deps.approver.ask('U-Chan Secrets', [
        'Allow the AI to sign in?',
        `Domain: ${entry.domain}`,
        `Login URL: ${new URL(entry.loginUrl).href}`,
        `Bitwarden item: ${entry.item}`,
        `Hosts: ${entry.hosts.join(', ')}`,
        ...(entry.selectors ? [selectorsLine(entry.selectors)] : []),
        ...(entry.success ? [`Success condition: ${JSON.stringify(entry.success)}`] : []),
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
