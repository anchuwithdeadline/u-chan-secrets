import type { ElementHandle, Locator, Page } from 'playwright'
import { isHostAllowed } from './allowlist.js'
import { freshTotpCode } from './totp.js'
import { UserFacingError, type AllowEntry, type Credentials, type ResultCode } from './types.js'

export type FillOutcome = { status: 'logged_in' | 'already_logged_in' | 'failed' | 'unconfirmed'; reason?: string; code?: import('./types.js').ResultCode }

export const NEEDS_YOU = 'needs you — sign in by hand this time'
const CHALLENGE_CSS =
  'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"]'

const USERNAME_CSS = '[autocomplete=username], [type=email], [name*=email i], [name*=user i], [id*=email i]'
const OTP_CSS =
  'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="2fa" i], input[name="code"], input[id="code"]'

const visible = (l: Locator) => l.filter({ visible: true }).first()
const failed = (reason: string, code: ResultCode = 'unsupported_form'): FillOutcome => ({ status: 'failed', reason, code })

/**
 * Playwright puts the filled value into its error call log, so any action that
 * handles credentials is rethrown with a fixed message and no cause.
 */
async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    throw new UserFacingError(`failed to ${what}`, 'unsupported_form')
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
    return failed('unexpected login host')
  }

  await guard('open approved login page', () => page.goto(entry.loginUrl, { waitUntil: 'domcontentloaded', timeout }))
  const hostFail = badHost()
  if (hostFail) return hostFail

  const sel = entry.selectors
  const userBox = visible(page.locator(sel?.username ?? USERNAME_CSS))
  const passBox = visible(page.locator(sel?.password ?? 'input[type=password]'))
  const submitBox = visible(page.locator(sel?.submit ?? 'button[type=submit], input[type=submit]'))
  const otpBox = visible(page.locator(sel?.otp ?? OTP_CSS))
  const needsHuman = async () => await visible(page.locator(CHALLENGE_CSS)).isVisible()
    || await visible(page.getByText(/(?:use|enter|verify|sign in with) (?:your |a )?passkey|check your (?:phone|device)|approve (?:this |the )?sign.?in/i)).isVisible()
  const handleOf = async (l: Locator): Promise<ElementHandle | null> =>
    (await l.isVisible()) ? l.elementHandle({ timeout }) : null

  // Forms may render late; wait briefly before concluding there is none.
  await userBox.or(passBox).first().waitFor({ state: 'visible', timeout: Math.min(timeout, 3000) }).catch(() => {
    // No field appeared in the window: handled below as already logged in.
  })
  const [hasUser, hasPass] = await Promise.all([userBox.isVisible(), passBox.isVisible()])
  const afterWaitHost = badHost()
  if (afterWaitHost) return afterWaitHost
  if (await needsHuman()) return failed(NEEDS_YOU, 'needs_human')
  if (!hasUser && !hasPass && await otpBox.isVisible()) return failed(NEEDS_YOU, 'needs_human')
  if (!hasUser && !hasPass) return { status: 'already_logged_in' }
  if (!hasUser) return failed('username field not found')


  const creds = await getCreds()

  // Each action: sync host check, then only the action itself (no awaits in between).
  const submit = async (h: ElementHandle | null): Promise<FillOutcome | undefined> => {
    const fail = badHost()
    if (fail) return fail
    await guard('submit', () => (h ? h.click({ timeout }) : page.keyboard.press('Enter')))
    return undefined
  }

  const userH = await handleOf(userBox)
  if (!userH) return failed('username field not found')
  let passH = hasPass ? await handleOf(passBox) : null
  let submitH = await handleOf(submitBox)
  let fail: FillOutcome | undefined
  let otpFilled = false

  // 2FA code, at most once per login so a bad seed cannot lock the account.
  const fillOtp = async (): Promise<FillOutcome | undefined> => {
    if (!creds.totp) return failed('the page asks for a 2FA code but the Bitwarden item has no TOTP', 'needs_human')
    const code = await freshTotpCode(creds.totp)
    const otpH = await handleOf(otpBox)
    if (!otpH) return failed('2FA field not found')
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
      return await needsHuman() ? failed(NEEDS_YOU, 'needs_human') : failed('password field did not appear')
    }
    passH = await handleOf(passBox)
    submitH = await handleOf(submitBox) // re-measured for step 2
    if (!passH) return failed('password field did not appear')
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
  await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout, 3000) }).catch(() => {})

  if ((fail = badHost())) return fail
  if (await needsHuman()) return failed(NEEDS_YOU, 'needs_human')
  if ((await userBox.isVisible()) || (await passBox.isVisible())) {
    const reason = otpFilled ? 'login form still present (wrong password or 2FA code?)' : 'login form still present (wrong password?)'
    return failed(reason, otpFilled ? 'needs_human' : 'authentication_unconfirmed')
  }

  // Separate 2FA step after the password.
  if (await otpBox.isVisible()) {
    if (otpFilled) return failed('2FA code rejected (wrong TOTP in Bitwarden?)', 'needs_human')
    const otpSubmitH = await handleOf(submitBox)
    if ((fail = await fillOtp())) return fail
    if ((fail = await submit(otpSubmitH))) return fail
    await otpBox.waitFor({ state: 'hidden', timeout }).catch(() => {
      // Timeout: the check below decides.
    })
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout, 3000) }).catch(() => {})
    if ((fail = badHost())) return fail
    if (await otpBox.isVisible()) return failed('2FA code rejected (wrong TOTP in Bitwarden?)', 'needs_human')
    if (await needsHuman()) return failed(NEEDS_YOU, 'needs_human')
  }
  return { status: 'logged_in' }
}
