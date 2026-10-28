import { afterEach, expect, it } from 'vitest'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startIpcServer } from '../src/ipc/server.js'
import { IpcClient } from '../src/ipc/client.js'
const servers: net.Server[] = []
afterEach(() => { servers.splice(0).forEach(s => s.close()) })
async function client(api: any) {
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\ucs-v3-' + randomUUID() : join(tmpdir(), 'ucs-' + randomUUID())
  servers.push(await startIpcServer(path, api))
  return new IpcClient(path)
}
it('preserves safe result codes through real IPC', async () => {
  const c = await client({ login: async () => ({ ok: false, message: 'expired', code: 'grant_expired' }) })
  expect(await c.login('a.com')).toEqual({ ok: false, message: 'expired', code: 'grant_expired' })
})
it('passes exact policy only after capability verification', async () => {
  let received: unknown
  const c = await client({
    capabilities: async () => ({ ok: true, message: JSON.stringify({ protocol: 3, features: ['grants', 'success_conditions'] }) }),
    requestAllow: async (...args: unknown[]) => { received = args[4]; return { ok: true, message: 'approved' } },
  })
  const options = { grant: { kind: 'timed', minutes: 30 }, success: { url: 'https://a.com/home' } }
  expect((await (c.requestAllow as any)('a.com', 'https://a.com/login', 'item', undefined, options)).ok).toBe(true)
  expect(received).toEqual(options)
})
it('refuses temporary policy when old service lacks capabilities without sending approval request', async () => {
  let requested = false
  const c = await client({ requestAllow: async () => { requested = true; return { ok: true, message: 'approved' } } })
  expect((await (c.requestAllow as any)('a.com', 'https://a.com/login', 'item', undefined, { grant: { kind: 'once' } })).ok).toBe(false)
  expect(requested).toBe(false)
})
it('rejects invalid timed policy before an approval can run', async () => {
  let requested = false
  const c = await client({
    capabilities: async () => ({ ok: true, message: '{"protocol":3,"features":["grants"]}' }),
    requestAllow: async () => { requested = true; return { ok: true, message: 'approved' } },
  })
  expect((await (c.requestAllow as any)('a.com', 'https://a.com/login', 'item', undefined, { grant: { kind: 'timed', minutes: 1441 } })).ok).toBe(false)
  expect(requested).toBe(false)
})
