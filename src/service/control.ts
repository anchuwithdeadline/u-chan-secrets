import { buildEntry, isValidEntry } from '../core/allowlist.js'
import type { AllowlistStore } from '../core/allowlist.js'
import type { BitwardenVault } from '../core/vault.js'
import { redact } from '../core/redact.js'
import { UserFacingError, type ApprovalMode, type AuditEvent, type AuditLog, type ControlApi, type ToolResult } from '../core/types.js'
import type { AttemptLimiter } from './attempts.js'
import type { PolicyApprover } from './policy-approver.js'
import type { SettingsStore } from './settings.js'

const BLOCKED = 'too many wrong passwords — try again in 15 minutes'
const TITLE = 'U-Chan Secrets'
const clean = (s: string): string => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')

interface Deps {
  vault: BitwardenVault
  approver: PolicyApprover
  limiter: AttemptLimiter
  settings: SettingsStore
  allowlist: AllowlistStore
  audit: AuditLog
  platform: NodeJS.Platform
}

/** Commands from the `u-chan` CLI. Audit entries never contain passwords or sessions. */
export class ControlService implements ControlApi {
  constructor(private readonly d: Deps) {}

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
    return this.guarded('import', async () => {
      const valid = entries.filter(isValidEntry)
      let imported = 0
      for (const e of valid) {
        let entry
        try {
          entry = buildEntry(e.domain, clean(e.loginUrl), clean(e.item), e)
        } catch {
          continue
        }
        const ok = await this.d.approver.ask(TITLE, [
          'Import this V1 allowlist entry?',
          `Domain: ${entry.domain}`,
          `Login URL: ${new URL(entry.loginUrl).href}`,
          `Bitwarden item: ${entry.item}`,
          `Hosts: ${entry.hosts.join(', ')}`,
        ])
        if (!ok) continue
        await this.d.allowlist.upsert(entry)
        imported++
      }
      return { ok: true, message: `imported ${imported} of ${valid.length}` }
    })
  }
}
