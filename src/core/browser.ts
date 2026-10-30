import { execFile } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { SessionState } from '../service/session-transfer.js'
import { UserFacingError, type SessionTarget } from './types.js'
import type { AllowEntry } from './types.js'
import { isHostAllowed } from './allowlist.js'
import { waitForLoginSuccess } from './login-success.js'
import { bounded } from './doctor.js'
import type { BrowserKind } from '../client/browser-choice.js'
import { abortable } from './abort.js'

export interface BrowserProvider {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>
  connected(): Promise<boolean>
}

export interface CdpOptions {
  /** Starts Chrome when CDP is down; may return before Chrome is listening. */
  launch?: () => Promise<void>
  launchTimeoutMs?: number
  validate?: (browser?: BrowserKind) => Promise<boolean>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Request-stage CDP interception checks each real main-frame redirect without rewriting responses. */
async function restrictPageNavigation(page: Page, allowed: (url: string) => boolean, signal?: AbortSignal): Promise<void> {
  const session = await page.context().newCDPSession(page)
  const { frameTree } = await session.send('Page.getFrameTree')
  session.on('Fetch.requestPaused', event => {
    let permit = false
    try { permit = event.frameId !== frameTree.frame.id || (!signal?.aborted && allowed(event.request.url)) } catch {}
    void session.send(permit ? 'Fetch.continueRequest' : 'Fetch.failRequest', permit ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
  })
  // Bypass service workers only on this owned tab; existing registrations and user tabs are unchanged.
  await session.send('Network.setBypassServiceWorker', { bypass: true })
  await session.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] })
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
  private readonly ownedPages = new Set<Page>()
  private readonly openingPages = new Set<Promise<Page>>()

  constructor(
    private readonly endpoint: string,
    private readonly opts: CdpOptions = {},
  ) {}

  private async getBrowser(autoLaunch: boolean, selectedBrowser?: BrowserKind): Promise<Browser> {
    if (this.opts.validate && !await this.opts.validate(selectedBrowser)) throw new UserFacingError('selected dedicated browser identity could not be verified', 'browser_unavailable')
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
      await Promise.allSettled([...this.openingPages].map(opening => bounded(() => opening, undefined, 2000)))
      await Promise.allSettled([...this.ownedPages].map(page => bounded(() => page.close(), undefined, 2000)))
      this.ownedPages.clear()
      const browser = this.browser ?? await this.connecting?.catch(() => undefined)
      this.browser = undefined
      // For connectOverCDP, close disconnects this transport, not the user's Chrome process.
      await browser?.close().catch(() => {})
    })().finally(() => { this.disconnecting = undefined })
  }
  async withPage<T>(fn: (page: Page) => Promise<T>, signal?: AbortSignal, selectedBrowser?: BrowserKind): Promise<T> {
    const browser = await abortable(this.getBrowser(true, selectedBrowser), signal, () => this.disconnect(), b => b.close())
    const context = browser.contexts()[0]
    if (!context) throw new UserFacingError('selected dedicated browser has no default context — run u-chan setup --start-browser', 'browser_unavailable')
    const opening = context.newPage().then(page => { this.ownedPages.add(page); return page })
    this.openingPages.add(opening)
    let page: Page
    try { page = await abortable(opening, signal, () => this.disconnect(), p => p.close()) }
    finally { this.openingPages.delete(opening) }
    page.setDefaultTimeout(5000)
    try {
      signal?.throwIfAborted()
      return await abortable(fn(page), signal, () => this.disconnect())
    } finally {
      await bounded(() => page.close(), undefined, 2000)
      this.ownedPages.delete(page)
    }
  }

  async withContext<T>(fn: (context: BrowserContext) => Promise<T>, signal?: AbortSignal, selectedBrowser?: BrowserKind): Promise<T> {
    const browser = await abortable(this.getBrowser(true, selectedBrowser), signal, () => this.disconnect(), b => b.close())
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
  private selectedBrowser: BrowserKind = 'chrome'
  constructor(private readonly provider: CdpBrowserProvider, private readonly options: { hostCheck?: (entry: AllowEntry, url: string) => boolean; verifyTimeoutMs?: number } = {}) {}

  async bindBrowser(browser: BrowserKind): Promise<boolean> {
    if (browser !== 'chrome' && browser !== 'edge') return false
    this.selectedBrowser = browser
    return true // The immediately following provider operation validates this exact kind against the native process.
  }

  userAgent(signal?: AbortSignal): Promise<string> {
    return this.provider.withPage((page) => page.evaluate(() => navigator.userAgent), signal, this.selectedBrowser)
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
      }, signal, this.selectedBrowser)
    } catch { if (signal?.aborted) signal.throwIfAborted(); return false }
  }

  inject(state: SessionState, signal?: AbortSignal): Promise<void> {
    return this.provider.withContext(async (context) => {
      signal?.throwIfAborted()
      await context.addCookies(state.cookies)
      for (const o of state.origins) {
        signal?.throwIfAborted()
        if (!o.localStorage.length) continue
        await this.provider.withPage(async page => {
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
        }, signal, this.selectedBrowser)
      }
    }, signal, this.selectedBrowser)
  }
}
