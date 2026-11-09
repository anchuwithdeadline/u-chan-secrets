import type { ResultCode, ToolResult } from './types.js'

const RETRY_GRANT = 'Call request_allow again; the user must approve a new grant.'
const START_BROWSER = 'Ask the user to run u-chan setup --start-browser, then retry login.'
const CHECK_PAGE = 'Check the page with Playwright before continuing; do not retry login blindly.'

export const NEXT_STEP: Partial<Record<ResultCode, string>> = {
  grant_missing: 'Ask the user which Bitwarden item to use, then call request_allow.',
  grant_expired: RETRY_GRANT,
  grant_exhausted: RETRY_GRANT,
  vault_locked: 'Call request_unlock once (or ask the user to run u-chan unlock), then retry login.',
  vault_unauthenticated: 'Ask the user to rerun u-chan install from an elevated terminal to finish the service Bitwarden login.',
  vault_unavailable: 'Ask the user to run u-chan doctor.',
  chrome_unavailable: START_BROWSER,
  browser_unavailable: START_BROWSER,
  needs_human: 'Ask the user to sign in by hand in the dedicated browser, then continue with Playwright. No further U-Chan call is needed.',
  unsupported_form: 'Ask the user to sign in by hand in the dedicated browser, then continue with Playwright.',
  authentication_unconfirmed: 'Check the page with Playwright. If it is signed in, call request_allow again with success.url set to that page URL so future logins are confirmed.',
  destination_unconfirmed: CHECK_PAGE,
  session_transfer_failed: CHECK_PAGE,
  success_condition_failed: 'Ask the user whether the approved success condition is still correct; propose a new one with request_allow if not.',
  login_timeout: 'Retry login once; if it times out again, call status.',
  unsupported_service: 'Ask the user to run u-chan update --check and follow its output; if the service is unreachable, ask them to run u-chan doctor.',
}

/** `[code] message`, plus a `Next:` line when the code has a hint. */
export function resultText(r: ToolResult): string {
  if (!r.code) return r.message
  const hint = NEXT_STEP[r.code]
  return `[${r.code}] ${r.message}${hint ? `\nNext: ${hint}` : ''}`
}
