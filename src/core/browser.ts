import { chromium, type Browser, type Page } from 'playwright'
import { UserFacingError } from './types.js'

export interface BrowserProvider {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>
  connected(): Promise<boolean>
}

/** Attaches to the user's Chrome over CDP so cookies are shared with Playwright MCP. Never closes the browser. */
export class CdpBrowserProvider implements BrowserProvider {
  private browser?: Browser
  private connecting?: Promise<Browser>

  constructor(private readonly endpoint: string) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser
    this.connecting ??= chromium
      .connectOverCDP(this.endpoint)
      .then((b) => (this.browser = b))
      .catch(() => {
        throw new UserFacingError('Chrome chưa chạy — chạy scripts/start-chrome.ps1')
      })
      .finally(() => {
        this.connecting = undefined
      })
    return this.connecting
  }

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.getBrowser()
    const context = browser.contexts()[0]
    if (!context) throw new UserFacingError('Chrome không có cửa sổ mặc định — mở Chrome bằng scripts/start-chrome.ps1')
    const page = await context.newPage()
    try {
      return await fn(page)
    } finally {
      await page.close().catch(() => {})
    }
  }

  async connected(): Promise<boolean> {
    try {
      await this.getBrowser()
      return true
    } catch {
      return false
    }
  }
}
