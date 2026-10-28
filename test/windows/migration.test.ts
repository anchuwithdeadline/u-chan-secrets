import { describe, expect, it, vi } from 'vitest'
import { migrateBitwarden } from '../../src/platform/windows/migration.js'
import type { ExecFn } from '../../src/platform/windows/acl.js'

describe('Windows Bitwarden Migration', () => {
  it('logs out Bitwarden CLI and deletes existing session file', async () => {
    const executedCommands: Array<{ file: string; args: string[] }> = []
    const fakeExec: ExecFn = vi.fn(async (file, args) => {
      executedCommands.push({ file, args })
      return { stdout: '', stderr: '' }
    })

    const deletedPaths: string[] = []
    const fakeUnlink = vi.fn(async (p: string) => {
      deletedPaths.push(p)
    })

    const fakeFileExists = vi.fn(async (_p: string) => true)
    const customSession = 'C:\\custom\\u-chan-secrets\\bw-session'

    const result = await migrateBitwarden({
      exec: fakeExec,
      unlink: fakeUnlink,
      fileExists: fakeFileExists,
      sessionPath: customSession,
    })

    expect(result.bwLoggedOut).toBe(true)
    expect(result.sessionFileRemoved).toBe(true)
    expect(result.warning).toBeUndefined()

    expect(executedCommands).toEqual([{ file: 'bw', args: ['logout'] }])
    expect(deletedPaths).toEqual([customSession])
  })

  it('tolerates bw logout failure and returns warning', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      throw new Error('Command failed: bw logout - not logged in')
    })
    const fakeFileExists = vi.fn(async () => false)

    const result = await migrateBitwarden({
      exec: fakeExec,
      fileExists: fakeFileExists,
    })

    expect(result.bwLoggedOut).toBe(false)
    expect(result.sessionFileRemoved).toBe(false)
    expect(result.warning).toContain('Bitwarden CLI logout skipped or failed')
  })

  it('tolerates missing session file cleanly', async () => {
    const fakeExec: ExecFn = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const fakeUnlink = vi.fn(async () => {})
    const fakeFileExists = vi.fn(async () => false)

    const result = await migrateBitwarden({
      exec: fakeExec,
      unlink: fakeUnlink,
      fileExists: fakeFileExists,
    })

    expect(result.bwLoggedOut).toBe(true)
    expect(result.sessionFileRemoved).toBe(false)
    expect(fakeUnlink).not.toHaveBeenCalled()
  })

  it('checks default APPDATA location when sessionPath is not provided', async () => {
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

    expect(checkedPath).toMatch(/(?:[/\\]|^)u-chan-secrets[/\\]bw-session$/)
  })
})
