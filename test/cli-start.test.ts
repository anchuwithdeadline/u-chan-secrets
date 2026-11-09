import { expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import type { DiagnosticReport } from '../src/core/doctor.js'
const report = (vaultNext = ''): DiagnosticReport => ({ version: 1, checks: [{ id: 'vault', state: 'pass', required: true, message: 'Checked.', nextAction: vaultNext }] })
function fixture(vault: string) {
  const unlock = vi.fn(async () => ({ ok: true, message: 'Vault unlocked.' }))
  const diagnose = vi.fn(async () => ({ ok: true, message: JSON.stringify({ vault }) }))
  const out = vi.fn(), err = vi.fn()
  // An unused port keeps the real CDP probe failing, so start always asks for a launch.
  const deps = { connect: vi.fn(() => ({ diagnose, unlock }) as any), startBrowser: vi.fn(async () => true), doctor: vi.fn(async () => report()),
    env: { U_CHAN_BROWSER: 'chrome', U_CHAN_CDP: 'http://127.0.0.1:1' }, platform: 'win32' as const, readFile: vi.fn(), out, err }
  return { deps, unlock, out, err }
}
it('starts the browser, unlocks a locked vault through the service prompt, then reports doctor', async () => {
  const f = fixture('locked')
  expect(await main(['start'], f.deps)).toBe(0)
  expect(f.deps.startBrowser).toHaveBeenCalledWith('chrome', f.deps.env, false)
  expect(f.unlock).toHaveBeenCalledTimes(1)
  expect(f.deps.doctor).toHaveBeenCalledTimes(1)
  expect(f.out.mock.calls.flat().join('\n')).toContain('Vault: Vault unlocked.')
})
it('skips unlock when already unlocked and fails when the vault stays locked', async () => {
  const f = fixture('unlocked')
  expect(await main(['start'], f.deps)).toBe(0)
  expect(f.unlock).not.toHaveBeenCalled()
  const g = fixture('locked')
  g.unlock.mockResolvedValue({ ok: false, message: 'Unlock cancelled.' })
  g.deps.doctor.mockResolvedValue(report('Run u-chan unlock.'))
  expect(await main(['start'], g.deps)).toBe(1)
  expect(g.err).toHaveBeenCalledWith('Vault: Unlock cancelled.')
})
it('reports a browser launch failure, skips unlock for an unreachable service, and refuses other platforms or arguments', async () => {
  const f = fixture('locked')
  f.deps.startBrowser.mockResolvedValue(false)
  f.deps.connect.mockImplementation(() => ({ diagnose: async () => { throw new Error('down') }, unlock: f.unlock }) as any)
  await main(['start'], f.deps)
  expect(f.err.mock.calls.flat().join('\n')).toContain('could not start')
  expect(f.unlock).not.toHaveBeenCalled()
  const g = fixture('locked')
  expect(await main(['start'], { ...g.deps, platform: 'darwin' })).toBe(1)
  expect(await main(['start', '--now'], g.deps)).toBe(1)
  expect(g.deps.startBrowser).not.toHaveBeenCalled()
})
it('applies a compatible published update before starting, and only reports one that needs a reinstall', async () => {
  const f = fixture('unlocked')
  const update = vi.fn(async (checkOnly: boolean) => checkOnly ? { ok: true, message: JSON.stringify({ compatible: true, decision: 'update_required', desktopDecision: 'update_required' }) } : { ok: true, message: '{}' })
  expect(await main(['start'], { ...f.deps, update })).toBe(0)
  expect(update.mock.calls).toEqual([[true], [false]])
  expect(f.out.mock.calls.flat().join('\n')).toContain('Update: installed.')
  const g = fixture('unlocked')
  const blocked = vi.fn(async () => ({ ok: true, message: JSON.stringify({ compatible: false, reason: 'native_helpers_changed', decision: 'update_required', target: { version: '5.2.0' } }) }))
  await main(['start'], { ...g.deps, update: blocked })
  expect(blocked).toHaveBeenCalledTimes(1)
  expect(g.err.mock.calls.flat().join('\n')).toContain('Trusted reinstall')
  const h = fixture('unlocked')
  const current = vi.fn(async () => ({ ok: true, message: JSON.stringify({ compatible: true, decision: 'up_to_date', desktopDecision: 'up_to_date' }) }))
  await main(['start'], { ...h.deps, update: current })
  expect(current).toHaveBeenCalledTimes(1)
})
it('start reports reinstall steps for incompatible update', async () => {
  const f = fixture('unlocked')
  const blocked = vi.fn(async () => ({ ok: true, message: JSON.stringify({ compatible: false, reason: 'native_helpers_changed', decision: 'update_required', target: { version: '5.2.0' } }) }))
  await main(['start'], { ...f.deps, update: blocked })
  expect(f.err.mock.calls.flat().join('\n')).toContain('u-chan-secrets@5.2.0')
})
