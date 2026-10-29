import { expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({ lstat: async () => ({ isSymbolicLink: () => false }) }))
vi.mock('../src/platform/runtime-assets.js', () => ({ privateBrowserPath: async () => 'private-browser' }))
vi.mock('../src/platform/windows/doctor.js', () => ({
  checkWindowsPermissions: () => new Promise(resolve => setTimeout(() => resolve('pass'), 45000)),
}))

import { diagnoseService } from '../src/service/doctor.js'

it('retains a successful native permission result after a scan exceeds the old deadlines', async () => {
  vi.useFakeTimers()
  try {
    const pending = diagnoseService('private-home', { status: async () => 'locked' } as any, 'win32')
    await vi.advanceTimersByTimeAsync(45000)
    expect(await pending).toEqual({ assets: 'pass', permissions: 'pass', vault: 'locked' })
  } finally { vi.useRealTimers() }
})
it('probes the service browser concurrently instead of extending the native diagnostic deadline', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', () => new Promise(resolve => setTimeout(() => resolve({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/fixture' }) }), 4000)))
  try {
    let settled = false
    const pending = diagnoseService('private-home', { status: async () => 'locked' } as any, 'win32', 'http://127.0.0.1:9222').then(r => { settled = true; return r })
    await vi.advanceTimersByTimeAsync(45000)
    expect(settled).toBe(true)
    expect(await pending).toMatchObject({ permissions: 'pass', browser: 'pass', browserEndpoint: 'http://127.0.0.1:9222' })
  } finally { vi.unstubAllGlobals(); vi.useRealTimers() }
})
