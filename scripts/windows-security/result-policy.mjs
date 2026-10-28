const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export function accepted(native, attacker, runId) {
  if (!uuid.test(runId ?? '') || !native || !attacker) return false
  const expected = ['nonElevated', 'hookPositiveControl', 'capturePositiveControl', 'desktopReadDenied', 'desktopHookDenied', 'desktopSwitchDenied', 'replyPipeConnectDenied', 'replyPipeSpoofDenied']
  return native.ok === true && native.runId === runId && attacker.runId === runId && expected.every(k => attacker[k] === 'True') && attacker.postClickAccepted === 'False' && attacker.replyPipeConnected === 'False' && attacker.printWindowSawMarker === 'False' && attacker.screenCaptureSawMarker === 'False' && attacker.protectedCanaryEvents === '0'
}
export function moduleAuditSucceeded(audit) {
  return !!audit && Number.isInteger(audit.modules) && audit.modules > 0 && audit.unreadableLive === 0 && Array.isArray(audit.outside) && audit.outside.length === 0 && audit.bitwardenObserved === true && audit.browserObserved === true
}
