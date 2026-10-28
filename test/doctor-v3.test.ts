import { expect, it } from 'vitest'
import { runDoctor, doctorExitCode } from '../src/core/doctor.js'
import { main } from '../src/cli.js'

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
  } as any)
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
