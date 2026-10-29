import { expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string) => void) => {
    const scanMs = 45000
    return setTimeout(() => callback(options.timeout < scanMs ? new Error('scan timed out') : null,
      options.timeout < scanMs ? '' : 'SAFE'), Math.min(options.timeout, scanMs))
  },
}))

import { checkWindowsPermissions } from '../../src/platform/windows/doctor.js'

it('lets a safe full native scan finish after the original fifteen-second deadline', async () => {
  vi.useFakeTimers()
  try {
    const result = checkWindowsPermissions('private-home')
    await vi.advanceTimersByTimeAsync(45000)
    expect(await result).toBe('pass')
  } finally { vi.useRealTimers() }
})
