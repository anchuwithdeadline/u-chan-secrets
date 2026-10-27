import type { ElementHandle, Locator, Page } from 'playwright'
import { isHostAllowed } from './allowlist.js'
import { UserFacingError, type AllowEntry, type Credentials } from './types.js'

export type FillOutcome = { status: 'logged_in' | 'already_logged_in' | 'failed'; reason?: string }

const USERNAME_CSS = '[autocomplete=username], [type=email], [name*=email i], [name*=user i], [id*=email i]'

const visible = (l: Locator) => l.filter({ visible: true }).first()

/**
 * Playwright puts the filled value into its error call log, so any action that
 * handles credentials is rethrown with a fixed message and no cause.
 */
async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    throw new UserFacingError(`failed to ${what}`)
  }
}

/**
 * Fills a login form only while the page host passes `hostCheck`. A synchronous
 * check runs immediately before every fill/click, and fills go through element
 * handles so a navigation after the check makes the action throw instead of
 * landing in a different document. Outcomes and errors never contain credentials.
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
  const submitBox = visible(page.locator(sel?.submit ?? 'button[type=submit], input[type=submit]'))
  const handleOf = async (l: Locator): Promise<ElementHandle | null> =>
    (await l.isVisible()) ? l.elementHandle({ timeout }) : null

  // Forms may render late; wait briefly before concluding there is none.
  await userBox.or(passBox).first().waitFor({ state: 'visible', timeout: Math.min(timeout, 3000) }).catch(() => {
    // No field appeared in the window: handled below as already logged in.
  })
  const [hasUser, hasPass] = await Promise.all([userBox.isVisible(), passBox.isVisible()])
  if (!hasUser && !hasPass) return { status: 'already_logged_in' }
  if (!hasUser) return { status: 'failed', reason: 'username field not found' }

  const creds = await getCreds()

  // Each action: sync host check, then only the action itself (no awaits in between).
  const submit = async (h: ElementHandle | null): Promise<FillOutcome | undefined> => {
    const fail = badHost()
    if (fail) return fail
    await guard('submit', () => (h ? h.click({ timeout }) : page.keyboard.press('Enter')))
    return undefined
  }

  const userH = await handleOf(userBox)
  if (!userH) return { status: 'failed', reason: 'username field not found' }
  let passH = hasPass ? await handleOf(passBox) : null
  let submitH = await handleOf(submitBox)
  let fail: FillOutcome | undefined

  if (passH) {
    if ((fail = badHost())) return fail
    await guard('fill username field', () => userH.fill(creds.username, { timeout }))
    if ((fail = badHost())) return fail
    await guard('fill password field', () => passH!.fill(creds.password, { timeout }))
    if ((fail = await submit(submitH))) return fail
  } else {
    if ((fail = badHost())) return fail
    await guard('fill username field', () => userH.fill(creds.username, { timeout }))
    if ((fail = await submit(submitH))) return fail
    try {
      await passBox.waitFor({ state: 'visible', timeout })
    } catch {
      return { status: 'failed', reason: 'password field did not appear' }
    }
    passH = await handleOf(passBox)
    submitH = await handleOf(submitBox) // re-measured for step 2
    if (!passH) return { status: 'failed', reason: 'password field did not appear' }
    if ((fail = badHost())) return fail
    await guard('fill password field', () => passH!.fill(creds.password, { timeout }))
    if ((fail = await submit(submitH))) return fail
  }

  // Wait for the submitted form to go away (navigation or detach), then judge the final page.
  const before = page.url()
  await Promise.race([
    page.waitForURL((u) => u.href !== before, { timeout }),
    (passH ?? userH).waitForElementState('hidden', { timeout }),
  ]).catch(() => {
    // Timeout or disposed handle: the state check below decides.
  })
  await page.waitForLoadState('load', { timeout }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {})

  if ((fail = badHost())) return fail
  if ((await userBox.isVisible()) || (await passBox.isVisible())) {
    return { status: 'failed', reason: 'login form still present (sai mật khẩu?)' }
  }
  return { status: 'logged_in' }
}
