import { describe, expect, it, vi } from 'vitest'
import { setAdminOnlyAcl, type ExecFn } from '../../src/platform/windows/acl.js'
import { UserFacingError } from '../../src/core/types.js'

describe('setAdminOnlyAcl', () => {
  it('invokes icacls with inheritance removal and admin-only grant', async () => {
    const fakeExec: ExecFn = vi.fn(async (_file: string, _args: string[]) => {
      return { stdout: 'successfully processed 1 files', stderr: '' }
    })

    await setAdminOnlyAcl('C:\\ProgramData\\u-chan-secrets', fakeExec)

    expect(fakeExec).toHaveBeenCalledWith('icacls.exe', [
      'C:\\ProgramData\\u-chan-secrets',
      '/inheritance:r',
      '/grant:r',
      'SYSTEM:(OI)(CI)F',
      'Administrators:(OI)(CI)F',
    ])
  })

  it('propagates icacls failure as user-facing error when exec rejects', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      throw new Error('Access is denied')
    })

    await expect(setAdminOnlyAcl('C:\\ProgramData\\u-chan-secrets', fakeExec)).rejects.toThrow(
      UserFacingError
    )
    await expect(setAdminOnlyAcl('C:\\ProgramData\\u-chan-secrets', fakeExec)).rejects.toThrow(
      /Access is denied/
    )
  })

  it('propagates icacls output failure as user-facing error when icacls reports failed processing', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      return { stdout: 'Successfully processed 0 files; Failed processing 1 files', stderr: '' }
    })

    await expect(setAdminOnlyAcl('C:\\ProgramData\\u-chan-secrets', fakeExec)).rejects.toThrow(
      UserFacingError
    )
    await expect(setAdminOnlyAcl('C:\\ProgramData\\u-chan-secrets', fakeExec)).rejects.toThrow(
      /failed/i
    )
  })
})
