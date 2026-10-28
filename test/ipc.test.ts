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

const names = ['login', 'requestAllow', 'revoke', 'listAllowed', 'status', 'unlock', 'lock', 'setMode', 'importV1', 'audit', 'update'] as const
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
    expect(await c.update()).toEqual({ ok: true, message: 'update' })
    expect(api.login).toHaveBeenCalledWith('a.com')
    expect(api.requestAllow).toHaveBeenCalledWith('a.com', 'https://a.com/l', 'item', sel)
    expect(api.revoke).toHaveBeenCalledWith('a.com')
    expect(api.setMode).toHaveBeenCalledWith('hardcore')
    expect(api.importV1).toHaveBeenCalledWith(entries)
    expect(api.audit).toHaveBeenCalledWith(50)
    expect(api.update).toHaveBeenCalled()
  })

  it('round-trips audit method', async () => {
    const api = fakeApi()
    const c = new IpcClient(await start(api))
    expect(await c.audit()).toEqual({ ok: true, message: 'audit' })
    expect(api.audit).toHaveBeenCalledWith(undefined)
  })

  it('round-trips update method', async () => {
    const api = fakeApi()
    const c = new IpcClient(await start(api))
    expect(await c.update()).toEqual({ ok: true, message: 'update' })
    expect(api.update).toHaveBeenCalled()
  })

  it('rejects invalid audit limit', async () => {
    const api = fakeApi()
    const p = await start(api)
    const res = await raw(p, JSON.stringify({ id: 1, method: 'audit', params: { limit: -5 } }) + '\n')
    const parsed = JSON.parse(res.text)
    expect(parsed).toEqual({ id: 1, ok: false, message: 'bad request' })
  })

  it('rejects unknown methods and bad requests', async () => {
    const api = fakeApi()
    const p = await start(api)
    expect(JSON.parse((await raw(p, '{"id":1,"method":"nope","params":{}}\n')).text)).toMatchObject({ id: 1, ok: false, message: 'unknown method' })
    expect(JSON.parse((await raw(p, '{"id":2,"method":"login","params":{}}\n')).text)).toMatchObject({ id: 2, ok: false, message: 'bad request' })
    expect(JSON.parse((await raw(p, 'not json\n')).text)).toMatchObject({ ok: false, message: 'bad request' })
  })

  it('drops callers that fail authorization', async () => {
    const api = fakeApi()
    const p = await start(api, { authorize: async () => false })
    const res = await raw(p, '{"id":1,"method":"status","params":{}}\n')
    expect(JSON.parse(res.text)).toMatchObject({ id: 1, ok: false, message: 'caller not allowed' })
  })

  it('handles uncaught handler throws', async () => {
    const api = { ...fakeApi(), status: () => { throw new Error('boom') } }
    const c = new IpcClient(await start(api))
    expect(await c.status()).toEqual({ ok: false, message: 'internal error' })
  })

  it('rejects malformed and oversized frames', async () => {
    const r = new FrameReader()
    expect(r.push(Buffer.from('{"a":1}\nnot json\n'))).toEqual([{ a: 1 }, undefined])
    expect(() => r.push(Buffer.alloc(MAX_FRAME + 1))).toThrow('frame too large')
  })

  it('returns clean error on connection failure', async () => {
    const c = new IpcClient(sockPath())
    expect(await c.status()).toMatchObject({ ok: false, message: expect.stringMatching(/U-Chan service is not running|connection failed/) })
  })

  it('returns timeout message on stuck call', async () => {
    const p = sockPath()
    const server = net.createServer(() => {})
    servers.push(server)
    await new Promise(r => server.listen(p, r as any))
    const c = new IpcClient(p, { timeoutMs: 50 })
    expect(await c.status()).toEqual({ ok: false, message: 'U-Chan service timed out' })
  })
})
