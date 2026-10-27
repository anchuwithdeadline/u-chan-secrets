import type { Browser } from 'playwright'
import { fillLogin, type FillOutcome } from '../core/login-filler.js'
import type { AllowEntry, Credentials, LoginRunner, SessionTarget } from '../core/types.js'
import { filterState } from './session-transfer.js'

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

  async run(entry: AllowEntry, getCreds: () => Promise<Credentials>): Promise<FillOutcome> {
    if (!this.browser?.isConnected()) this.browser = await this.launch()
    const ctx = await this.browser.newContext({ userAgent: await this.target.userAgent() })
    try {
      const page = await ctx.newPage()
      const outcome = await fillLogin(page, entry, getCreds, { timeoutMs: this.timeoutMs, hostCheck: this.hostCheck })
      if (outcome.status !== 'logged_in') return outcome
      const state = filterState(await ctx.storageState(), entry.hosts)
      try {
        await this.target.inject(state)
      } catch {
        return { status: 'failed', reason: 'could not hand the session to Chrome' }
      }
      return outcome
    } finally {
      await ctx.close().catch(() => {})
    }
  }
}
