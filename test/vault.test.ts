import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BitwardenVault, type Exec } from '../src/core/vault.js'
import { UserFacingError } from '../src/core/types.js'

let dir: string
let sessionPath: string
const saved = process.env.BW_SESSION
beforeEach(() => {
  delete process.env.BW_SESSION
  dir = mkdtempSync(join(tmpdir(), 'vault-'))
  sessionPath = join(dir, 'bw-session')
  writeFileSync(sessionPath, 'S\n')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (saved === undefined) delete process.env.BW_SESSION
  else process.env.BW_SESSION = saved
})

const ok = (stdout: string): Exec => async () => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, stdout = ''): Exec => async () => ({ code: 1, stdout, stderr })
const msg = async (p: Promise<unknown>) => {
  try { await p } catch (e) { expect(e).toBeInstanceOf(UserFacingError); return (e as Error).message }
  throw new Error('did not throw')
}

describe('BitwardenVault.status', () => {
  it('parses status', async () => {
    const v = new BitwardenVault({ sessionPath, exec: ok('{"status":"unlocked"}') })
    expect(await v.status()).toBe('unlocked')
  })
  it('unavailable when bw cannot run', async () => {
    const exec: Exec = async () => { throw Object.assign(new Error('spawn bw ENOENT'), { code: 'ENOENT' }) }
    expect(await new BitwardenVault({ sessionPath, exec }).status()).toBe('unavailable')
  })
  it('unavailable on garbage output', async () => {
    expect(await new BitwardenVault({ sessionPath, exec: ok('nope') }).status()).toBe('unavailable')
  })
})

describe('BitwardenVault.getLogin', () => {
  it('returns credentials', async () => {
    const v = new BitwardenVault({ sessionPath, exec: ok(JSON.stringify({ login: { username: 'u@x', password: 'p' } })) })
    expect(await v.getLogin('item')).toEqual({ username: 'u@x', password: 'p' })
  })
  it('maps multiple results', async () => {
    const v = new BitwardenVault({ sessionPath, exec: fail('More than one result was found.') })
    expect(await msg(v.getLogin('i'))).toBe('multiple items match, dùng item id')
  })
  it('maps not found', async () => {
    const v = new BitwardenVault({ sessionPath, exec: fail('Not found.') })
    expect(await msg(v.getLogin('i'))).toBe('item not found')
  })
  it('maps locked', async () => {
    const v = new BitwardenVault({ sessionPath, exec: fail('Vault is locked.') })
    expect(await msg(v.getLogin('i'))).toBe('vault locked — chạy scripts/unlock.ps1')
  })
  it('maps not logged in (case-insensitive)', async () => {
    const v = new BitwardenVault({ sessionPath, exec: fail('You are not logged in.') })
    expect(await msg(v.getLogin('i'))).toBe('chưa đăng nhập Bitwarden — chạy bw login rồi scripts/unlock.ps1')
  })
  it('rejects item without username/password', async () => {
    const v = new BitwardenVault({ sessionPath, exec: ok(JSON.stringify({ login: { username: 'u' } })) })
    expect(await msg(v.getLogin('i'))).toBe('item has no username/password')
    const v2 = new BitwardenVault({ sessionPath, exec: ok('{}') })
    expect(await msg(v2.getLogin('i'))).toBe('item has no username/password')
  })
  it('passes session via env, not argv', async () => {
    let seen: { args: string[]; env: NodeJS.ProcessEnv } | undefined
    const exec: Exec = async (args, env) => {
      seen = { args, env }
      return { code: 0, stdout: JSON.stringify({ login: { username: 'u', password: 'p' } }), stderr: '' }
    }
    await new BitwardenVault({ sessionPath, exec }).getLogin('my item')
    expect(seen!.env.BW_SESSION).toBe('S')
    expect(seen!.args).toEqual(['get', 'item', 'my item'])
    expect(seen!.args).not.toContain('S')
  })
  it('BW_SESSION env takes precedence over file', async () => {
    process.env.BW_SESSION = 'ENVSESS'
    let s: string | undefined
    const exec: Exec = async (_a, env) => { s = env.BW_SESSION; return { code: 0, stdout: '{"status":"locked"}', stderr: '' } }
    await new BitwardenVault({ sessionPath, exec }).status()
    expect(s).toBe('ENVSESS')
  })
  it('works without a session file', async () => {
    const v = new BitwardenVault({ sessionPath: join(dir, 'missing'), exec: fail('Vault is locked.') })
    expect(await msg(v.getLogin('i'))).toContain('vault locked')
  })
  it('unknown errors return fixed message; redacted stderr goes to console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = new BitwardenVault({ sessionPath, exec: fail('weird failure with S inside', 'SECRETSTDOUT') })
    const m = await msg(v.getLogin('i'))
    expect(m).toBe('bw failed (exit 1)')
    const logged = spy.mock.calls.flat().join(' ')
    expect(logged).toContain('weird failure')
    expect(logged).not.toMatch(/S/)
    expect(logged).not.toContain('SECRETSTDOUT')
    spy.mockRestore()
  })
  it('spawn failure becomes a user-facing error', async () => {
    const exec: Exec = async () => { throw new Error('spawn bw ENOENT S') }
    const m = await msg(new BitwardenVault({ sessionPath, exec }).getLogin('i'))
    expect(m).not.toContain('S')
  })
  const rejecting = (props: object): Exec => async () => { throw Object.assign(new Error('boom argv item'), props) }
  it.each(['ENOENT', 'EACCES', 'EINVAL'])('%s is not available', async (code) => {
    const v = new BitwardenVault({ sessionPath, exec: rejecting({ code }) })
    expect(await msg(v.getLogin('i'))).toBe('bitwarden CLI (bw) is not available')
  })
  it('timeout/signal kill becomes bw timed out', async () => {
    const v = new BitwardenVault({ sessionPath, exec: rejecting({ code: null, signal: 'SIGKILL', killed: true }) })
    expect(await msg(v.getLogin('i'))).toBe('bw timed out')
  })
  it('maxBuffer overflow becomes bw failed without error text', async () => {
    const v = new BitwardenVault({ sessionPath, exec: rejecting({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) })
    expect(await msg(v.getLogin('i'))).toBe('bw failed')
  })
})
