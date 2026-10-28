import { describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import * as lifecycle from '../src/platform/darwin/lifecycle.js'

describe('cli darwin lifecycle', () => {
  it('dispatches install command to macosInstall on darwin', async () => {
    const macosInstallSpy = vi.spyOn(lifecycle, 'macosInstall').mockResolvedValue({
      ok: true,
      message: 'u-chan service installed successfully',
    })

    const out: string[] = []
    const err: string[] = []
    const code = await main(['install', '--phrase', 'green pine tree'], {
      doctor: async () => ({ version: 1, checks: [{ id: 'service', state: 'pass', required: true, message: 'Service is reachable.', nextAction: '' }] }),
      connect: vi.fn(),
      env: {},
      platform: 'darwin',
      readFile: vi.fn(),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    })

    expect(code).toBe(0)
    expect(out).toEqual(['u-chan service installed successfully', 'PASS service: Service is reachable.'])
    expect(macosInstallSpy).toHaveBeenCalledWith(expect.objectContaining({
      phrase: 'green pine tree',
    }))
    macosInstallSpy.mockRestore()
  })

  it('dispatches uninstall command to macosUninstall on darwin', async () => {
    const macosUninstallSpy = vi.spyOn(lifecycle, 'macosUninstall').mockResolvedValue({
      ok: true,
      message: 'u-chan service uninstalled successfully',
    })

    const out: string[] = []
    const err: string[] = []
    const code = await main(['uninstall'], {
      connect: vi.fn(),
      env: {},
      platform: 'darwin',
      readFile: vi.fn(),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    })

    expect(code).toBe(0)
    expect(out).toEqual(['u-chan service uninstalled successfully'])
    expect(macosUninstallSpy).toHaveBeenCalled()
    macosUninstallSpy.mockRestore()
  })

  it('handles macosInstall failure with exit code 1', async () => {
    const macosInstallSpy = vi.spyOn(lifecycle, 'macosInstall').mockResolvedValue({
      ok: false,
      message: 'u-chan install on macOS requires root privileges (run with sudo)',
    })

    const out: string[] = []
    const err: string[] = []
    const code = await main(['install'], {
      connect: vi.fn(),
      env: {},
      platform: 'darwin',
      readFile: vi.fn(),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    })

    expect(code).toBe(1)
    expect(err).toEqual(['u-chan install on macOS requires root privileges (run with sudo)'])
    macosInstallSpy.mockRestore()
  })
})
