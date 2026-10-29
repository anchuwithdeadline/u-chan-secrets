import { expect, it } from 'vitest'
import { accepted, moduleAuditSucceeded } from '../../scripts/windows-security/result-policy.mjs'
const runId = 'e3d683e5-8aa3-45c3-bb0b-b7030c89bfc9'
const native = { ok: true, runId }
const attacker = { runId, nonElevated: 'True', hookPositiveControl: 'True', capturePositiveControl: 'True', desktopReadDenied: 'True', desktopHookDenied: 'True', desktopSwitchDenied: 'True', replyPipeConnectDenied: 'True', replyPipeSpoofDenied: 'True', postClickAccepted: 'False', replyPipeConnected: 'False', printWindowSawMarker: 'False', screenCaptureSawMarker: 'False', protectedCanaryEvents: '0' }
it('requires fresh matching native and attacker runs, successful controls and actual pipe denial', () => {
  expect(accepted(native, attacker, runId)).toBe(true)
  expect(accepted(native, { ...attacker, runId: 'old-run' }, runId)).toBe(false)
  expect(accepted({ ...native, runId: 'old-run' }, attacker, runId)).toBe(false)
  expect(accepted({ ok: true }, { ...attacker, runId: undefined }, undefined)).toBe(false)
  expect(accepted(native, { ...attacker, hookPositiveControl: 'False' }, runId)).toBe(false)
  expect(accepted(native, { ...attacker, replyPipeConnectDenied: 'False', replyPipeErrorCode: 'timeout' }, runId)).toBe(false)
  expect(accepted(native, { ...attacker, protectedCanaryEvents: '1' }, runId)).toBe(false)
})
it('never accepts a partial module audit or an unobserved runtime', () => {
  const audit = { modules: 182, unreadableLive: 0, outside: [], bitwardenObserved: true, browserObserved: true }
  expect(moduleAuditSucceeded(audit)).toBe(true)
  expect(moduleAuditSucceeded({ ...audit, unreadableLive: 1 })).toBe(false)
  expect(moduleAuditSucceeded({ ...audit, unreadableLive: undefined, unavailable: 0 })).toBe(false)
  expect(moduleAuditSucceeded({ ...audit, outside: ['C:\\untrusted\\module.dll'] })).toBe(false)
  expect(moduleAuditSucceeded({ ...audit, bitwardenObserved: false })).toBe(false)
})
