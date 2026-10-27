import { describe, it, expect, vi } from 'vitest'
import { BitwardenVault, type Exec } from '../src/core/vault.js'
import { UserFacingError } from '../src/core/types.js'

const dataDir = 'DATA'
/** Vault unlocked with session 'S'; `exec` handles every non-unlock call. */
const unlocked = async (exec: Exec) => {
  const v = new BitwardenVault({
    dataDir, idleLockMs: 1000,
    exec: async (a, e) => (a[0] === 'unlock' ? { code: 0, stdout: 'S', stderr: '' } : exec(a, e)),
  })
  expect(await v.unlock('pw')).toBe(true)
  return v
}
const ok = (stdout: string): Exec => async () => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, stdout = ''): Exec => async () => ({ code: 1, stdout, stderr })
const msg = async (p: Promise<unknown>) => {
  try { await p } catch (e) { expect(e).toBeInstanceOf(UserFacingError); return (e as Error).message }
  throw new Error('did not throw')
}

describe('BitwardenVault.status', () => {
  it('parses status', async () => {
    const v = (await unlocked(ok('{"status":"unlocked"}')))
    expect(await v.status()).toBe('unlocked')
  })
  it('unavailable when bw cannot run', async () => {
    const exec: Exec = async () => { throw Object.assign(new Error('spawn bw ENOENT'), { code: 'ENOENT' }) }
    expect(await (await unlocked(exec)).status()).toBe('unavailable')
  })
  it('unavailable on garbage output', async () => {
    expect(await (await unlocked(ok('nope'))).status()).toBe('unavailable')
  })
})

describe('BitwardenVault.getLogin', () => {
  it('returns credentials', async () => {
    const v = await unlocked(ok(JSON.stringify({ login: { username: 'u@x', password: 'p' } })))
    expect(await v.getLogin('item')).toEqual({ username: 'u@x', password: 'p' })
  })
  it('includes the TOTP seed when the item has one', async () => {
    const v = await unlocked(ok(JSON.stringify({ login: { username: 'u', password: 'p', totp: 'JBSWY3DP' } })))
    expect(await v.getLogin('item')).toEqual({ username: 'u', password: 'p', totp: 'JBSWY3DP' })
    const v2 = await unlocked(ok(JSON.stringify({ login: { username: 'u', password: 'p', totp: null } })))
    expect(await v2.getLogin('item')).toEqual({ username: 'u', password: 'p' })
  })
  it('maps multiple results', async () => {
    const v = (await unlocked(fail('More than one result was found.')))
    expect(await msg(v.getLogin('i'))).toBe('multiple items match, use the item id')
  })
  it('maps not found', async () => {
    const v = (await unlocked(fail('Not found.')))
    expect(await msg(v.getLogin('i'))).toBe('item not found')
  })
  it('maps locked', async () => {
    const v = (await unlocked(fail('Vault is locked.')))
    expect(await msg(v.getLogin('i'))).toBe('vault locked — run u-chan unlock')
  })
  it('maps not logged in (case-insensitive)', async () => {
    const v = (await unlocked(fail('You are not logged in.')))
    expect(await msg(v.getLogin('i'))).toBe('not logged in to Bitwarden — run u-chan install')
  })
  it('rejects item without username/password', async () => {
    const v = await unlocked(ok(JSON.stringify({ login: { username: 'u' } })))
    expect(await msg(v.getLogin('i'))).toBe('item has no username/password')
    const v2 = (await unlocked(ok('{}')))
    expect(await msg(v2.getLogin('i'))).toBe('item has no username/password')
  })
  it('passes session via env, not argv', async () => {
    let seen: { args: string[]; env: NodeJS.ProcessEnv } | undefined
    const exec: Exec = async (args, env) => {
      seen = { args, env }
      return { code: 0, stdout: JSON.stringify({ login: { username: 'u', password: 'p' } }), stderr: '' }
    }
    await (await unlocked(exec)).getLogin('my item')
    expect(seen!.env.BW_SESSION).toBe('S')
    expect(seen!.args).toEqual(['get', 'item', 'my item'])
    expect(seen!.args).not.toContain('S')
  })
  it('unknown errors return fixed message; redacted stderr goes to console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = (await unlocked(fail('weird failure with S inside', 'SECRETSTDOUT')))
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
    const m = await msg((await unlocked(exec)).getLogin('i'))
    expect(m).not.toContain('S')
  })
  const rejecting = (props: object): Exec => async () => { throw Object.assign(new Error('boom argv item'), props) }
  it.each(['ENOENT', 'EACCES', 'EINVAL'])('%s is not available', async (code) => {
    const v = (await unlocked(rejecting({ code })))
    expect(await msg(v.getLogin('i'))).toBe('bitwarden CLI (bw) is not available')
  })
  it('timeout/signal kill becomes bw timed out', async () => {
    const v = (await unlocked(rejecting({ code: null, signal: 'SIGKILL', killed: true })))
    expect(await msg(v.getLogin('i'))).toBe('bw timed out')
  })
  it('maxBuffer overflow becomes bw failed without error text', async () => {
    const v = (await unlocked(rejecting({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })))
    expect(await msg(v.getLogin('i'))).toBe('bw failed')
  })
})

