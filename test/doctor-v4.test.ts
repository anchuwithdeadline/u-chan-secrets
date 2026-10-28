import { expect, it } from 'vitest'
import { runDoctor, doctorExitCode, safeVersion, safeCdpOrigin, checkPlaywrightCdp } from '../src/core/doctor.js'
const endpoint = 'http://127.0.0.1:9222'
const deps = {
  platform: 'win32' as const, clientVersion: '4.0.0', clientEndpoint: endpoint,
  registration: async () => 'pass' as const, chrome: async () => 'pass' as const, playwright: async () => 'unknown' as const,
  elevation: async () => 'pass' as const,
  service: async () => ({ assets: 'pass' as const, permissions: 'pass' as const, vault: 'locked' as const, serviceVersion: '4.0.0', browser: 'pass' as const, browserEndpoint: endpoint }),
}
it('checks the actual installed version and both browser targets', async () => {
  const good = await runDoctor(deps)
  expect(good.checks.find(c => c.id === 'version')?.state).toBe('pass')
  expect(good.checks.find(c => c.id === 'browser_target')?.state).toBe('pass')
  expect(doctorExitCode(good)).toBe(0)
  const mismatch = await runDoctor({ ...deps, service: async () => ({ ...(await deps.service()), serviceVersion: '3.0.3' }) })
  expect(mismatch.checks.find(c => c.id === 'version')?.state).toBe('fail')
})
it('does not echo invalid version metadata or guess an old service version', async () => {
  const report = await runDoctor({ ...deps, service: async () => ({ ...(await deps.service()), serviceVersion: 'SECRET\npretend-version' }) })
  expect(report.checks.find(c => c.id === 'version')?.state).toBe('unknown')
  expect(JSON.stringify(report)).not.toContain('SECRET')
  expect(safeVersion('4.0.0-rc.1+build')).toBe('4.0.0-rc.1+build')
  expect(safeVersion('4.0.0' + 'x'.repeat(70))).toBeUndefined()
})
it('fails a healthy desktop paired with a missing or different service browser', async () => {
  const report = await runDoctor({ ...deps, service: async () => ({ ...(await deps.service()), browser: 'fail' as const, browserEndpoint: 'http://127.0.0.1:9223' }) })
  expect(report.checks.find(c => c.id === 'service_browser')?.state).toBe('fail')
  expect(report.checks.find(c => c.id === 'browser_target')?.state).toBe('fail')
})
it('requires safe elevation policy and refuses unsafe CDP origins without exposing credentials', async () => {
  const report = await runDoctor({ ...deps, elevation: async () => 'fail' })
  expect(report.checks.find(c => c.id === 'uac')?.state).toBe('fail')
  expect(safeCdpOrigin(endpoint)).toBe(endpoint)
  for (const value of ['http://user:SECRET@127.0.0.1:9222', 'http://0.0.0.0:9222', 'https://127.0.0.1:9222', endpoint + '/?token=SECRET']) expect(safeCdpOrigin(value)).toBeUndefined()
})
it('compares the actual process CDP value instead of accepting any endpoint flag', () => {
  const procs = [{ pid: 1, ppid: 0, name: 'codex.exe', cmd: 'codex' }, { pid: 2, ppid: 1, name: 'node.exe', cmd: 'u-chan' }, { pid: 3, ppid: 1, name: 'node.exe', cmd: '@playwright/mcp --cdp-endpoint http://127.0.0.1:9223' }]
  expect(checkPlaywrightCdp(procs, 2, endpoint)).toBe('missing')
  procs[2].cmd = '@playwright/mcp --cdp-endpoint="http://127.0.0.1:9222"'
  expect(checkPlaywrightCdp(procs, 2, endpoint)).toBe('ok')
})
