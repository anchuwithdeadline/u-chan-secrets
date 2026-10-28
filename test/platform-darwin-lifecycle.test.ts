import { describe, it, expect, vi } from 'vitest'
import { generateLaunchdPlist, PLIST_LABEL, PLIST_PATH } from '../src/platform/darwin/plist.js'
import { macosInstall, macosUninstall } from '../src/platform/darwin/lifecycle.js'

describe('macOS launchd plist generator', () => {
  it('creates valid launchd plist XML with KeepAlive and RunAtLoad', () => {
    const plist = generateLaunchdPlist({
      nodePath: '/usr/local/bin/node',
      serviceScriptPath: '/usr/local/lib/node_modules/u-chan-secrets/dist/service/main.js',
      homeDir: '/Library/Application Support/u-chan-secrets',
      outLogPath: '/Library/Application Support/u-chan-secrets/daemon.out.log',
      errLogPath: '/Library/Application Support/u-chan-secrets/daemon.err.log',
    })
    expect(plist).toContain(`<string>${PLIST_LABEL}</string>`)
    expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>')
    expect(plist).toContain('<key>KeepAlive</key>\n    <true/>')
    expect(plist).toContain('/usr/local/bin/node')
    expect(plist).toContain('dist/service/main.js')
    expect(plist).toContain('<key>WorkingDirectory</key>\n    <string>/Library/Application Support/u-chan-secrets</string>')
    expect(plist).toContain('<key>StandardOutPath</key>')
    expect(plist).toContain('<key>StandardErrorPath</key>')
  })
})

describe('macOS daemon lifecycle', () => {
  it('refuses install when not running as root', async () => {
    const res = await macosInstall({ getuid: () => 501 })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('requires root privileges (run with sudo)')
  })

  it('rejects easy mode on macOS', async () => {
    const res = await macosInstall({ getuid: () => 0, mode: 'easy' })
    expect(res.ok).toBe(false)
    expect(res.message).toBe('easy mode is not supported on macOS (hardcore mode only)')
  })

  it('creates root-only home directory and owner file with SUDO_UID', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const chmod = vi.fn().mockResolvedValue(undefined)
    const chown = vi.fn().mockResolvedValue(undefined)
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })

    const res = await macosInstall({
      getuid: () => 0,
      env: { SUDO_UID: '501', SUDO_USER: 'alice' },
      fs: { mkdir, writeFile, chmod, chown, rm: vi.fn(), exists: vi.fn().mockResolvedValue(false) },
      exec,
    })

    expect(res.ok).toBe(true)
    expect(mkdir).toHaveBeenCalledWith('/Library/Application Support/u-chan-secrets', { recursive: true, mode: 0o700 })
    expect(writeFile).toHaveBeenCalledWith(
      '/Library/Application Support/u-chan-secrets/owner.json',
      expect.stringContaining('"installUid": 501'),
      { mode: 0o600 },
    )
    expect(writeFile).toHaveBeenCalledWith(
      '/Library/Application Support/u-chan-secrets/settings.json',
      expect.stringContaining('"mode": "hardcore"'),
      { mode: 0o600 },
    )
    expect(writeFile).toHaveBeenCalledWith(
      PLIST_PATH,
      expect.stringContaining(PLIST_LABEL),
      { mode: 0o644 },
    )
    expect(exec).toHaveBeenCalledWith('/bin/launchctl', ['load', '-w', PLIST_PATH])
  })

  it('tolerates missing bw CLI during migration', async () => {
    const exec = vi.fn().mockImplementation(async (cmd, args) => {
      if (args.includes('bw')) return { stdout: '', stderr: 'command not found: bw', exitCode: 127 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const res = await macosInstall({
      getuid: () => 0,
      env: { SUDO_UID: '501', SUDO_USER: 'alice' },
      fs: { mkdir: vi.fn(), writeFile: vi.fn(), chmod: vi.fn(), chown: vi.fn(), rm: vi.fn(), exists: vi.fn().mockResolvedValue(false) },
      exec,
    })
    expect(res.ok).toBe(true)
    expect(res.message).toContain('installed successfully')
  })

  it('removes legacy bw-session during migration if present', async () => {
    const rm = vi.fn().mockResolvedValue(undefined)
    const exists = vi.fn().mockImplementation(async (p: string) => p.endsWith('bw-session'))
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })

    const res = await macosInstall({
      getuid: () => 0,
      env: { SUDO_UID: '501', SUDO_USER: 'alice' },
      fs: { mkdir: vi.fn(), writeFile: vi.fn(), chmod: vi.fn(), chown: vi.fn(), rm, exists },
      exec,
    })

    expect(res.ok).toBe(true)
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('bw-session'), { force: true })
  })

  it('refuses uninstall when not running as root', async () => {
    const res = await macosUninstall({ getuid: () => 501 })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('requires root privileges (run with sudo)')
  })

  it('uninstalls daemon by unloading launchd and removing files', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const rm = vi.fn().mockResolvedValue(undefined)

    const res = await macosUninstall({
      getuid: () => 0,
      exec,
      fs: { rm, exists: vi.fn().mockResolvedValue(true) } as any,
    })

    expect(res.ok).toBe(true)
    expect(exec).toHaveBeenCalledWith('/bin/launchctl', ['unload', '-w', PLIST_PATH])
    expect(rm).toHaveBeenCalledWith(PLIST_PATH, { force: true })
    expect(rm).toHaveBeenCalledWith('/Library/Application Support/u-chan-secrets', { recursive: true, force: true })
    expect(rm).toHaveBeenCalledWith('/var/run/u-chan-secrets', { recursive: true, force: true })
  })
})
