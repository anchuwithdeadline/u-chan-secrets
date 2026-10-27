import type { Locator, Page } from 'playwright'
import { isHostAllowed } from './allowlist.js'
import type { AllowEntry, Credentials } from './types.js'

export type FillOutcome = { status: 'logged_in' | 'already_logged_in' | 'failed'; reason?: string }

const USERNAME_CSS = '[autocomplete=username], [type=email], [name*=email i], [name*=user i], [id*=email i]'

const visible = (l: Locator) => l.filter({ visible: true }).first()

/**
 * Fills a login form only while the page host passes `hostCheck`. The check is repeated
 * immediately before every fill sequence; outcomes never contain credential values.
 */
export async function fillLogin(
  page: Page,
  entry: AllowEntry,
  getCreds: () => Promise<Credentials>,
  opts: { timeoutMs?: number; hostCheck?: (url: string) => boolean } = {},
): Promise<FillOutcome> {
  const timeout = opts.timeoutMs ?? 15000
  const hostCheck = opts.hostCheck ?? ((url: string) => isHostAllowed(entry, url))
  const badHost = (): FillOutcome | undefined => {
    const url = page.url()
    if (hostCheck(url)) return undefined
    let host = 'unknown'
    try { host = new URL(url).hostname } catch { /* keep unknown */ }
    return { status: 'failed', reason: `unexpected host ${host}` }
  }

  await page.goto(entry.loginUrl, { waitUntil: 'load', timeout })
  const hostFail = badHost()
  if (hostFail) return hostFail

  const sel = entry.selectors
  const userBox = visible(page.locator(sel?.username ?? USERNAME_CSS))
  const passBox = visible(page.locator(sel?.password ?? 'input[type=password]'))
  const submitBtn = visible(page.locator(sel?.submit ?? 'button[type=submit], input[type=submit]'))

  const [hasUser, hasPass, hasSubmit] = await Promise.all([userBox.isVisible(), passBox.isVisible(), submitBtn.isVisible()])
  if (!hasUser && !hasPass) return { status: 'already_logged_in' }
  if (!hasUser) return { status: 'failed', reason: 'username field not found' }

  const creds = await getCreds()
  const submit = async () => (hasSubmit ? submitBtn.click({ timeout }) : page.keyboard.press('Enter'))

  if (hasPass) {
    const fail = badHost()
    if (fail) return fail
    // No other awaits between the host check and submit.
    await userBox.fill(creds.username, { timeout })
    await passBox.fill(creds.password, { timeout })
    await submit()
  } else {
    const fail = badHost()
    if (fail) return fail
    await userBox.fill(creds.username, { timeout })
    await submit()
    try {
      await passBox.waitFor({ state: 'visible', timeout })
    } catch {
      return { status: 'failed', reason: 'password field did not appear' }
    }
    const fail2 = badHost()
    if (fail2) return fail2
    await passBox.fill(creds.password, { timeout })
    await submit()
  }

  await page.waitForLoadState('load', { timeout }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {})
  if (await passBox.isVisible()) return { status: 'failed', reason: 'login form still present (sai mật khẩu?)' }
  return { status: 'logged_in' }
}
