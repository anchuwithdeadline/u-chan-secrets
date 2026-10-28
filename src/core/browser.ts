import { execFile } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { SessionState } from '../service/session-transfer.js'
import { UserFacingError, type SessionTarget } from './types.js'
import { abortable } from './abort.js'

export interface BrowserProvider {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>
  connected(): Promise<boolean>
}

export interface CdpOptions {
  /** Starts Chrome when CDP is down; may return before Chrome is listening. */
  launch?: () => Promise<void>
  launchTimeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
      if (!autoLaunch || !this.opts.launch) throw new UserFacingError('Chrome is not running — run scripts/start-chrome.ps1')
    }
    const fail = () => new UserFacingError('could not start Chrome — run scripts/start-chrome.ps1')
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
    if (!context) throw new UserFacingError('Chrome has no default window — open Chrome with scripts/start-chrome.ps1')
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
    if (!context) throw new UserFacingError('Chrome has no default window — open Chrome with scripts/start-chrome.ps1')
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

/** Receives a session (cookies + localStorage) into the user's Chrome over CDP. */
export class CdpSessionTarget implements SessionTarget {
  constructor(private readonly provider: CdpBrowserProvider) {}

  userAgent(signal?: AbortSignal): Promise<string> {
    return this.provider.withPage((page) => page.evaluate(() => navigator.userAgent), signal)
  }
  cancel(): Promise<void> { return this.provider.disconnect() }

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
