import { describe, expect, it, vi } from 'vitest'
import type net from 'node:net'
import {
  createWindowsAuthorizer,
  queryPipeClientSid,
} from '../../src/platform/windows/authorize.js'
import type { ExecFn } from '../../src/platform/windows/acl.js'

describe('createWindowsAuthorizer', () => {
  const dummySocket = {} as net.Socket
  const targetSid = 'S-1-5-21-3623811015-3361044348-30300820-1001'

  it('allows client with matching authorized SID (case-insensitive)', async () => {
    const authorizer = createWindowsAuthorizer({
      authorizedSid: targetSid.toUpperCase(),
      getClientSid: vi.fn(async () => targetSid.toLowerCase()),
    })

    const allowed = await authorizer(dummySocket)
    expect(allowed).toBe(true)
  })

  it('rejects client with mismatched SID', async () => {
    const authorizer = createWindowsAuthorizer({
      authorizedSid: targetSid,
      getClientSid: vi.fn(async () => 'S-1-5-21-3623811015-3361044348-30300820-9999'),
    })

    const allowed = await authorizer(dummySocket)
    expect(allowed).toBe(false)
  })

  it('rejects when client SID lookup returns null or rejects', async () => {
    const nullAuthorizer = createWindowsAuthorizer({
      authorizedSid: targetSid,
      getClientSid: vi.fn(async () => null),
    })
    expect(await nullAuthorizer(dummySocket)).toBe(false)

    const throwAuthorizer = createWindowsAuthorizer({
      authorizedSid: targetSid,
      getClientSid: vi.fn(async () => {
        throw new Error('lookup failed')
      }),
    })
    expect(await throwAuthorizer(dummySocket)).toBe(false)
  })

  it('uses queryPipeClientSid when getClientSid is omitted', async () => {
    const fakeExec: ExecFn = vi.fn(async () => ({
      stdout: `AUTHORIZED:${targetSid}\n`,
      stderr: '',
    }))

    const authorizer = createWindowsAuthorizer({
      authorizedSid: targetSid,
      authExePath: 'C:\\ProgramData\\u-chan-secrets\\bin\\auth-helper.exe',
      serverPid: 4321,
      execFile: fakeExec,
    })

    const allowed = await authorizer(dummySocket)
    expect(allowed).toBe(true)
    expect(fakeExec).toHaveBeenCalledWith('C:\\ProgramData\\u-chan-secrets\\bin\\auth-helper.exe', [
      '4321',
      'dummy',
    ])
  })
})

describe('queryPipeClientSid', () => {
  const dummySocket = {} as net.Socket
  const expectedSid = 'S-1-5-21-123456789-54321-1000'

  it('executes auth binary with server PID and dummy arg, parsing stdout for SID', async () => {
    const fakeExec: ExecFn = vi.fn(async (file, args) => {
      expect(file).toBe('C:\\bin\\auth-helper.exe')
      expect(args).toEqual(['5678', 'dummy'])
      return { stdout: `AUTHORIZED:${expectedSid}\r\n`, stderr: '' }
    })

    const sid = await queryPipeClientSid(dummySocket, {
      authExePath: 'C:\\bin\\auth-helper.exe',
      serverPid: 5678,
      execFile: fakeExec,
    })

    expect(sid).toBe(expectedSid)
    expect(fakeExec).toHaveBeenCalledTimes(1)
  })

  it('returns null on non-zero exit or rejected exec', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      throw new Error('Process exited with code 1')
    })

    const sid = await queryPipeClientSid(dummySocket, {
      authExePath: 'C:\\bin\\auth-helper.exe',
      serverPid: 5678,
      execFile: fakeExec,
    })

    expect(sid).toBeNull()
  })

  it('returns null on unparseable stdout or missing match', async () => {
    const fakeExec: ExecFn = vi.fn(async () => ({
      stdout: 'Failed to resolve client SID\n',
      stderr: '',
    }))

    const sid = await queryPipeClientSid(dummySocket, {
      authExePath: 'C:\\bin\\auth-helper.exe',
      serverPid: 5678,
      execFile: fakeExec,
    })

    expect(sid).toBeNull()
  })
})
