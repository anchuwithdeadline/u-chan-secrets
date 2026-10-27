import { describe, expect, it, vi } from 'vitest'
import { compileCsharp, type CompileOptions } from '../../src/platform/windows/assets/compiler.js'
import { AUTH_HELPER_CSHARP } from '../../src/platform/windows/assets/auth-src.js'
import { PROMPT_HELPER_CSHARP } from '../../src/platform/windows/assets/prompt-src.js'
import { SERVICE_HOST_CSHARP } from '../../src/platform/windows/assets/service-src.js'
import { UserFacingError } from '../../src/core/types.js'
import type { ExecFn } from '../../src/platform/windows/acl.js'

describe('compileCsharp', () => {
  it('formats PowerShell Add-Type compilation command with appropriate parameters', async () => {
    let capturedFile = ''
    let capturedArgs: string[] = []

    const fakeExec: ExecFn = vi.fn(async (file: string, args: string[]) => {
      capturedFile = file
      capturedArgs = args
      return { stdout: '', stderr: '' }
    })

    const source = 'using System; class Program { static void Main() {} }'
    const outputPath = 'C:\\ProgramData\\u-chan-secrets\\bin\\prompt.exe'
    const opts: CompileOptions = {
      outputType: 'WindowsApplication',
      referencedAssemblies: ['System.Windows.Forms.dll', 'System.Drawing.dll'],
      exec: fakeExec,
    }

    await compileCsharp(source, outputPath, opts)

    expect(capturedFile).toBe('powershell.exe')
    expect(capturedArgs).toContain('-NoProfile')
    expect(capturedArgs).toContain('-NonInteractive')
    expect(capturedArgs).toContain('-Command')

    const command = capturedArgs[capturedArgs.indexOf('-Command') + 1]
    expect(command).toContain('Add-Type')
    expect(command).toContain(source)
    expect(command).toContain('C:\\ProgramData\\u-chan-secrets\\bin\\prompt.exe')
    expect(command).toContain('WindowsApplication')
    expect(command).toContain('System.Windows.Forms.dll')
    expect(command).toContain('System.Drawing.dll')
  })

  it('uses ConsoleApplication as default outputType and omits referencedAssemblies when empty', async () => {
    let capturedCommand = ''
    const fakeExec: ExecFn = vi.fn(async (_file: string, args: string[]) => {
      capturedCommand = args[args.indexOf('-Command') + 1]
      return { stdout: '', stderr: '' }
    })

    const source = 'class Test {}'
    await compileCsharp(source, 'test.exe', { exec: fakeExec })

    expect(capturedCommand).toContain('Add-Type')
    expect(capturedCommand).toContain('ConsoleApplication')
    expect(capturedCommand).not.toContain('-ReferencedAssemblies')
  })

  it('handles compilation errors cleanly by throwing UserFacingError without leaking full source code', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      const err = new Error('Command failed')
      Object.assign(err, { stderr: 'error CS1002: ; expected at line 4', stdout: '' })
      throw err
    })

    const largeSecretSource = '/* proprietary algorithm */ class X { invalid code }'

    await expect(
      compileCsharp(largeSecretSource, 'err.exe', { exec: fakeExec })
    ).rejects.toThrow(UserFacingError)

    await expect(
      compileCsharp(largeSecretSource, 'err.exe', { exec: fakeExec })
    ).rejects.toThrow(/CS1002/)

    try {
      await compileCsharp(largeSecretSource, 'err.exe', { exec: fakeExec })
    } catch (e: any) {
      expect(e.message).not.toContain('proprietary algorithm')
    }
  })

  it('handles stderr compiler error output without exit exception', async () => {
    const fakeExec: ExecFn = vi.fn(async () => {
      return { stdout: '', stderr: 'Add-Type : Cannot compile: error CS1519: Invalid token' }
    })

    await expect(
      compileCsharp('class X {}', 'err.exe', { exec: fakeExec })
    ).rejects.toThrow(UserFacingError)

    await expect(
      compileCsharp('class X {}', 'err.exe', { exec: fakeExec })
    ).rejects.toThrow(/CS1519/)
  })
})

describe('Windows C# Assets', () => {
  it('AUTH_HELPER_CSHARP contains required Win32 P/Invoke signatures and SID lookup', () => {
    expect(AUTH_HELPER_CSHARP).toContain('GetNamedPipeClientProcessId')
    expect(AUTH_HELPER_CSHARP).toContain('OpenProcessToken')
    expect(AUTH_HELPER_CSHARP).toContain('DuplicateHandle')
    expect(AUTH_HELPER_CSHARP).toMatch(/ConvertSidToStringSid|SecurityIdentifier/)
  })

  it('PROMPT_HELPER_CSHARP contains required WinForms prompt window attributes', () => {
    expect(PROMPT_HELPER_CSHARP).toContain('System.Windows.Forms')
    expect(PROMPT_HELPER_CSHARP).toContain('TopMost = true')
    expect(PROMPT_HELPER_CSHARP).toContain('FixedDialog')
    expect(PROMPT_HELPER_CSHARP).toContain('CenterScreen')
    expect(PROMPT_HELPER_CSHARP).toContain('Phrase:')
    expect(PROMPT_HELPER_CSHARP).toContain('UseSystemPasswordChar = true')
    expect(PROMPT_HELPER_CSHARP).toMatch(/120|120000/)
  })

  it('SERVICE_HOST_CSHARP contains required Windows ServiceBase signatures and process lifecycle', () => {
    expect(SERVICE_HOST_CSHARP).toContain('System.ServiceProcess')
    expect(SERVICE_HOST_CSHARP).toContain('ServiceBase')
    expect(SERVICE_HOST_CSHARP).toContain('OnStart')
    expect(SERVICE_HOST_CSHARP).toContain('OnStop')
    expect(SERVICE_HOST_CSHARP).toMatch(/Process\.Start|ProcessStartInfo/)
  })
})
