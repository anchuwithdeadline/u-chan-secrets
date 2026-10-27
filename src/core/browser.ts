import { execFile } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { UserFacingError } from './types.js'

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
      return await chromium.connectOverCDP(this.endpoint)
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

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.getBrowser(true)
    const context = browser.contexts()[0]
    if (!context) throw new UserFacingError('Chrome has no default window — open Chrome with scripts/start-chrome.ps1')
    const page = await context.newPage()
    try {
      return await fn(page)
    } finally {
      await page.close().catch(() => {})
    }
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
