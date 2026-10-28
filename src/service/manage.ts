import { performance } from 'node:perf_hooks'
import { clean, normalizeDomain, type AllowlistStore } from '../core/allowlist.js'
import { bounded, type ServiceDiagnostic } from '../core/doctor.js'
import type { AuditLog, ManagementAction, PromptRequest, ToolResult, VaultClient } from '../core/types.js'
import type { GrantCoordinator } from './grants.js'
interface Deps {
  store: AllowlistStore
  grants: GrantCoordinator
  phrase: () => Promise<string>
  vault: Pick<VaultClient, 'status'>
  audit: Pick<AuditLog, 'readTail'>
  diagnose: () => Promise<ServiceDiagnostic>
  show: (request: PromptRequest) => Promise<ManagementAction | null>
  lock: () => Promise<ToolResult>
  unlock: () => Promise<ToolResult>
  revoke: (domain: string) => Promise<ToolResult>
}
export class ManagementService {
  private opened = false
  constructor(private readonly d: Deps) {}
  async open(): Promise<ToolResult> {
    if (this.opened) return { ok: false, message: 'management window is already open' }
    this.opened = true
    let lastAction = ''
    let page = 0
    const deadline = performance.now() + 10 * 60_000
    try {
      for (let i = 0; i < 100 && performance.now() < deadline; i++) {
        const snapshot = await this.d.grants.run(async (): Promise<PromptRequest> => {
          const [entries, status, events, checks] = await Promise.all([
            this.d.store.list(), bounded(() => this.d.vault.status(), 'unavailable' as const),
            bounded(() => this.d.audit.readTail(10), []), bounded(this.d.diagnose, null),
          ])
          const all = entries.filter(e => e.domain === normalizeDomain(e.domain))
          page = Math.min(page, Math.max(0, Math.ceil(all.length / 20) - 1))
          const grants = all.slice(page * 20, page * 20 + 20)
          const lines = ['Vault: ' + status, lastAction, 'Grant page ' + (page + 1) + ': ' + grants.length + ' of ' + entries.length + ' shown. Use Previous/Next for more.']
          for (const e of grants) {
            let label = e.expiresAt ? 'until ' + e.expiresAt : e.remainingUses !== undefined ? e.remainingUses + ' attempts remaining' : 'permanent'
            try { this.d.grants.check(e) } catch { label = e.remainingUses === 0 ? 'exhausted' : 'expired' }
            lines.push(clean(e.domain) + ' — ' + label)
          }
          lines.push('Revocation stops future logins. It does not log out existing Chrome sessions.',
            'Revocation waits for any earlier login to finish.',
            'Diagnostics: assets ' + (checks?.assets ?? 'unknown') + '; permissions ' + (checks?.permissions ?? 'unknown'),
            'Recent activity:')
          for (const e of events.slice(-10)) {
            const ts = Number.isFinite(Date.parse(e.ts)) ? new Date(e.ts).toISOString() : 'unknown time'
            const action = ['login','request_allow','revoke','unlock','lock','mode','import','update'].includes(e.action) ? e.action : 'event'
            const result = e.result.startsWith('failed') ? 'failed' : e.result === 'denied' ? 'denied' : e.result.startsWith('approved') ? 'approved' : 'recorded'
            lines.push(ts + ' ' + action + ' ' + clean(e.domain).slice(0, 253) + ' ' + result)
          }
          return { title: 'U-Chan Secrets — Manage', phrase: await this.d.phrase(), lines: lines.filter(Boolean), domains: grants.map(e => e.domain) }
        })
        // Each native window closes before a protected password prompt can open.
        const action = await this.d.show(snapshot)
        if (!action || action.action === 'close') return { ok: true, message: 'management closed' }
        if (action.action === 'refresh') continue
        if (action.action === 'next') { page++; continue }
        if (action.action === 'previous') { page = Math.max(0, page - 1); continue }
        let result: ToolResult
        if (action.action === 'lock') result = await this.d.lock()
        else if (action.action === 'unlock') result = await this.d.unlock()
        else if (action.action === 'revoke' && typeof action.domain === 'string' && snapshot.domains?.includes(action.domain)) result = await this.d.revoke(action.domain)
        else return { ok: false, message: 'invalid management action or target' }
        lastAction = result.ok ? 'Last action completed.' : 'Last action failed. Run u-chan doctor for guidance.'
      }
      return { ok: true, message: 'management closed after its time or action limit' }
    } catch { return { ok: false, message: 'management unavailable; run u-chan doctor' } }
    finally { this.opened = false }
  }
}