describe('BitwardenVault session', () => {
  type Call = { args: string[]; env: NodeJS.ProcessEnv }
  const setup = (unlockResult = { code: 0, stdout: 'SESS', stderr: '' }) => {
    const calls: Call[] = []
    let t = 0
    const exec: Exec = async (args, env) => {
      calls.push({ args, env: { ...env } })
      if (args[0] === 'unlock') return unlockResult
      if (args[0] === 'status') return { code: 0, stdout: '{"status":"unlocked"}', stderr: '' }
      if (args[0] === 'lock') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: JSON.stringify({ login: { username: 'u', password: 'p' } }), stderr: '' }
    }
    const v = new BitwardenVault({ dataDir, idleLockMs: 1000, exec, now: () => t })
    return { v, calls, advance: (ms: number) => { t += ms } }
  }

  it('unlock keeps the session in memory', async () => {
    const { v, calls } = setup()
    expect(await v.unlock('pw')).toBe(true)
    expect(calls[0].args).toEqual(['unlock', '--passwordenv', 'UCS_BW_PASSWORD', '--raw'])
    expect(calls[0].env.UCS_BW_PASSWORD).toBe('pw')
    await v.getLogin('x')
    expect(calls[1].env.BW_SESSION).toBe('SESS')
    expect(calls.flatMap((c) => c.args)).not.toContain('pw')
  })
  it('every bw call uses the service data dir', async () => {
    const { v, calls } = setup()
    await v.unlock('pw'); await v.getLogin('x'); await v.status(); await v.lock()
    expect(calls.length).toBe(4)
    for (const c of calls) expect(c.env.BITWARDENCLI_APPDATA_DIR).toBe(dataDir)
  })
  it('wrong password', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { v } = setup({ code: 1, stdout: '', stderr: 'Invalid master password.' })
    expect(await v.unlock('bad')).toBe(false)
    expect(await v.status()).toBe('locked')
    spy.mockRestore()
  })
  it('locks after idle timeout; use resets the timer', async () => {
    const { v, advance } = setup()
    await v.unlock('pw')
    advance(900)
    await v.getLogin('x')
    advance(900)
    await v.getLogin('x')
    advance(1001)
    expect(await v.status()).toBe('locked')
    expect(await msg(v.getLogin('x'))).toBe('vault locked — run u-chan unlock')
  })
  it('lock forgets the session', async () => {
    const { v, calls } = setup()
    await v.unlock('pw')
    await v.lock()
    expect(calls[calls.length - 1].args).toEqual(['lock'])
    const n = calls.length
    expect(await v.status()).toBe('locked')
    expect(calls.length).toBe(n)
  })
  it('verify re-unlocks; bad password keeps the old session', async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    let n = 0
    const exec: Exec = async (args, env) => {
      calls.push({ args, env: { ...env } })
      if (args[0] === 'unlock') {
        return env.UCS_BW_PASSWORD === 'bad' ? { code: 1, stdout: '', stderr: 'nope' } : { code: 0, stdout: `S${++n}`, stderr: '' }
      }
      return { code: 0, stdout: JSON.stringify({ login: { username: 'u', password: 'p' } }), stderr: '' }
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = new BitwardenVault({ dataDir, idleLockMs: 1000, exec })
    await v.unlock('pw')
    expect(await v.verify('pw')).toBe(true)
    await v.getLogin('x')
    expect(calls[calls.length - 1].env.BW_SESSION).toBe('S2')
    expect(await v.verify('bad')).toBe(false)
    await v.getLogin('x')
    expect(calls[calls.length - 1].env.BW_SESSION).toBe('S2')
    spy.mockRestore()
  })
  it('never logs the master password', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { v } = setup({ code: 1, stdout: '', stderr: 'Invalid master password pw' })
    expect(await v.unlock('pw')).toBe(false)
    const logged = spy.mock.calls.map((c) => String(c[0]))
    expect(logged.length).toBeGreaterThan(0)
    for (const l of logged) { expect(l).not.toContain('pw '); expect(l.endsWith('pw')).toBe(false) }
    spy.mockRestore()
  })
})
