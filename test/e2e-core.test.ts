import { afterEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp/server.js'
import { startIpcServer } from '../src/ipc/server.js'
import { IpcClient } from '../src/ipc/client.js'
import { CoreService } from '../src/core/service.js'
import { ControlService } from '../src/service/control.js'
import { PolicyApprover } from '../src/service/policy-approver.js'
import { AttemptLimiter } from '../src/service/attempts.js'
import { SettingsStore } from '../src/service/settings.js'
import { AllowlistStore } from '../src/core/allowlist.js'
import { BitwardenVault, type Exec } from '../src/core/vault.js'
import type { AuditEvent, ControlApi, CoreApi, LoginRunner } from '../src/core/types.js'

const MASTER = 'master-PW-e2e'
const SESSION = 'SESSION-e2e-key'
const PASSWORD = 'site-PW-e2e-secret'

const dirs: string[] = []
const servers: net.Server[] = []
afterEach(async () => {
  servers.splice(0).forEach((s) => s.close())
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const pipePath = (dir: string) =>
  process.platform === 'win32' ? String.raw`\\.\pipe\ucs-e2e-` + randomBytes(6).toString('hex') : join(dir, 's.sock')

describe('e2e-core: MCP → IPC → service', () => {
  it('request_allow, list_allowed and login without leaking secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ucs-e2e-'))
    dirs.push(dir)
    const exec: Exec = async (args, env) => {
      if (args[0] === 'unlock') {
        return env.UCS_BW_PASSWORD === MASTER
          ? { code: 0, stdout: SESSION, stderr: '' }
          : { code: 1, stdout: '', stderr: 'Invalid master password.' }
      }
      if (args[0] === 'status') {
        return { code: 0, stdout: JSON.stringify({ status: env.BW_SESSION === SESSION ? 'unlocked' : 'locked' }), stderr: '' }
      }
      if (args[0] === 'get' && env.BW_SESSION === SESSION) {
        return { code: 0, stdout: JSON.stringify({ login: { username: 'me@example.com', password: PASSWORD } }), stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'Vault is locked.' }
    }
    const vault = new BitwardenVault({ dataDir: join(dir, 'bw'), idleLockMs: 43200000, exec })
    const settings = new SettingsStore(join(dir, 'settings.json'))
    const limiter = new AttemptLimiter()
    const prompt = { confirm: vi.fn(async () => true), askPassword: vi.fn(async (): Promise<string | null> => MASTER) }
    const approver = new PolicyApprover({ prompt, checker: vault, settings, limiter, platform: 'win32' })
    const allowlist = new AllowlistStore(join(dir, 'allowlist.json'))
    const events: AuditEvent[] = []
    const audit = { record: async (e: AuditEvent) => void events.push(e), readTail: async () => [] }
    const runner: LoginRunner = {
      run: async (_entry, getCreds) => {
        const c = await getCreds()
        return c.password === PASSWORD ? { status: 'logged_in' } : { status: 'failed', reason: 'bad creds' }
      },
    }
    const core = new CoreService({ vault, allowlist, approver, audit, login: runner, mode: () => approver.effectiveMode() })
    const control = new ControlService({ vault, approver, limiter, settings, allowlist, audit, platform: 'win32' })
    const api: CoreApi & ControlApi = {
      manage: () => control.manage(),
      diagnose: () => control.diagnose(),
      capabilities: () => control.capabilities(),
      login: (d) => core.login(d),
      requestAllow: (d, u, i, s) => core.requestAllow(d, u, i, s),
      revoke: (d) => core.revoke(d),
      listAllowed: () => core.listAllowed(),
      status: () => core.status(),
      unlock: () => control.unlock(),
      lock: () => control.lock(),
      setMode: (m) => control.setMode(m),
      importV1: (e) => control.importV1(e),
      audit: (l) => control.audit(l),
      update: () => control.update(),
    }
    const path = pipePath(dir)
    servers.push(await startIpcServer(path, api))

    // The user unlocks through the CLI path (control API), never through MCP.
    expect(await new IpcClient(path).unlock()).toEqual({ ok: true, message: 'unlocked' })

    const [ct, st] = InMemoryTransport.createLinkedPair()
    await createMcpServer(new IpcClient(path)).connect(st)
    const client = new Client({ name: 't', version: '0' })
    await client.connect(ct)

    const transcript: unknown[] = []
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args })
      transcript.push(r)
      return r
    }
    const text = (r: Awaited<ReturnType<typeof call>>) => (r.content as { text: string }[])[0].text

    const allow = await call('request_allow', {
      domain: 'example.com',
      login_url: 'https://example.com/login',
      item: 'Example',
      selectors: { username: '#u' },
    })
    expect(text(allow)).toBe('approved')
    expect(allow.isError).toBe(false)
    expect(prompt.confirm).toHaveBeenCalledTimes(1)
    expect((await allowlist.get('example.com'))?.selectors).toEqual({ username: '#u' })
    expect(text(await call('list_allowed'))).toContain('example.com')
    const login = await call('login', { domain: 'example.com' })
    expect(text(login)).toBe('logged in')
    expect(login.isError).toBe(false)
    expect(text(await call('status'))).toBe('vault: unlocked; mode: easy')

    const all = JSON.stringify(transcript) + JSON.stringify(events)
    for (const secret of [PASSWORD, SESSION, MASTER]) expect(all).not.toContain(secret)
  })
})
