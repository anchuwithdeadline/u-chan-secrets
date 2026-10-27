import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp/server.js'

type Core = Parameters<typeof createMcpServer>[0]

async function connect(core: Partial<Core>) {
  const full = {
    login: async () => ({ ok: true, message: 'logged in' }),
    requestAllow: async () => ({ ok: true, message: 'approved' }),
    revoke: async () => ({ ok: true, message: 'revoked' }),
    listAllowed: async () => ({ ok: true, message: '' }),
    status: async () => ({ ok: true, message: 'vault: unlocked; chrome: connected' }),
    ...core,
  } as Core
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await createMcpServer(full).connect(st)
  const client = new Client({ name: 't', version: '0' })
  await client.connect(ct)
  return client
}

describe('mcp server', () => {
  it('lists the five tools', async () => {
    const c = await connect({})
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['list_allowed', 'login', 'request_allow', 'revoke', 'status'])
  })

  it('login returns core message', async () => {
    const c = await connect({})
    const r = await c.callTool({ name: 'login', arguments: { domain: 'a.com' } })
    expect(r.content).toEqual([{ type: 'text', text: 'logged in' }])
    expect(r.isError).toBe(false)
  })

  it('ok=false sets isError', async () => {
    const c = await connect({ login: async () => ({ ok: false, message: 'nope' }) })
    const r = await c.callTool({ name: 'login', arguments: { domain: 'a.com' } })
    expect(r.isError).toBe(true)
    expect(r.content).toEqual([{ type: 'text', text: 'nope' }])
  })

  it('passes request_allow args and survives throwing core', async () => {
    let args: unknown[] = []
    const c = await connect({ requestAllow: async (...a: unknown[]) => { args = a; throw new Error('boom') } } as Partial<Core>)
    const r = await c.callTool({ name: 'request_allow', arguments: { domain: 'a.com', login_url: 'https://a.com/l', item: 'A' } })
    expect(args).toEqual(['a.com', 'https://a.com/l', 'A'])
    expect(r.isError).toBe(true)
    expect(r.content).toEqual([{ type: 'text', text: 'internal error' }])
  })
})
