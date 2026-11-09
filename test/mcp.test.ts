import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer, withPlaywrightStatus } from '../src/mcp/server.js'
import type { PlaywrightCheck } from '../src/core/doctor.js'
import { NEXT_STEP } from '../src/core/result-hints.js'
import { RESULT_CODES } from '../src/core/types.js'

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
    expect(lines.join('\n')).toContain('call request_unlock once when available')
    expect(lines.join('\n')).toContain('Stop after cancellation, failure, or cooldown')
    expect(lines.join('\n')).toContain('Older services require the user to run u-chan unlock')
    expect(lines.join('\n')).not.toMatch(/Windows dialog|unlock\.ps1/)
  })
})

describe('next-step hints', () => {
  const text = async (c: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) =>
    ((await c.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text
  it('appends next step for needs_human', async () => {
    const c = await connect({ login: async () => ({ ok: false, code: 'needs_human', message: 'needs you' }) } as Partial<Core>)
    expect(await text(c, 'login', { domain: 'a.com' })).toBe('[needs_human] needs you\nNext: ' + NEXT_STEP.needs_human)
  })
  it('unsupported_service hint points at update --check and doctor', async () => {
    const c = await connect({ login: async () => ({ ok: false, code: 'unsupported_service', message: 'upgrade required' }) } as Partial<Core>)
    expect(await text(c, 'login', { domain: 'a.com' })).toBe('[unsupported_service] upgrade required\nNext: Ask the user to run u-chan update --check and follow its output; if the service is unreachable, ask them to run u-chan doctor.')
  })
  it('no hint for codes without one', async () => {
    const c = await connect({ login: async () => ({ ok: false, code: 'internal_error', message: 'x' }) } as Partial<Core>)
    expect(await text(c, 'login', { domain: 'a.com' })).toBe('[internal_error] x')
  })
  it('every RESULT_CODES entry except invalid_policy and internal_error has a hint', () => {
    for (const code of RESULT_CODES) if (code !== 'invalid_policy' && code !== 'internal_error') expect(NEXT_STEP[code], code).toBeTruthy()
  })
  it('request_allow without success adds a note', async () => {
    const note = '\nNote: no success condition in this request; login may return authentication_unconfirmed.'
    const args = { domain: 'a.com', login_url: 'https://a.com/l', item: 'A' }
    const c = await connect({})
    expect((await text(c, 'request_allow', args)).endsWith(note)).toBe(true)
    expect(await text(c, 'request_allow', { ...args, success: { url: 'https://a.com/home' } })).toBe('approved')
    const f = await connect({ requestAllow: async () => ({ ok: false, message: 'denied' }) })
    expect(await text(f, 'request_allow', args)).toBe('denied')
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
    expect(await core.status()).toEqual({ ok: true, message: 'vault: unlocked; mode: easy; playwright: shared browser process configuration observed; active AI session ownership unverified' })
    pw = 'not_found'
    expect(await core.status()).toEqual({ ok: true, message: 'vault: unlocked; mode: easy; playwright: not found' })
    pw = 'unknown'
    expect(await core.status()).toEqual({ ok: true, message: 'vault: unlocked; mode: easy; playwright: unknown' })
  })
  it('keeps a failing service status failing', async () => {
    const core = withPlaywrightStatus(base(false, 'vault: locked; mode: easy'), async () => 'ok')
    expect(await core.status()).toEqual({ ok: false, message: 'vault: locked; mode: easy; playwright: shared browser process configuration observed; active AI session ownership unverified' })
  })
  it('exposes only the CoreApi methods', () => {
    const core = withPlaywrightStatus({ ...base(true, ''), unlock: async () => ({ ok: true, message: '' }) } as never, async () => 'ok')
    expect(Object.keys(core).sort()).toEqual(['listAllowed', 'login', 'requestAllow', 'revoke', 'status'])
  })
})

describe('request_allow without item', () => {
  it('request_allow without item sends an empty item', async () => {
    let args: unknown[] = []
    const c = await connect({ requestAllow: async (...a: unknown[]) => { args = a; return { ok: true, message: 'approved' } } } as Partial<Core>)
    await c.callTool({ name: 'request_allow', arguments: { domain: 'a.com', login_url: 'https://a.com/l' } })
    expect(args).toEqual(['a.com', 'https://a.com/l', ''])
    expect(c.getInstructions()).not.toContain('ask the user which Bitwarden item')
    expect(c.getInstructions()).toContain('leave item out unless the user named one')
  })
})
