import { performance } from 'node:perf_hooks'
import type { AllowlistStore } from '../core/allowlist.js'
import { UserFacingError, type AllowEntry } from '../core/types.js'

/** ponytail: one queue for this single-user service; use per-domain transactions only if throughput requires it. */
export class GrantCoordinator {
  private chain: Promise<unknown> = Promise.resolve()
  private wall: number
  private mono: number
  private generation = 0
  private accepted = new Map<string, string>()
  private rollbackPending = false
  private readonly clock: () => number
  private readonly monotonic: () => number
  constructor(private readonly store: AllowlistStore, clocks: { now?: () => number; monotonic?: () => number } = {}) {
    this.clock = clocks.now ?? Date.now
    this.monotonic = clocks.monotonic ?? (() => performance.now())
    this.wall = this.clock(); this.mono = this.monotonic()
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    const work = async () => {
      this.now()
      await this.persistRollback()
      try { return await operation() }
      finally { await this.persistRollback() }
    }
    const result = this.chain.then(work, work)
    this.chain = result.catch(() => {})
    return result
  }
  now(): number {
    const wall = this.clock(), mono = this.monotonic()
    const expected = this.wall + Math.max(0, mono - this.mono)
    if (wall < expected - 1000) {
      this.generation++
      this.accepted.clear()
      this.rollbackPending = true
      this.wall = wall; this.mono = mono
      return wall
    }
    if (wall > expected) { this.wall = wall; this.mono = mono }
    return Math.max(wall, expected)
  }
  epoch(): number { this.now(); return this.generation }
  approve(entry: AllowEntry, epoch: number): void {
    this.now()
    if (entry.expiresAt && epoch !== this.generation) throw new UserFacingError('clock changed during approval; request approval again', 'grant_expired')
    if (entry.grantId && entry.expiresAt) this.accepted.set(entry.domain, entry.grantId)
    this.check(entry)
  }
  check(entry: AllowEntry, reserved = false): void {
    const now = this.now()
    if (entry.expiresAt && (Date.parse(entry.expiresAt) <= now || (this.generation > 0 && this.accepted.get(entry.domain) !== entry.grantId))) {
      throw new UserFacingError('approval expired or clock moved backward; request approval again', 'grant_expired')
    }
    if (!reserved && entry.remainingUses !== undefined && entry.remainingUses < 1) throw new UserFacingError('once approval has been used; request approval again', 'grant_exhausted')
  }
  private async persistRollback(): Promise<void> {
    if (!this.rollbackPending) return
    for (const entry of await this.store.list()) {
      if (entry.expiresAt && (!entry.grantId || this.accepted.get(entry.domain) !== entry.grantId)) {
        await this.store.upsert({ ...entry, expiresAt: new Date(0).toISOString() })
      }
    }
    this.rollbackPending = false
  }
  async reserve(domain: string): Promise<AllowEntry> {
    const entry = await this.store.get(domain)
    if (!entry) throw new UserFacingError('domain is not allowlisted — use request_allow', 'grant_missing')
    this.check(entry)
    if (entry.remainingUses !== undefined) await this.store.upsert({ ...entry, remainingUses: entry.remainingUses - 1 })
    return entry
  }
}
