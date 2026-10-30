import type { Page } from 'playwright'
import { setTimeout as delay } from 'node:timers/promises'
import type { SuccessCondition } from './types.js'

/** Poll only approved evidence; page values and browser errors never become public diagnostics. */
export async function waitForLoginSuccess(page: Page, success: SuccessCondition, hostCheck: (url: string) => boolean,
  signal?: AbortSignal, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  try {
    do {
      signal?.throwIfAborted()
      if (!hostCheck(page.url())) return false
      const matched = 'url' in success ? page.url() === success.url : await page.locator(success.selector).first().isVisible()
      if (matched && hostCheck(page.url())) return true
      if (Date.now() >= deadline) return false
      await delay(Math.min(100, Math.max(0, deadline - Date.now())), undefined, { signal })
    } while (Date.now() <= deadline)
    return false
  } catch { if (signal?.aborted) signal.throwIfAborted(); return false }
}
