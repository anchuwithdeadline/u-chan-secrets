import { describe, expect, it, vi } from 'vitest'
import { migrateBitwarden } from '../../src/platform/windows/migration.js'
import type { ExecFn } from '../../src/platform/windows/acl.js'

describe('migrateBitwarden', () => {
  it('runs bw logout and removes legacy session', async () => {
    const fakeExec: ExecFn = vi.fn(async (_file: string, _args: string[]) => {
      return { stdout: 'Logged out of Bitwarden.', stderr: '' }
    })
    const fakeUnlink = vi.fn(async (_path: string) => {})
    const fakeFileExists = vi.fn(async (_path: string) => true)

    const result = await migrateBitwarden({
      exec: fakeExec,
      unlink: fakeUnlink,
      fileExists: fakeFileExists,
      sessionPath: 'C:\\fake\\u-chan-secrets\\bw-session',
    })

    expect(fakeExec).toHaveBeenCalledWith('bw', ['logout'])
    expect(fakeFileExists).toHaveBeenCalledWith('C:\\fake\\u-chan-secrets\\bw-session')
    expect(fakeUnlink).toHaveBeenCalledWith('C:\\fake\\u-chan-secrets\\bw-session')
    expect(result).toEqual({
      bwLoggedOut: true,
      sessionFileRemoved: true,
    })
  })

  it('handles missing or failing bw gracefully', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      throw new Error('spawn bw ENOENT')
    })
    const fakeUnlink = vi.fn(async (_path: string) => {})
    const fakeFileExists = vi.fn(async (_path: string) => true)

    const result = await migrateBitwarden({
      exec: fakeExec,
      unlink: fakeUnlink,
      fileExists: fakeFileExists,
      sessionPath: 'C:\\fake\\u-chan-secrets\\bw-session',
    })

    expect(fakeExec).toHaveBeenCalledWith('bw', ['logout'])
    expect(fakeUnlink).toHaveBeenCalledWith('C:\\fake\\u-chan-secrets\\bw-session')
    expect(result.bwLoggedOut).toBe(false)
    expect(result.sessionFileRemoved).toBe(true)
    expect(result.warning).toBeDefined()
    expect(result.warning).toContain('spawn bw ENOENT')
  })

  it('skips unlink if session file does not exist', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      return { stdout: 'Logged out.', stderr: '' }
    })
    const fakeUnlink = vi.fn(async () => {})
    const fakeFileExists = vi.fn(async () => false)

    const result = await migrateBitwarden({
      exec: fakeExec,
      unlink: fakeUnlink,
      fileExists: fakeFileExists,
      sessionPath: 'C:\\fake\\u-chan-secrets\\bw-session',
    })

    expect(fakeFileExists).toHaveBeenCalledWith('C:\\fake\\u-chan-secrets\\bw-session')
    expect(fakeUnlink).not.toHaveBeenCalled()
    expect(result).toEqual({
      bwLoggedOut: true,
      sessionFileRemoved: false,
    })
  })

  it('uses default session path under APPDATA if not provided', async () => {
    const fakeExec: ExecFn = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const fakeUnlink = vi.fn(async () => {})
    let checkedPath = ''
    const fakeFileExists = vi.fn(async (p: string) => {
      checkedPath = p
      return false
    })

    await migrateBitwarden({
      exec: fakeExec,
      unlink: fakeUnlink,
      fileExists: fakeFileExists,
    })

    expect(checkedPath).toMatch(/[/\\]u-chan-secrets[/\\]bw-session$/)
  })
})
