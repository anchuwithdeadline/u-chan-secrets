import type { ElementHandle, Locator, Page } from 'playwright'
import { isHostAllowed } from './allowlist.js'
import { freshTotpCode } from './totp.js'
import { UserFacingError, type AllowEntry, type Credentials } from './types.js'

export type FillOutcome = { status: 'logged_in' | 'already_logged_in' | 'failed'; reason?: string }

export const NEEDS_YOU = 'needs you — sign in by hand this time'
const CHALLENGE_CSS =
  'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"]'

const USERNAME_CSS = '[autocomplete=username], [type=email], [name*=email i], [name*=user i], [id*=email i]'
const OTP_CSS =
  'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="2fa" i], input[name="code"], input[id="code"]'

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
  const otpBox = visible(page.locator(sel?.otp ?? OTP_CSS))
  const handleOf = async (l: Locator): Promise<ElementHandle | null> =>
    (await l.isVisible()) ? l.elementHandle({ timeout }) : null

  // Forms may render late; wait briefly before concluding there is none.
  await userBox.or(passBox).first().waitFor({ state: 'visible', timeout: Math.min(timeout, 3000) }).catch(() => {
    // No field appeared in the window: handled below as already logged in.
  })
  const [hasUser, hasPass] = await Promise.all([userBox.isVisible(), passBox.isVisible()])
  if (!hasUser && !hasPass) return { status: 'already_logged_in' }
  if (!hasUser) return { status: 'failed', reason: 'username field not found' }

  if (await visible(page.locator(CHALLENGE_CSS)).isVisible()) return { status: 'failed', reason: NEEDS_YOU }

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
  let otpFilled = false

  // 2FA code, at most once per login so a bad seed cannot lock the account.
  const fillOtp = async (): Promise<FillOutcome | undefined> => {
    if (!creds.totp) return { status: 'failed', reason: 'the page asks for a 2FA code but the Bitwarden item has no TOTP' }
    const code = await freshTotpCode(creds.totp)
    const otpH = await handleOf(otpBox)
    if (!otpH) return { status: 'failed', reason: '2FA field not found' }
    const f = badHost()
    if (f) return f
    await guard('fill 2FA field', () => otpH.fill(code, { timeout }))
    otpFilled = true
    return undefined
  }
  // Some sites put the 2FA field in the same form as the password.
  const fillInlineOtp = async () => ((await otpBox.isVisible()) ? fillOtp() : undefined)

  if (passH) {
    if ((fail = badHost())) return fail
    await guard('fill username field', () => userH.fill(creds.username, { timeout }))
    if ((fail = badHost())) return fail
    await guard('fill password field', () => passH!.fill(creds.password, { timeout }))
    if ((fail = await fillInlineOtp())) return fail
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
    if ((fail = await fillInlineOtp())) return fail
    if ((fail = await submit(submitH))) return fail
  }

  // Wait for the login form to go away, then judge the final page. Wait on locators, not
  // the filled handles: SPAs often re-render the form on submit, detaching those nodes
  // long before the app navigates away.
  await userBox.or(passBox).first().waitFor({ state: 'hidden', timeout }).catch(() => {
    // Timeout: the state check below decides.
  })
  await page.waitForLoadState('load', { timeout }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {})

  if ((fail = badHost())) return fail
  if (await visible(page.locator(CHALLENGE_CSS)).isVisible()) return { status: 'failed', reason: NEEDS_YOU }
  if ((await userBox.isVisible()) || (await passBox.isVisible())) {
    const reason = otpFilled ? 'login form still present (wrong password or 2FA code?)' : 'login form still present (wrong password?)'
    return { status: 'failed', reason }
  }

  // Separate 2FA step after the password.
  if (await otpBox.isVisible()) {
    if (otpFilled) return { status: 'failed', reason: '2FA code rejected (wrong TOTP in Bitwarden?)' }
    const otpSubmitH = await handleOf(submitBox)
    if ((fail = await fillOtp())) return fail
    if ((fail = await submit(otpSubmitH))) return fail
    await otpBox.waitFor({ state: 'hidden', timeout }).catch(() => {
      // Timeout: the check below decides.
    })
    await page.waitForLoadState('load', { timeout }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {})
    if ((fail = badHost())) return fail
    if (await otpBox.isVisible()) return { status: 'failed', reason: '2FA code rejected (wrong TOTP in Bitwarden?)' }
  }
  return { status: 'logged_in' }
}
