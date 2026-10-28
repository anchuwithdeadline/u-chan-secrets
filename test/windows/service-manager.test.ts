import { describe, expect, it, vi } from 'vitest'
import { ServiceManager } from '../../src/platform/windows/service-manager.js'
import type { ExecFn } from '../../src/platform/windows/acl.js'

describe('ServiceManager', () => {
  it('creates service with sc.exe and default parameters', async () => {
    let capturedFile = ''
    let capturedArgs: string[] = []

    const fakeExec: ExecFn = vi.fn(async (file, args) => {
      capturedFile = file
      capturedArgs = args
      return { stdout: '[SC] CreateService SUCCESS', stderr: '' }
    })

    const sm = new ServiceManager(fakeExec)
    await sm.create('u-chan-secrets', 'C:\\ProgramData\\u-chan-secrets\\bin\\service-host.exe')

    expect(capturedFile).toBe('sc.exe')
    expect(capturedArgs).toEqual([
      'create',
      'u-chan-secrets',
      'binPath= "C:\\ProgramData\\u-chan-secrets\\bin\\service-host.exe"',
      'start= auto',
      'obj= LocalSystem',
    ])
  })

  it('creates service with sc.exe including optional DisplayName', async () => {
    let capturedArgs: string[] = []

    const fakeExec: ExecFn = vi.fn(async (_file, args) => {
      capturedArgs = args
      return { stdout: '[SC] CreateService SUCCESS', stderr: '' }
    })

    const sm = new ServiceManager(fakeExec)
    await sm.create(
      'u-chan-secrets',
      'C:\\ProgramData\\u-chan-secrets\\bin\\service-host.exe',
      'U-Chan Secrets Service'
    )

    expect(capturedArgs).toContain('DisplayName= "U-Chan Secrets Service"')
  })

  it('starts service with sc.exe', async () => {
    let capturedFile = ''
    let capturedArgs: string[] = []

    const fakeExec: ExecFn = vi.fn(async (file, args) => {
      capturedFile = file
      capturedArgs = args
      return { stdout: '', stderr: '' }
    })

    const sm = new ServiceManager(fakeExec)
    await sm.start('u-chan-secrets')

    expect(capturedFile).toBe('sc.exe')
    expect(capturedArgs).toEqual(['start', 'u-chan-secrets'])
  })

  it('handles start when service is already running without throwing', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      const err = new Error('Process exited with code 1056')
      Object.assign(err, { stdout: '[SC] StartService FAILED 1056:\nAn instance of the service is already running.', stderr: '' })
      throw err
    })

    const sm = new ServiceManager(fakeExec)
    await expect(sm.start('u-chan-secrets')).resolves.toBeUndefined()
  })

  it('stops and deletes service with sc.exe', async () => {
    const executed: Array<{ file: string; args: string[] }> = []

    const fakeExec: ExecFn = vi.fn(async (file, args) => {
      executed.push({ file, args })
      return { stdout: '', stderr: '' }
    })

    const sm = new ServiceManager(fakeExec)
    await sm.stop('u-chan-secrets')
    await sm.delete('u-chan-secrets')

    expect(executed).toEqual([
      { file: 'sc.exe', args: ['stop', 'u-chan-secrets'] },
      { file: 'sc.exe', args: ['delete', 'u-chan-secrets'] },
    ])
  })

  it('tolerates stop on already stopped service (code 1062)', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      const err = new Error('Process exited with code 1062')
      Object.assign(err, { stdout: '[SC] ControlService FAILED 1062:\nThe service has not been started.', stderr: '' })
      throw err
    })

    const sm = new ServiceManager(fakeExec)
    await expect(sm.stop('u-chan-secrets')).resolves.toBeUndefined()
  })

  it('tolerates delete on non-existent service (code 1060)', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      const err = new Error('Process exited with code 1060')
      Object.assign(err, { stdout: '[SC] OpenService FAILED 1060:\nThe specified service does not exist as an installed service.', stderr: '' })
      throw err
    })

    const sm = new ServiceManager(fakeExec)
    await expect(sm.delete('u-chan-secrets')).resolves.toBeUndefined()
  })

  it('status returns running when service state is RUNNING', async () => {
    const fakeExec: ExecFn = vi.fn(async () => ({
      stdout: `
SERVICE_NAME: u-chan-secrets 
        TYPE               : 30  WIN32  
        STATE              : 4  RUNNING 
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
`,
      stderr: '',
    }))

    const sm = new ServiceManager(fakeExec)
    const status = await sm.status('u-chan-secrets')
    expect(status).toBe('running')
  })

  it('status returns stopped when service state is STOPPED', async () => {
    const fakeExec: ExecFn = vi.fn(async () => ({
      stdout: `
SERVICE_NAME: u-chan-secrets 
        TYPE               : 30  WIN32  
        STATE              : 1  STOPPED 
        WIN32_EXIT_CODE    : 0  (0x0)
`,
      stderr: '',
    }))

    const sm = new ServiceManager(fakeExec)
    const status = await sm.status('u-chan-secrets')
    expect(status).toBe('stopped')
  })
  it('keeps STOP_PENDING distinct from a completed service shutdown', async () => {
    const sm = new ServiceManager(async () => ({ stdout: 'STATE : 3 STOP_PENDING', stderr: '' }))
    expect(await sm.status('u-chan-secrets')).toBe('pending')
  })

  it('status returns not_installed when service does not exist', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      const err = new Error('Command failed')
      Object.assign(err, {
        stdout: '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\nThe specified service does not exist as an installed service.',
        stderr: '',
      })
      throw err
    })

    const sm = new ServiceManager(fakeExec)
    const status = await sm.status('u-chan-secrets')
    expect(status).toBe('not_installed')
  })
})
