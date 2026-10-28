import { expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({ lstat: async () => ({ isSymbolicLink: () => false }) }))
vi.mock('../src/platform/runtime-assets.js', () => ({ privateBrowserPath: async () => 'private-browser' }))
vi.mock('../src/platform/windows/doctor.js', () => ({
  checkWindowsPermissions: () => new Promise(resolve => setTimeout(() => resolve('pass'), 6000)),
}))

import { diagnoseService } from '../src/service/doctor.js'

it('retains a successful native permission result after a six-second protected-tree scan', async () => {
  vi.useFakeTimers()
  try {
    const pending = diagnoseService('private-home', { status: async () => 'locked' } as any, 'win32')
    await vi.advanceTimersByTimeAsync(6000)
    expect(await pending).toEqual({ assets: 'pass', permissions: 'pass', vault: 'locked' })
  } finally { vi.useRealTimers() }
})
