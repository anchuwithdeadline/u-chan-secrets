import type { Browser, BrowserContext } from 'playwright'
import { fillLogin, type FillOutcome } from '../core/login-filler.js'
import { isHostAllowed } from '../core/allowlist.js'
import { abortable } from '../core/abort.js'
import type { AllowEntry, Credentials, LoginRunner, SessionTarget } from '../core/types.js'
import { filterState } from './session-transfer.js'
import { UserFacingError } from '../core/types.js'
import { waitForLoginSuccess } from '../core/login-success.js'
import { createPrivateNetwork } from './private-network.js'
import type { BrowserKind } from '../client/browser-choice.js'

/** Signs in inside a service-owned browser, then verifies only the approved session in the user's selected browser. */
export class IsolatedLogin implements LoginRunner {
  private browser?: Browser
  private cancellation?: () => Promise<void>
  constructor(private readonly o: { launch: () => Promise<Browser>; target: SessionTarget; timeoutMs?: number; hostCheck?: (url: string) => boolean }) {}
  async cancel(): Promise<void> {
    if (this.cancellation) await this.cancellation()
    else await this.o.target.cancel?.()
  }
  async preflight(signal?: AbortSignal, browser: BrowserKind = 'chrome'): Promise<void> {
    const check = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    try {
      if (this.o.target.bindBrowser && !await abortable(this.o.target.bindBrowser(browser, check), check, async () => { await this.o.target.cancel?.() })) throw new Error('browser mismatch')
      await abortable(this.o.target.userAgent(check), check, async () => { await this.o.target.cancel?.() })
    }
    catch { throw new UserFacingError(signal?.aborted ? 'login timed out; retry if needed' : 'selected dedicated browser is unavailable; run u-chan setup --start-browser', signal?.aborted ? 'login_timeout' : 'browser_unavailable') }
  }
  async run(entry: AllowEntry, getCreds: () => Promise<Credentials>, options: { signal?: AbortSignal; beforeTransfer?: () => Promise<void>; browser?: BrowserKind } = {}): Promise<FillOutcome> {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)
    const hostCheck = this.o.hostCheck ?? ((url: string) => isHostAllowed(entry, url))
    let browser = this.browser, ctx: BrowserContext | undefined
    let transferStarted = false
    let network: Awaited<ReturnType<typeof createPrivateNetwork>> | undefined
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
      network?.close(),
    ]).then(() => {})
    this.cancellation = stop
    try {
      signal.throwIfAborted()
      if (this.o.target.bindBrowser && !await abortable(this.o.target.bindBrowser(options.browser ?? 'chrome', signal), signal, stop)) throw new UserFacingError('selected dedicated browser is unavailable or mismatched', 'browser_unavailable')
      const userAgent = await abortable(this.o.target.userAgent(signal), signal, stop)
      if (!browser?.isConnected()) {
        browser = await abortable(this.o.launch(), signal, stop, b => b.close())
        this.browser = browser
      }
      const fixtureOrigin = this.o.hostCheck && new URL(entry.loginUrl).protocol === 'http:' ? new URL(entry.loginUrl).origin : undefined
      network = await abortable(createPrivateNetwork(hostCheck, signal, fixtureOrigin), signal, stop, n => n.close())
      ctx = await abortable(browser.newContext({ userAgent, serviceWorkers: 'block', proxy: network.proxy }), signal, stop, c => c.close())
      const page = await abortable(ctx.newPage(), signal, stop, p => p.close())
      const checkHost = () => {
        if (!hostCheck(page.url())) throw new UserFacingError('unexpected login host; session was not transferred', 'unsupported_form')
      }
      const outcome = await abortable(fillLogin(page, entry, getCreds, { timeoutMs: this.o.timeoutMs, hostCheck }), signal, stop)
      if (outcome.status === 'failed') return network.wasBlocked()
        ? { status: 'failed', code: 'unsupported_form', reason: 'an unapproved private-browser request was blocked; session was not transferred' }
        : { ...outcome, code: outcome.code ?? 'unsupported_form' }
      checkHost()
      if (entry.success) {
        let matched = false
        try {
          matched = await abortable(waitForLoginSuccess(page, entry.success, hostCheck, signal, this.o.timeoutMs ?? 15000), signal, stop)
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
      transferStarted = true
      try { await abortable(this.o.target.inject(state, signal), signal, stop) }
      catch (e) {
        if (signal.aborted) throw e
        return { status: 'failed', reason: 'session transfer did not complete; some browser session state may already exist', code: 'session_transfer_failed' }
      }
      await options.beforeTransfer?.()
      signal.throwIfAborted()
      if (entry.success) {
        const verified = this.o.target.verify ? await abortable(this.o.target.verify(entry, page.url(), signal), signal, stop) : false
        return verified ? { status: 'logged_in' } : { status: 'unconfirmed', code: 'destination_unconfirmed', reason: 'session state was transferred, but login was not confirmed in the selected browser; inspect the site before continuing' }
      }
      return { status: 'unconfirmed', code: 'authentication_unconfirmed', reason: 'session state transferred to the selected browser; sign-in was not confirmed; inspect the site before continuing' }
    } catch (e) {
      if (signal.aborted) return { status: 'failed', code: 'login_timeout', reason: transferStarted ? 'login cancelled or timed out after transfer started; browser session state may already exist and login is unconfirmed' : 'login cancelled or timed out; retry with fresh approval if needed' }
      if (transferStarted) return { status: 'unconfirmed', code: 'destination_unconfirmed', reason: 'destination verification did not complete; browser session state may already exist and login is unconfirmed' }
      if (e instanceof UserFacingError && e.code === 'unsupported_form') return { status: 'failed', code: e.code, reason: e.message }
      throw e
    } finally {
      if (signal.aborted) await stop()
      else await closeContext()
      await network?.close()
      this.cancellation = undefined
    }
  }
}
