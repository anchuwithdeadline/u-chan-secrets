import type { Browser } from 'playwright'
import { fillLogin, type FillOutcome } from '../core/login-filler.js'
import type { AllowEntry, Credentials, LoginRunner, SessionTarget } from '../core/types.js'
import { filterState } from './session-transfer.js'
import { UserFacingError } from '../core/types.js'

/** Signs in inside a service-owned browser, then hands only the entry's session to the user's Chrome. */
export class IsolatedLogin implements LoginRunner {
  private browser?: Browser
  private readonly launch: () => Promise<Browser>
  private readonly target: SessionTarget
  private readonly timeoutMs?: number
  private readonly hostCheck?: (url: string) => boolean

  constructor(o: { launch: () => Promise<Browser>; target: SessionTarget; timeoutMs?: number; hostCheck?: (url: string) => boolean }) {
    this.launch = o.launch
    this.target = o.target
    this.timeoutMs = o.timeoutMs
    this.hostCheck = o.hostCheck
  }

  async preflight(): Promise<void> {
    try { await this.target.userAgent() } catch { throw new UserFacingError('dedicated Chrome is unavailable; start its launcher', 'chrome_unavailable') }
  }

  async run(entry: AllowEntry, getCreds: () => Promise<Credentials>, options: { signal?: AbortSignal; beforeTransfer?: () => Promise<void> } = {}): Promise<FillOutcome> {
    const deadline = AbortSignal.timeout(60000)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    signal.throwIfAborted()
    if (!this.browser?.isConnected()) this.browser = await this.launch()
    const ctx = await this.browser.newContext({ userAgent: await this.target.userAgent() })
    let closing: Promise<void> | undefined
    const close = () => closing ??= ctx.close().catch(() => {})
    const abort = () => { void close() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const page = await ctx.newPage()
      const outcome = await fillLogin(page, entry, getCreds, { timeoutMs: this.timeoutMs, hostCheck: this.hostCheck })
      if (outcome.status === 'failed') return { ...outcome, code: outcome.reason?.includes('needs you') ? 'needs_human' : outcome.reason?.includes('form still present') || outcome.reason?.includes('rejected') ? 'authentication_unconfirmed' : 'unsupported_form' }
      if (entry.success) {
        let matched = false
        try {
          matched = 'url' in entry.success ? page.url() === entry.success.url : await page.locator(entry.success.selector).first().isVisible()
        } catch {}
        if (!matched) return { status: 'failed', code: 'success_condition_failed', reason: 'approved success condition was not met; session was not transferred' }
      }
      signal.throwIfAborted()
      await options.beforeTransfer?.()
      const state = filterState(await ctx.storageState(), entry.hosts)
      signal.throwIfAborted()
      await options.beforeTransfer?.()
      try {
        await this.target.inject(state)
      } catch {
        return { status: 'failed', reason: 'could not hand the session to Chrome', code: 'session_transfer_failed' }
      }
      return entry.success ? { status: 'logged_in' } : { status: 'unconfirmed', code: 'authentication_unconfirmed', reason: 'session state transferred to Chrome; sign-in was not confirmed; inspect the site before continuing' }
    } catch (e) {
      if (signal.aborted) return { status: 'failed', code: 'login_timeout', reason: 'login cancelled or timed out; retry with fresh approval if needed' }
      throw e
    } finally {
      signal.removeEventListener('abort', abort)
      await close()
    }
  }
}
