import { buildEntry, clean, cleanSelectors, isValidEntry, normalizeDomain, selectorsLine } from '../core/allowlist.js'
import type { AllowlistStore } from '../core/allowlist.js'
import { LOGIN_MSG, type BitwardenVault } from '../core/vault.js'
import { redact } from '../core/redact.js'
import { UserFacingError, type AllowEntry, type ApprovalMode, type AuditEvent, type AuditLog, type ControlApi, type ToolResult } from '../core/types.js'
import type { AttemptLimiter } from './attempts.js'
import type { PolicyApprover } from './policy-approver.js'
import type { SettingsStore } from './settings.js'
import { GrantCoordinator } from './grants.js'

const BLOCKED = 'too many wrong passwords — try again in 15 minutes'
const TITLE = 'U-Chan Secrets'

interface Deps {
  grants?: GrantCoordinator
  diagnose?: () => Promise<import('../core/doctor.js').ServiceDiagnostic>
  vault: BitwardenVault
  approver: PolicyApprover
  limiter: AttemptLimiter
  settings: SettingsStore
  allowlist: AllowlistStore
  audit: AuditLog
  platform: NodeJS.Platform
  updater?: { update(): Promise<ToolResult> }
}

/** Commands from the `u-chan` CLI. Audit entries never contain passwords or sessions. */
export class ControlService implements ControlApi {
  private readonly grants: GrantCoordinator
  constructor(private readonly d: Deps) { this.grants = d.grants ?? new GrantCoordinator(d.allowlist) }
  async capabilities(): Promise<ToolResult> {
    return { ok: true, message: JSON.stringify({ protocol: 3, features: ['doctor', 'success_conditions', 'grants'] }) }
  }
  async diagnose(): Promise<ToolResult> {
    try { return { ok: true, message: JSON.stringify(await this.d.diagnose?.() ?? { assets: 'unknown', permissions: 'unknown', vault: 'unknown' }) } }
    catch { return { ok: false, message: 'service diagnostics unavailable' } }
  }

  private async guarded(action: AuditEvent['action'], fn: () => Promise<ToolResult>): Promise<ToolResult> {
    let result: ToolResult
    try {
      result = await fn()
    } catch (err) {
      if (err instanceof UserFacingError) result = { ok: false, message: err.message }
      else {
        console.error(redact(String((err as { stack?: unknown } | null)?.stack ?? err), []))
        result = { ok: false, message: 'internal error' }
      }
    }
    try {
      await this.d.audit.record({ action, domain: '', result: result.ok ? (action === 'unlock' || action === 'lock' ? 'ok' : result.message) : `failed: ${result.message}` })
    } catch {
      console.error('audit write failed')
    }
    return result
  }

  /** Asks for the master password and verifies it with `check`; counts failures on the shared limiter. */
  private async checkedPassword(lines: string[], check: (pw: string) => Promise<boolean>): Promise<ToolResult | null> {
    const { limiter, approver } = this.d
    if (limiter.blocked()) return { ok: false, message: BLOCKED }
    const pw = await approver.askPassword(TITLE, lines)
    if (pw === null) return { ok: false, message: limiter.blocked() ? BLOCKED : 'cancelled' }
    if (await check(pw)) {
      limiter.reset()
      return null
    }
    limiter.fail()
    return { ok: false, message: 'wrong password' }
  }

  unlock(): Promise<ToolResult> {
    return this.guarded('unlock', async () => {
      if ((await this.d.vault.status()) === 'unauthenticated') return { ok: false, message: LOGIN_MSG }
      const refused = await this.checkedPassword(['Unlock the vault'], (pw) => this.d.vault.unlock(pw))
      return refused ?? { ok: true, message: 'unlocked' }
    })
  }

  lock(): Promise<ToolResult> {
    return this.guarded('lock', async () => {
      await this.d.vault.lock()
      return { ok: true, message: 'locked' }
    })
  }

  setMode(mode: ApprovalMode): Promise<ToolResult> {
    return this.guarded('mode', async () => {
      if (mode === 'easy') {
        if (this.d.platform === 'darwin') return { ok: false, message: 'easy mode is not available on macOS' }
        const refused = await this.checkedPassword(['Switch to easy mode (approvals by click)'], (pw) => this.d.vault.verify(pw))
        if (refused) return refused
      }
      await this.d.settings.update({ mode })
      return { ok: true, message: mode }
    })
  }

  importV1(entries: unknown[]): Promise<ToolResult> {
    return this.grants.run(() => this.guarded('import', async () => {
      const valid = entries.filter(isValidEntry)
      let imported = 0
      for (const e of valid) {
        let entry: AllowEntry
        try {
          entry = buildEntry(clean(e.domain), clean(e.loginUrl), clean(e.item))
          const extra = e.hosts.map((h) => normalizeDomain(clean(h))).filter(Boolean)
          entry = { ...entry, hosts: [...new Set([...entry.hosts, ...extra])] }
          const selectors = cleanSelectors((e as { selectors?: unknown }).selectors)
          if (selectors) entry = { ...entry, selectors }
        } catch {
          continue
        }
        const ok = await this.d.approver.ask(TITLE, [
          'Import this V1 allowlist entry?',
          `Domain: ${entry.domain}`,
          `Login URL: ${new URL(entry.loginUrl).href}`,
          `Bitwarden item: ${entry.item}`,
          `Hosts: ${entry.hosts.join(', ')}`,
          ...(entry.selectors ? [selectorsLine(entry.selectors)] : []),
          'Duration: permanent future logins.',
          'Revocation does not log out sessions already transferred to Chrome.',
        ])
        if (!ok) continue
        await this.d.allowlist.upsert(entry)
        imported++
      }
      return { ok: true, message: `imported ${imported} of ${valid.length}` }
    }))
  }

  async audit(limit?: number): Promise<ToolResult> {
    try {
      const records = await this.d.audit.readTail(limit)
      if (records.length === 0) return { ok: true, message: 'no audit log entries' }
      const message = records
        .map((r) => `${r.ts}  ${r.action.padEnd(13)}  ${r.domain ? r.domain + '  ' : ''}${r.result}`)
        .join('\n')
      return { ok: true, message }
    } catch {
      return { ok: false, message: 'could not read audit log' }
    }
  }

  update(): Promise<ToolResult> {
    return this.guarded('update', () =>
      this.d.updater ? this.d.updater.update() : Promise.resolve({ ok: false, message: 'updater not available' }),
    )
  }
}
