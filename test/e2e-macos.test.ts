import { describe, it, expect, vi, afterEach } from 'vitest'
import net from 'node:net'
import { unlinkSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startIpcServer } from '../src/ipc/server.js'
import { IpcClient } from '../src/ipc/client.js'
import { platformAdapters } from '../src/platform/index.js'
import { PolicyApprover } from '../src/service/policy-approver.js'
import { SettingsStore } from '../src/service/settings.js'
import { AttemptLimiter } from '../src/service/attempts.js'
import { prepareSocketEndpoint } from '../src/service/main.js'

describe('macOS end-to-end integration and security attacks', () => {
  const socketPath = process.platform === 'win32'
    ? String.raw`\\.\pipe\ucs-macos-test-${Date.now()}`
    : join(tmpdir(), `ucs-macos-test-${Date.now()}.sock`)

  let server: net.Server | undefined

  afterEach(() => {
    server?.close()
    if (process.platform !== 'win32' && existsSync(socketPath)) {
      try { unlinkSync(socketPath) } catch {}
    }
  })

  it('full macOS workflow: caller authorized, hardcore prompt required, secret phrase verified', async () => {
    let currentPeerUid = 501
    const exec = vi.fn().mockResolvedValue({ stdout: 'master-secret\n', exitCode: 0 })
    const adapters = platformAdapters('darwin', {
      installUid: 501,
      resolvePeerCred: async () => ({ uid: currentPeerUid }),
      execPrompt: exec,
    })

    const tempSettings = join(tmpdir(), `fake-settings-${Date.now()}.json`)
    const settings = new SettingsStore(tempSettings)
    await settings.update({ mode: 'hardcore', phrase: 'golden retriever shield' })

    const vault = {
      verify: vi.fn().mockResolvedValue(true),
      unlock: vi.fn().mockResolvedValue(true),
      lock: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue('unlocked'),
      getLogin: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
    }

    const approver = new PolicyApprover({
      prompt: adapters.prompt,
      checker: vault,
      settings,
      limiter: new AttemptLimiter(),
      platform: 'darwin',
    })

    const api: any = {
      status: async () => ({ ok: true, message: `vault: unlocked; mode: ${await approver.effectiveMode()}` }),
      requestAllow: async (d: string, u: string, i: string) => {
        const ok = await approver.ask('Allow Domain', [`Domain: ${d}`])
        return { ok, message: ok ? 'approved' : 'denied' }
      },
    }

    server = await startIpcServer(socketPath, api, { authorize: adapters.authorize })
    const client = new IpcClient(socketPath)

    // 1. Check status (mode must be hardcore on darwin)
    const st = await client.status()
    expect(st.ok).toBe(true)
    expect(st.message).toContain('mode: hardcore')

    // 2. Request allow requires master password in protected prompt
    const res = await client.requestAllow('github.com', 'https://github.com/login', 'GitHub')
    expect(res.ok).toBe(true)
    expect(res.message).toBe('approved')
    expect(exec).toHaveBeenCalledWith(
      '/bin/launchctl',
      expect.arrayContaining(['asuser', '501']),
      120000,
    )
    // Anti-phishing phrase displayed in the prompt script
    expect(exec.mock.calls[0][1][6]).toContain('golden retriever shield')

    // 3. Attack test: unauthorized client UID rejected
    currentPeerUid = 999
    const denied = await client.status()
    expect(denied.ok).toBe(false)
    expect(denied.message).toBe('caller not allowed')

    // Cleanup temp settings
    if (existsSync(tempSettings)) {
      try { unlinkSync(tempSettings) } catch {}
    }
  })

  it('cleans up stale socket on startup', async () => {
    const testDir = join(tmpdir(), `ucs-stale-test-${Date.now()}`)
    const testSocket = join(testDir, 'stale.sock')
    mkdirSync(testDir, { recursive: true })
    writeFileSync(testSocket, 'stale socket content')
    expect(existsSync(testSocket)).toBe(true)

    prepareSocketEndpoint(testSocket, 'darwin')
    expect(existsSync(testSocket)).toBe(false)

    // Cleanup test dir
    try { unlinkSync(testSocket) } catch {}
  })
})
