import { describe, it, expect, vi, afterEach } from 'vitest'
import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startIpcServer } from '../src/ipc/server.js'
import { IpcClient } from '../src/ipc/client.js'
import { FrameReader, MAX_FRAME } from '../src/ipc/protocol.js'
import { defaultEndpoint } from '../src/ipc/endpoint.js'

const sockPath = () =>
  process.platform === 'win32'
    ? String.raw`\\.\pipe\ucs-test-` + randomBytes(6).toString('hex')
    : join(mkdtempSync(join(tmpdir(), 'ucs-')), 's.sock')

const names = ['login', 'requestAllow', 'revoke', 'listAllowed', 'status', 'unlock', 'lock', 'setMode', 'importV1', 'audit'] as const
const fakeApi = () => Object.fromEntries(names.map(n => [n, vi.fn(async () => ({ ok: true, message: n }))])) as any

const servers: net.Server[] = []
const start = async (api: any, opts?: any) => {
  const p = sockPath()
  servers.push(await startIpcServer(p, api, opts))
  return p
}
afterEach(() => { servers.splice(0).forEach(s => s.close()) })

const raw = (p: string, data: string | Buffer) =>
  new Promise<{ text: string; closed: boolean }>(resolve => {
    let mine = false
    const s = net.connect(p)
    let text = ''
    s.on('data', d => { text += d })
    s.on('close', () => resolve({ text, closed: !mine }))
    s.on('error', () => {})
    s.on('connect', () => { s.write(data); setTimeout(() => { mine = true; s.destroy() }, 300) })
  })

describe('ipc', () => {
  it('round-trips every method', async () => {
    const api = fakeApi()
    const c = new IpcClient(await start(api))
    const sel = { username: '#u', password: '#p' }
    expect(await c.login('a.com')).toEqual({ ok: true, message: 'login' })
    expect(await c.requestAllow('a.com', 'https://a.com/l', 'item', sel)).toEqual({ ok: true, message: 'requestAllow' })
    expect(await c.revoke('a.com')).toEqual({ ok: true, message: 'revoke' })
    expect(await c.listAllowed()).toEqual({ ok: true, message: 'listAllowed' })
    expect(await c.status()).toEqual({ ok: true, message: 'status' })
    expect(await c.unlock()).toEqual({ ok: true, message: 'unlock' })
    expect(await c.lock()).toEqual({ ok: true, message: 'lock' })
    expect(await c.setMode('hardcore')).toEqual({ ok: true, message: 'setMode' })
    const entries = [{ a: 1 }, 'x']
    expect(await c.importV1(entries)).toEqual({ ok: true, message: 'importV1' })
    expect(await c.audit(50)).toEqual({ ok: true, message: 'audit' })
    expect(api.login).toHaveBeenCalledWith('a.com')
    expect(api.requestAllow).toHaveBeenCalledWith('a.com', 'https://a.com/l', 'item', sel)
    expect(api.revoke).toHaveBeenCalledWith('a.com')
    expect(api.setMode).toHaveBeenCalledWith('hardcore')
    expect(api.importV1).toHaveBeenCalledWith(entries)
    expect(api.audit).toHaveBeenCalledWith(50)
  })

  it('round-trips audit method', async () => {
    const api = fakeApi()
    const c = new IpcClient(await start(api))
    expect(await c.audit(50)).toEqual({ ok: true, message: 'audit' })
    expect(api.audit).toHaveBeenCalledWith(50)
  })

  it('rejects invalid audit limit', async () => {
    const api = fakeApi()
    const p = await start(api)
    expect(JSON.parse((await raw(p, '{"id":1,"method":"audit","params":{"limit":-1}}\n')).text)).toMatchObject({ ok: false, message: 'bad request' })
    expect(JSON.parse((await raw(p, '{"id":2,"method":"audit","params":{"limit":"lots"}}\n')).text)).toMatchObject({ ok: false, message: 'bad request' })
    expect(JSON.parse((await raw(p, '{"id":3,"method":"audit","params":{"limit":0}}\n')).text)).toMatchObject({ ok: false, message: 'bad request' })
    expect(JSON.parse((await raw(p, '{"id":4,"method":"audit","params":{"limit":1.5}}\n')).text)).toMatchObject({ ok: false, message: 'bad request' })
    expect(api.audit).not.toHaveBeenCalled()
  })

  it('rejects malformed and oversized frames', async () => {
    const api = fakeApi()
    const p = await start(api)
    expect((await raw(p, 'not json\n')).text).toBe('{"id":0,"ok":false,"message":"bad request"}\n')
    const big = await raw(p, Buffer.alloc(70000, 0x61))
    expect(big.closed).toBe(true)
    expect(JSON.parse((await raw(p, '{"id":1,"method":"nope","params":{}}\n')).text).message).toBe('unknown method')
    expect(JSON.parse((await raw(p, '{"id":2,"method":"login","params":{"domain":5}}\n')).text).message).toBe('bad request')
    expect(api.login).not.toHaveBeenCalled()
    expect(await new IpcClient(p).status()).toEqual({ ok: true, message: 'status' })
  })

  it('authorize throwing answers promptly with the frame id', async () => {
    const api = fakeApi()
    const c = new IpcClient(await start(api, { authorize: async () => { throw new Error('boom') } }), { timeoutMs: 2000 })
    expect(await c.status()).toEqual({ ok: false, message: 'internal error' })
    expect(api.status).not.toHaveBeenCalled()
  })

  it('reports service down', async () => {
    expect(await new IpcClient(sockPath()).login('x')).toEqual({
      ok: false, message: 'U-Chan service is not running — run u-chan install',
    })
  })

  it('refuses unauthorized callers', async () => {
    const api = fakeApi()
    const c = new IpcClient(await start(api, { authorize: async () => false }))
    expect(await c.status()).toEqual({ ok: false, message: 'caller not allowed' })
    expect(api.status).not.toHaveBeenCalled()
  })

  it('api throw becomes internal error', async () => {
    const api = fakeApi()
    api.login = vi.fn(async () => { throw new Error('secret') })
    const c = new IpcClient(await start(api))
    expect(await c.login('a.com')).toEqual({ ok: false, message: 'internal error' })
  })

  it('FrameReader splits lines and enforces the limit', () => {
    const r = new FrameReader()
    expect(r.push(Buffer.from('{"a":1}\n{"b"'))).toEqual([{ a: 1 }])
    expect(r.push(Buffer.from(':2}\n'))).toEqual([{ b: 2 }])
    expect(() => new FrameReader().push(Buffer.alloc(MAX_FRAME + 1, 0x61))).toThrow()
  })

  it('defaultEndpoint', () => {
    expect(defaultEndpoint({ U_CHAN_IPC: 'x' }, 'win32')).toBe('x')
    expect(defaultEndpoint({}, 'win32')).toBe(String.raw`\\.\pipe\u-chan-secrets`)
    expect(defaultEndpoint({}, 'darwin')).toBe('/var/run/u-chan-secrets/ipc.sock')
  })
})
