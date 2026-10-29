import { execFile } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { SessionState } from '../service/session-transfer.js'
import { UserFacingError, type SessionTarget } from './types.js'
import type { AllowEntry } from './types.js'
import { isHostAllowed } from './allowlist.js'
import { waitForLoginSuccess } from './login-success.js'
import { abortable } from './abort.js'

export interface BrowserProvider {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>
  connected(): Promise<boolean>
}

export interface CdpOptions {
  /** Starts Chrome when CDP is down; may return before Chrome is listening. */
  launch?: () => Promise<void>
  launchTimeoutMs?: number
  validate?: () => Promise<boolean>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Page-scoped navigation guard; redirect responses are checked before following them. */
async function restrictPageNavigation(page: Page, allowed: (url: string) => boolean, signal?: AbortSignal): Promise<void> {
  await page.route('**/*', async route => {
    const request = route.request()
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) { await route.continue().catch(() => {}); return }
    if (!allowed(request.url()) || signal?.aborted) { await route.abort().catch(() => {}); return }
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10000 }), location = response.headers().location
      if (location && response.status() >= 300 && response.status() < 400 && !allowed(new URL(location, request.url()).href)) { await route.abort(); return }
      if (signal?.aborted) { await route.abort(); return }
      await route.fulfill({ response })
    } catch { await route.abort().catch(() => {}) }
  })
}

/** Runs scripts/start-chrome.ps1 (idempotent: it exits early if the port is already open). */
export const startChromeScript = (scriptPath: string) => (): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { timeout: 30000, windowsHide: true },
      (err) => (err ? reject(err) : resolve()),
    )
  })

/** Attaches to the user's Chrome over CDP so cookies are shared with Playwright MCP. Never closes the browser. */
export class CdpBrowserProvider implements BrowserProvider {
  private disconnecting?: Promise<void>
  private browser?: Browser
  private connecting?: Promise<Browser>

  constructor(
    private readonly endpoint: string,
    private readonly opts: CdpOptions = {},
  ) {}

  private async getBrowser(autoLaunch: boolean): Promise<Browser> {
    if (this.opts.validate && !await this.opts.validate()) throw new UserFacingError('selected dedicated browser identity could not be verified', 'browser_unavailable')
    // Validated service operations reconnect so a browser switch cannot keep using an old cached destination.
    if (this.opts.validate) await this.disconnect()
    if (this.browser?.isConnected()) return this.browser
    this.connecting ??= this.connect(autoLaunch)
      .then((b) => (this.browser = b))
      .finally(() => {
        this.connecting = undefined
      })
    return this.connecting
  }

  private async connect(autoLaunch: boolean): Promise<Browser> {
    try {
      return await chromium.connectOverCDP(this.endpoint, { timeout: 5000 })
    } catch {
      if (!autoLaunch || !this.opts.launch) throw new UserFacingError('selected dedicated browser is not running — run u-chan setup --start-browser', 'browser_unavailable')
    }
    const fail = () => new UserFacingError('could not start the selected dedicated browser — run u-chan setup --start-browser', 'browser_unavailable')
    await this.opts.launch().catch(() => {
      throw fail()
    })
    const deadline = Date.now() + (this.opts.launchTimeoutMs ?? 15000)
    while (Date.now() < deadline) {
      try {
        return await chromium.connectOverCDP(this.endpoint, { timeout: 2000 })
      } catch {
        await sleep(300)
      }
    }
    throw fail()
  }

  disconnect(): Promise<void> {
    return this.disconnecting ??= (async () => {
      const browser = this.browser ?? await this.connecting?.catch(() => undefined)
      this.browser = undefined
      // For connectOverCDP, close disconnects this transport, not the user's Chrome process.
      await browser?.close().catch(() => {})
    })().finally(() => { this.disconnecting = undefined })
  }
  async withPage<T>(fn: (page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const browser = await abortable(this.getBrowser(true), signal, () => this.disconnect(), b => b.close())
    const context = browser.contexts()[0]
    if (!context) throw new UserFacingError('selected dedicated browser has no default context — run u-chan setup --start-browser', 'browser_unavailable')
    const page = await abortable(context.newPage(), signal, () => this.disconnect(), p => p.close())
    page.setDefaultTimeout(5000)
    try {
      signal?.throwIfAborted()
      return await abortable(fn(page), signal, () => this.disconnect())
    } finally {
      await abortable(page.close(), signal, () => this.disconnect()).catch(() => {})
    }
  }

  async withContext<T>(fn: (context: BrowserContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const browser = await abortable(this.getBrowser(true), signal, () => this.disconnect(), b => b.close())
    const context = browser.contexts()[0]
    if (!context) throw new UserFacingError('selected dedicated browser has no default context — run u-chan setup --start-browser', 'browser_unavailable')
    signal?.throwIfAborted()
    return abortable(fn(context), signal, () => this.disconnect())
  }

  async connected(): Promise<boolean> {
    try {
      await this.getBrowser(false)
      return true
    } catch {
      return false
    }
  }
}

/** Receives filtered session state and checks approved evidence in the user's dedicated browser over CDP. */
export class CdpSessionTarget implements SessionTarget {
  constructor(private readonly provider: CdpBrowserProvider, private readonly options: { hostCheck?: (entry: AllowEntry, url: string) => boolean; verifyTimeoutMs?: number } = {}) {}

  userAgent(signal?: AbortSignal): Promise<string> {
    return this.provider.withPage((page) => page.evaluate(() => navigator.userAgent), signal)
  }
  cancel(): Promise<void> { return this.provider.disconnect() }

  async verify(entry: AllowEntry, finalUrl: string, signal?: AbortSignal): Promise<boolean> {
    if (!entry.success) return false
    const allowed = (url: string) => this.options.hostCheck ? this.options.hostCheck(entry, url) : isHostAllowed(entry, url)
    const url = 'url' in entry.success ? entry.success.url : finalUrl
    if (!allowed(url)) return false
    try {
      return await this.provider.withPage(async page => {
        await restrictPageNavigation(page, allowed, signal)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })
        return waitForLoginSuccess(page, entry.success!, allowed, signal, this.options.verifyTimeoutMs ?? 15000)
      }, signal)
    } catch { if (signal?.aborted) signal.throwIfAborted(); return false }
  }

  inject(state: SessionState, signal?: AbortSignal): Promise<void> {
    return this.provider.withContext(async (context) => {
      signal?.throwIfAborted()
      await context.addCookies(state.cookies)
      for (const o of state.origins) {
        signal?.throwIfAborted()
        if (!o.localStorage.length) continue
        const page = await context.newPage()
        page.setDefaultTimeout(5000)
        try {
          await restrictPageNavigation(page, url => { try { return new URL(url).origin === o.origin } catch { return false } }, signal)
          await page.goto(o.origin, { waitUntil: 'commit' })
          signal?.throwIfAborted()
          await page.evaluate(
            ({ origin, items }) => {
              if (location.origin !== origin) throw new Error('origin mismatch')
              for (const i of items) localStorage.setItem(i.name, i.value)
            },
            { origin: o.origin, items: o.localStorage },
          )
        } finally {
          await page.close().catch(() => {})
        }
      }
    }, signal)
  }
}
