import type { Browser, BrowserContext } from 'playwright'
import { fillLogin, type FillOutcome } from '../core/login-filler.js'
import { isHostAllowed } from '../core/allowlist.js'
import { abortable } from '../core/abort.js'
import type { AllowEntry, Credentials, LoginRunner, SessionTarget } from '../core/types.js'
import { filterState } from './session-transfer.js'
import { UserFacingError } from '../core/types.js'

/** Signs in inside a service-owned browser, then hands only the entry's session to the user's Chrome. */
export class IsolatedLogin implements LoginRunner {
  private browser?: Browser
  private cancellation?: () => Promise<void>
  constructor(private readonly o: { launch: () => Promise<Browser>; target: SessionTarget; timeoutMs?: number; hostCheck?: (url: string) => boolean }) {}
  async cancel(): Promise<void> {
    if (this.cancellation) await this.cancellation()
    else await this.o.target.cancel?.()
  }
  async preflight(signal?: AbortSignal): Promise<void> {
    const check = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
    try { await abortable(this.o.target.userAgent(check), check, async () => { await this.o.target.cancel?.() }) }
    catch { throw new UserFacingError(signal?.aborted ? 'login timed out; retry if needed' : 'dedicated Chrome is unavailable; start its launcher', signal?.aborted ? 'login_timeout' : 'chrome_unavailable') }
  }
  async run(entry: AllowEntry, getCreds: () => Promise<Credentials>, options: { signal?: AbortSignal; beforeTransfer?: () => Promise<void> } = {}): Promise<FillOutcome> {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)
    const hostCheck = this.o.hostCheck ?? ((url: string) => isHostAllowed(entry, url))
    let browser = this.browser, ctx: BrowserContext | undefined
    let closing: Promise<void> | undefined, stopping: Promise<void> | undefined
    const closeBrowser = async () => {
      const current = browser
      if (this.browser === current) this.browser = undefined
      await current?.close().catch(() => {})
    }
    const closeContext = () => closing ??= ctx ? abortable(ctx.close(), AbortSignal.timeout(2000), closeBrowser).catch(() => {}) : Promise.resolve()
    const stop = () => stopping ??= Promise.allSettled([
      ctx ? closeContext() : closeBrowser(),
      this.o.target.cancel?.(),
    ]).then(() => {})
    this.cancellation = stop
    try {
      signal.throwIfAborted()
      const userAgent = await abortable(this.o.target.userAgent(signal), signal, stop)
      if (!browser?.isConnected()) {
        browser = await abortable(this.o.launch(), signal, stop, b => b.close())
        this.browser = browser
      }
      ctx = await abortable(browser.newContext({ userAgent }), signal, stop, c => c.close())
      const page = await abortable(ctx.newPage(), signal, stop, p => p.close())
      const checkHost = () => {
        if (!hostCheck(page.url())) throw new UserFacingError('unexpected login host; session was not transferred', 'unsupported_form')
      }
      const outcome = await abortable(fillLogin(page, entry, getCreds, { timeoutMs: this.o.timeoutMs, hostCheck }), signal, stop)
      if (outcome.status === 'failed') return { ...outcome, code: outcome.reason?.includes('needs you') ? 'needs_human' : outcome.reason?.includes('form still present') || outcome.reason?.includes('rejected') ? 'authentication_unconfirmed' : 'unsupported_form' }
      checkHost()
      if (entry.success) {
        let matched = false
        try {
          matched = 'url' in entry.success ? page.url() === entry.success.url : await abortable(page.locator(entry.success.selector).first().isVisible(), signal, stop)
        } catch (e) { if (signal.aborted) throw e }
        checkHost()
        if (!matched) return { status: 'failed', code: 'success_condition_failed', reason: 'approved success condition was not met; session was not transferred' }
      }
      signal.throwIfAborted()
      await options.beforeTransfer?.()
      checkHost()
      const state = filterState(await abortable(ctx.storageState(), signal, stop), entry.hosts)
      signal.throwIfAborted()
      await options.beforeTransfer?.()
      checkHost()
      try { await abortable(this.o.target.inject(state, signal), signal, stop) }
      catch (e) {
        if (signal.aborted) throw e
        return { status: 'failed', reason: 'could not hand the session to Chrome', code: 'session_transfer_failed' }
      }
      return entry.success ? { status: 'logged_in' } : { status: 'unconfirmed', code: 'authentication_unconfirmed', reason: 'session state transferred to Chrome; sign-in was not confirmed; inspect the site before continuing' }
    } catch (e) {
      if (signal.aborted) return { status: 'failed', code: 'login_timeout', reason: 'login cancelled or timed out; retry with fresh approval if needed' }
      if (e instanceof UserFacingError && e.code === 'unsupported_form') return { status: 'failed', code: e.code, reason: e.message }
      throw e
    } finally {
      if (signal.aborted) await stop()
      else await closeContext()
      this.cancellation = undefined
    }
  }
}
