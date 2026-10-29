import { expect, it, vi } from 'vitest'
import { runDoctor, doctorExitCode } from '../src/core/doctor.js'
import { main } from '../src/cli.js'

it('keeps a reachable service when a full native permission scan takes over five seconds', async () => {
  vi.useFakeTimers()
  try {
    const pending = runDoctor({
      platform: 'win32', registration: async () => 'pass', chrome: async () => 'pass', playwright: async () => 'pass',
      service: () => new Promise(resolve => setTimeout(() => resolve({ assets: 'pass', permissions: 'pass', vault: 'locked' }), 6000)),
    })
    await vi.advanceTimersByTimeAsync(6000)
    const report = await pending
    expect(report.checks.find(c => c.id === 'service')?.state).toBe('pass')
    expect(report.checks.find(c => c.id === 'permissions')?.state).toBe('pass')
    expect(doctorExitCode(report)).toBe(0)
  } finally { vi.useRealTimers() }
})

it('reports fixed safe results and keeps independent probes when the service is unreachable', async () => {
  const report = await runDoctor({
    platform: 'darwin',
    registration: async () => 'pass',
    service: async () => { throw new Error('SECRET sentinel') },
    chrome: async () => 'pass',
    playwright: async () => 'unknown',
  })
  expect(report.version).toBe(1)
  expect(report.checks.find(c => c.id === 'chrome')?.state).toBe('pass')
  expect(report.checks.find(c => c.id === 'assets')?.state).toBe('unknown')
  expect(JSON.stringify(report)).not.toContain('SECRET')
  expect(doctorExitCode(report)).toBe(1)
})

it('doctor --json prints a versioned report with the diagnostic exit code', async () => {
  const out: string[] = []
  const report = { version: 1 as const, checks: [{ id: 'service', state: 'unknown' as const, required: true, message: 'unknown', nextAction: '' }] }
  const code = await main(['doctor', '--json'], {
    connect: () => { throw new Error('not called') }, env: {}, platform: 'win32', readFile: async () => '',
    out: s => out.push(s), err: s => out.push(s), doctor: async () => report,
  })
  expect(code).toBe(2)
  expect(JSON.parse(out[0])).toEqual(report)
})
it('distinguishes locked vault from broken installation and computes all exit codes', async () => {
  const report = await runDoctor({
    platform: 'win32', registration: async () => 'pass', chrome: async () => 'pass', playwright: async () => 'pass',
    service: async () => ({ assets: 'pass', permissions: 'pass', vault: 'locked' }),
  })
  expect(report.checks.find(c => c.id === 'vault')).toMatchObject({ state: 'pass', message: 'Vault is locked.', nextAction: 'Run u-chan unlock.' })
  expect(doctorExitCode(report)).toBe(0)
  expect(doctorExitCode({ version: 1, checks: [{ id: 'test', required: true, state: 'unknown', message: '', nextAction: '' }] })).toBe(2)
})
it('fails a known browser-sharing mismatch while keeping unobservable sharing advisory', async () => {
  const deps = { platform: 'win32' as const, registration: async () => 'pass' as const, chrome: async () => 'pass' as const,
    service: async () => ({ assets: 'pass' as const, permissions: 'pass' as const, vault: 'locked' as const }) }
  expect(doctorExitCode(await runDoctor({ ...deps, playwright: async () => 'fail' }))).toBe(1)
  expect(doctorExitCode(await runDoctor({ ...deps, playwright: async () => 'unknown' }))).toBe(0)
})
