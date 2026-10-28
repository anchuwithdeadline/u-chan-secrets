import { expect, it, vi } from 'vitest'
import { runSetup, setupExitCode } from '../src/client/setup.js'
import { main } from '../src/cli.js'
import type { DiagnosticReport } from '../src/core/doctor.js'
const options = { apply: false, replaceExisting: false, startBrowser: false }
const report = (overrides: Record<string, 'pass'|'fail'|'unknown'> = {}): DiagnosticReport => ({ version: 1, checks: ['service','version','browser_target','service_browser','chrome','vault'].map(id => ({ id, state: overrides[id] ?? 'pass', required: true, message: id === 'vault' ? 'Vault is locked.' : 'Checked.', nextAction: id === 'vault' ? 'Run u-chan unlock.' : '' })).concat([{ id: 'playwright', state: overrides.playwright ?? 'unknown', required: false, message: 'Checked.', nextAction: '' }]) })
function fixture() {
  return { platform: 'win32' as const, endpoint: 'http://127.0.0.1:9222', elevated: vi.fn(async () => false), doctor: vi.fn(async () => report()), configure: vi.fn(async () => ({ state: 'ready' as const, changed: false, message: 'Checked.' })), startBrowser: vi.fn(async () => true) }
}
it('keeps default setup read-only and unknown sharing explicit; locked vault is valid', async () => {
  const d = fixture(), r = await runSetup(options, d)
  expect(r).toMatchObject({ state: 'configured', sharing: 'unobserved', restartRequired: false, changed: false })
  expect(d.configure).toHaveBeenCalledWith({ apply: false, replaceExisting: false })
  expect(d.startBrowser).not.toHaveBeenCalled()
  expect(r.actions).toContainEqual({ id: 'vault', message: 'Run u-chan unlock.', required: false })
  expect(setupExitCode(r)).toBe(0)
})
it('refuses elevated or unsafe/mismatched targets before client or browser calls', async () => {
  for (const kind of ['elevated','unsafe','mismatch']) {
    const d = fixture()
    if (kind === 'elevated') d.elevated.mockResolvedValue(true)
    if (kind === 'unsafe') d.endpoint = 'http://user:SECRET@127.0.0.1:9222'
    if (kind === 'mismatch') d.doctor.mockResolvedValue(report({ browser_target: 'fail' }))
    const r = await runSetup({ ...options, apply: true, startBrowser: true }, d)
    expect(r.state).toBe('needs_attention')
    expect(d.configure).not.toHaveBeenCalled(); expect(d.startBrowser).not.toHaveBeenCalled()
    expect(JSON.stringify(r)).not.toContain('SECRET')
  }
})
it('starts only unhealthy Chrome and reruns diagnostics even after startup failure', async () => {
  const d = fixture()
  await runSetup({ ...options, startBrowser: true }, d)
  expect(d.startBrowser).not.toHaveBeenCalled()
  d.doctor.mockResolvedValue(report({ chrome: 'fail', service_browser: 'fail' }))
  d.startBrowser.mockResolvedValue(false)
  expect((await runSetup({ ...options, startBrowser: true }, d)).state).toBe('needs_attention')
  expect(d.startBrowser).toHaveBeenCalledTimes(1)
  expect(d.doctor).toHaveBeenCalledTimes(3)
})
it('keeps matching process configuration distinct from active proof and forces restart after changes', async () => {
  const d = fixture(); d.doctor.mockResolvedValue(report({ playwright: 'pass' }))
  expect((await runSetup(options, d)).sharing).toBe('process_configured')
  d.configure.mockResolvedValue({ state: 'ready', changed: true, message: 'Saved.' })
  const r = await runSetup({ ...options, apply: true }, d)
  expect(r).toMatchObject({ state: 'configured', restartRequired: true, changed: true })
  expect(setupExitCode(r)).toBe(2)
  expect(JSON.stringify(r)).not.toContain('active session verified')
})
it('rejects malformed setup CLI flags before any side effects', async () => {
  for (const args of [['--wat'], ['--apply','--apply'], ['--client'], ['--client','other'], ['--replace-existing'], ['--json','--json']]) {
    const setup = vi.fn(), connect = vi.fn(), doctor = vi.fn()
    expect(await main(['setup', ...args], { setup, connect, doctor, env: {}, platform: 'win32', readFile: vi.fn(), out: vi.fn(), err: vi.fn() })).toBe(1)
    expect(setup).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(doctor).not.toHaveBeenCalled()
  }
})
it('forwards valid setup options and prints a machine-readable report with its exit code', async () => {
  const d = fixture(), r = await runSetup(options, d), out = vi.fn()
  r.restartRequired = true
  const setup = vi.fn(async () => r)
  expect(await main(['setup', '--client', 'codex', '--apply', '--replace-existing', '--start-browser', '--json'], { setup, connect: vi.fn(), env: {}, platform: 'win32', readFile: vi.fn(), out, err: vi.fn() })).toBe(2)
  expect(setup).toHaveBeenCalledWith({ apply: true, replaceExisting: true, startBrowser: true })
  expect(JSON.parse(out.mock.calls[0][0])).toEqual(r)
})
