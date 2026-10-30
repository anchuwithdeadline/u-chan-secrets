import { buildEntry, clean, cleanSelectors, normalizeDomain, selectorsLine } from './allowlist.js'
import type { AllowlistStore } from './allowlist.js'
import { redact } from './redact.js'
import { validOptions } from './policy.js'
import { isHostAllowed } from './allowlist.js'
import type { AllowOptions } from './types.js'
import { GrantCoordinator } from '../service/grants.js'
import { randomUUID } from 'node:crypto'
import { abortable } from './abort.js'
import type { BrowserKind } from '../client/browser-choice.js'
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
  loginTimeoutMs?: number
  grants?: GrantCoordinator
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
  private readonly grants: GrantCoordinator
  constructor(private readonly deps: CoreDeps) { this.grants = deps.grants ?? new GrantCoordinator(deps.allowlist) }

  /** Runs `fn`, maps errors to ToolResults (never leaking details) and audits the outcome. */
  private guarded(
    action: AuditEvent['action'] | undefined, domain: string, secrets: string[],
    fn: () => Promise<{ result: ToolResult; audit: string }>,
  ): Promise<ToolResult> {
    return this.grants.run(() => this.runGuarded(action, domain, secrets, fn))
  }
  private async runGuarded(
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

  login(domain: string, browser: BrowserKind = 'chrome'): Promise<ToolResult> {
    const secrets: string[] = []
    return this.guarded('login', domain, secrets, async () => {
      if (browser !== 'chrome' && browser !== 'edge') throw new UserFacingError('invalid browser selection', 'invalid_policy')
      const entry = await this.deps.allowlist.get(domainOf(domain))
      if (!entry) throw new UserFacingError('domain is not allowlisted — use request_allow', 'grant_missing')
      this.grants.check(entry)
      const signal = AbortSignal.timeout(this.deps.loginTimeoutMs ?? 60000)
      const within = async <T>(work: Promise<T>): Promise<T> => {
        try { return await abortable(work, signal, async () => { await this.deps.login.cancel?.() }) }
        catch (e) { if (signal.aborted) throw new UserFacingError('login timed out; retry if needed', 'login_timeout'); throw e }
      }
      const status = await within(this.deps.vault.status(signal))
      if (status !== 'unlocked') throw new UserFacingError(status === 'locked' ? 'vault locked — run u-chan unlock' : status === 'unauthenticated' ? 'complete Bitwarden service login during setup' : 'Bitwarden is unavailable', status === 'locked' ? 'vault_locked' : status === 'unauthenticated' ? 'vault_unauthenticated' : 'vault_unavailable')
      if (this.deps.login.preflight) await within(this.deps.login.preflight(signal, browser))
      signal.throwIfAborted()
      await this.grants.reserve(entry.domain)
      const getCreds = async () => {
        this.grants.check(entry, true)
        const c = await within(this.deps.vault.getLogin(entry.item, signal))
        secrets.push(c.username, c.password, ...(c.totp ? [c.totp] : []))
        return c
      }
      const out = await this.deps.login.run(entry, getCreds, { signal, browser, beforeTransfer: async () => { signal.throwIfAborted(); this.grants.check(entry, true) } })
      if (out.status === 'logged_in') return { result: { ok: true, message: 'logged in' }, audit: 'ok' }
      if (out.status === 'already_logged_in') return { result: { ok: true, message: 'already logged in' }, audit: 'already' }
      const message = out.reason ?? 'login failed'
      return { result: { ok: false, message, ...(out.code ? { code: out.code } : {}) }, audit: `failed: ${message}` }
    })
  }

  requestAllow(domain: string, loginUrl: string, item: string, selectors?: Selectors, options?: AllowOptions): Promise<ToolResult> {
    return this.guarded('request_allow', domain, [], async () => {
      if (options !== undefined && !validOptions(options)) throw new UserFacingError('invalid approval policy or success condition', 'invalid_policy')
      const d = domainOf(domain)
      const existing = await this.deps.allowlist.get(d)
      let entry = buildEntry(d, clean(loginUrl), clean(item), existing)
      const epoch = this.grants.epoch()
      const grant = options?.grant ?? { kind: 'permanent' }
      delete entry.expiresAt
      delete entry.remainingUses
      entry.grantId = randomUUID()
      if (grant.kind === 'once') entry.remainingUses = 1
      if (grant.kind === 'timed') entry.expiresAt = new Date(this.grants.now() + grant.minutes * 60000).toISOString()
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
        entry.remainingUses !== undefined ? 'Duration: one login attempt; a failed reserved attempt also counts.' : entry.expiresAt ? `Duration: until ${entry.expiresAt}` : 'Duration: permanent future logins.',
        'Expiry and revocation do not log out sessions already transferred to the selected browser.',
      ])
      if (!approved) return { result: { ok: false, message: 'denied' }, audit: 'denied' }
      this.grants.approve(entry, epoch)
      await this.deps.allowlist.upsert(entry)
      return { result: { ok: true, message: 'approved' }, audit: `approved; ${grant.kind}${entry.expiresAt ? '; expires ' + entry.expiresAt : ''}` }
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
      const message = all.map((e) => {
        let policy = e.expiresAt ? 'expires ' + e.expiresAt : e.remainingUses !== undefined ? e.remainingUses + ' attempts remaining' : 'permanent'
        try { this.grants.check(e) } catch (err) { policy = err instanceof UserFacingError && err.code === 'grant_exhausted' ? 'exhausted' : 'expired' }
        return `${e.domain} — ${e.item} — ${e.hosts.join(', ')} — ${policy}`
      }).join('\n')
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
