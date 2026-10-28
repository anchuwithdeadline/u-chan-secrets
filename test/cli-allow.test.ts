import { expect, it, vi } from 'vitest'
import { parseAllowArgs } from '../src/client/allow.js'
import { main } from '../src/cli.js'
const base = ['example.com', '--login-url', 'https://example.com/login', '--item', 'Example account']
it('defaults to once and accepts explicit grant policies and success conditions', () => {
  expect(parseAllowArgs(base)?.options).toEqual({ grant: { kind: 'once' } })
  expect(parseAllowArgs([...base, '--permanent'])?.options.grant).toEqual({ kind: 'permanent' })
  for (const minutes of ['1','1440']) expect(parseAllowArgs([...base, '--minutes', minutes])?.options.grant).toEqual({ kind: 'timed', minutes: Number(minutes) })
  expect(parseAllowArgs([...base, '--once','--success-selector', 'button[data-label="Sign out"]'])?.options.success).toEqual({ selector: 'button[data-label="Sign out"]' })
  expect(parseAllowArgs([...base, '--success-url', 'https://example.com/dashboard'])?.options.success).toEqual({ url: 'https://example.com/dashboard' })
})
it('rejects malformed or conflicting arguments without IPC', async () => {
  const bad = [[], [...base,'--minutes','0'], [...base,'--minutes','1441'], [...base,'--minutes','1.5'], [...base,'--minutes','1e2'], [...base,'--minutes'], [...base,'--once','--permanent'], [...base,'--once','--once'], [...base,'--item','another'], [...base,'--unknown'], [...base,'--success-url','https://example.com','--success-selector','main'], [...base,'--success-selector',' '], [...base,'--success-selector','x'.repeat(1001)], ['user:SECRET@example.com',...base.slice(1)], ['example.com','--login-url','http://example.com','--item','A'], ['example.com','--login-url','https://user:SECRET@example.com','--item','A'], [...base,'--success-url','https://user:SECRET@example.com']]
  for (const args of bad) {
    expect(parseAllowArgs(args)).toBeNull()
    const connect = vi.fn(), err = vi.fn()
    expect(await main(['allow', ...args], { connect, env: {}, platform: 'win32', readFile: vi.fn(), out: vi.fn(), err })).toBe(1)
    expect(connect).not.toHaveBeenCalled()
    expect(JSON.stringify(err.mock.calls)).not.toContain('SECRET')
  }
})
it('forwards one protected proposal and explains absent confirmation evidence', async () => {
  const requestAllow = vi.fn(async () => ({ ok: true, message: 'approved' })), out = vi.fn(), connect = vi.fn(() => ({ requestAllow }))
  expect(await main(['allow', ...base], { connect: connect as any, env: {}, platform: 'win32', readFile: vi.fn(), out, err: vi.fn() })).toBe(0)
  expect(requestAllow).toHaveBeenCalledExactlyOnceWith('example.com', 'https://example.com/login', 'Example account', undefined, { grant: { kind: 'once' } })
  expect(JSON.stringify(out.mock.calls)).toContain('authentication_unconfirmed')
  expect(connect).toHaveBeenCalledWith({ timeoutMs: 180000 })
})
