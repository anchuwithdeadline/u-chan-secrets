import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer, withPlaywrightStatus } from '../src/mcp/server.js'
import type { PlaywrightCheck } from '../src/core/doctor.js'

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
  it('carries V3 approval policy and success condition through MCP', async () => {
    let args: unknown[] = []
    const c = await connect({ requestAllow: async (...a: unknown[]) => { args = a; return { ok: true, message: 'approved' } } } as Partial<Core>)
    const grant = { kind: 'once' }, success = { url: 'https://a.com/home' }
    await c.callTool({ name: 'request_allow', arguments: { domain: 'a.com', login_url: 'https://a.com/login', item: 'A', grant, success } })
    expect(args[4]).toEqual({ grant, success })
    await c.close()
  })
  it('lists the five tools', async () => {
    const c = await connect({})
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['list_allowed', 'login', 'request_allow', 'revoke', 'status'])
  })

  it('sends usage instructions on connect', async () => {
    const c = await connect({})
    const text = c.getInstructions() ?? ''
    expect(text).toMatch(/never ask the user for a password/i)
    expect(text).toMatch(/login/)
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

  it('request_allow accepts selectors', async () => {
    let args: unknown[] = []
    const c = await connect({ requestAllow: async (...a: unknown[]) => { args = a; return { ok: true, message: 'approved' } } } as Partial<Core>)
    const selectors = { username: '#u', password: '#p', submit: 'button', otp: '#otp' }
    const r = await c.callTool({ name: 'request_allow', arguments: { domain: 'a.com', login_url: 'https://a.com/l', item: 'A', selectors } })
    expect(r.isError).toBe(false)
    expect(args).toEqual(['a.com', 'https://a.com/l', 'A', selectors])
    const bad = await c.callTool({ name: 'request_allow', arguments: { domain: 'a.com', login_url: 'https://a.com/l', item: 'A', selectors: { evil: 'x' } } })
    expect(bad.isError).toBe(true)
    const long = await c.callTool({ name: 'request_allow', arguments: { domain: 'a.com', login_url: 'https://a.com/l', item: 'A', selectors: { username: 'x'.repeat(1001) } } })
    expect(long.isError).toBe(true)
    expect(args[3]).toEqual(selectors)
    const max = { username: 'x'.repeat(1000) }
    expect((await c.callTool({ name: 'request_allow', arguments: { domain: 'a.com', login_url: 'https://a.com/l', item: 'A', selectors: max } })).isError).toBe(false)
    expect(args[3]).toEqual(max)
  })

  it('instructions point to the U-Chan window and u-chan unlock', async () => {
    const lines = ((await connect({})).getInstructions() ?? '').split('\n')
    expect(lines.slice(-2)).toEqual([
      'If the domain is not allowlisted, ask the user which Bitwarden item to use, then call request_allow; the user approves it in a U-Chan window.',
      'If login fails, call status: a locked vault means the user must run u-chan unlock themselves. If login says "needs you", ask the user to sign in by hand.',
    ])
    expect(lines.join('\n')).not.toMatch(/Windows dialog|unlock\.ps1/)
  })
})

describe('withPlaywrightStatus', () => {
  const base = (ok: boolean, message: string) => ({
    login: async () => ({ ok: true, message: 'x' }),
    requestAllow: async () => ({ ok: true, message: 'x' }),
    revoke: async () => ({ ok: true, message: 'x' }),
    listAllowed: async () => ({ ok: true, message: 'x' }),
    status: async () => ({ ok, message }),
  })
  it('reports process configuration without claiming active AI-session ownership', async () => {
    let pw: PlaywrightCheck = 'missing'
    const core = withPlaywrightStatus(base(true, 'vault: unlocked; mode: easy'), async () => pw)
    expect(await core.status()).toEqual({
      ok: false,
      message: 'vault: unlocked; mode: easy; playwright: missing or mismatched --cdp-endpoint (restart the AI session)',
    })
    pw = 'ok'
    expect(await core.status()).toEqual({ ok: true, message: 'vault: unlocked; mode: easy; playwright: shared chrome process configuration observed; active AI session ownership unverified' })
    pw = 'not_found'
    expect(await core.status()).toEqual({ ok: true, message: 'vault: unlocked; mode: easy; playwright: not found' })
    pw = 'unknown'
    expect(await core.status()).toEqual({ ok: true, message: 'vault: unlocked; mode: easy; playwright: unknown' })
  })
  it('keeps a failing service status failing', async () => {
    const core = withPlaywrightStatus(base(false, 'vault: locked; mode: easy'), async () => 'ok')
    expect(await core.status()).toEqual({ ok: false, message: 'vault: locked; mode: easy; playwright: shared chrome process configuration observed; active AI session ownership unverified' })
  })
  it('exposes only the CoreApi methods', () => {
    const core = withPlaywrightStatus({ ...base(true, ''), unlock: async () => ({ ok: true, message: '' }) } as never, async () => 'ok')
    expect(Object.keys(core).sort()).toEqual(['listAllowed', 'login', 'requestAllow', 'revoke', 'status'])
  })
})
