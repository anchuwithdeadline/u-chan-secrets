import { describe, expect, it } from 'vitest'
import { runDiscordCli, testDiscordConnection } from '../src/client/discord.js'

describe('read-only Discord connection test', () => {
  it('returns a compact success report without raw channel or role metadata', async () => {
    let inspected = 0
    const client = { discordInspect: async (alias: string) => {
      inspected++
      expect(alias).toBe('vdn')
      return { ok: true, message: JSON.stringify({ guild: { id: '123456789012345678', name: 'PRIVATE_NAME' }, totals: { channels: 14, roles: 8 }, channels: [{ topic: 'PRIVATE_TOPIC' }] }) }
    } }
    const result = await testDiscordConnection(client, 'vdn')
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.message)).toEqual({ connection: 'vdn', status: 'connected', readOnly: true, serverId: '123456789012345678', channels: 14, roles: 8 })
    expect(result.message).not.toContain('PRIVATE_')
    expect(inspected).toBe(1)
    expect(await runDiscordCli(['test', 'vdn'], client, async () => { throw new Error('must not read files') })).toEqual(result)
  })
  it('preserves service failures and rejects malformed success without exposing its body', async () => {
    const failed = { ok: false, code: 'unsupported_service' as const, message: 'upgrade required' }
    expect(await testDiscordConnection({ discordInspect: async () => failed }, 'vdn')).toEqual(failed)
    expect(await testDiscordConnection({ discordInspect: async () => ({ ok: true, message: 'PRIVATE_RAW_RESPONSE' }) }, 'vdn')).toEqual({ ok: false, message: 'Discord connection test received an invalid service response' })
    expect((await testDiscordConnection({}, 'vdn')).ok).toBe(false)
  })
  it('rejects invalid aliases and extra CLI arguments before making any service call', async () => {
    const client = { discordInspect: async () => { throw new Error('must not call service') } }
    expect((await testDiscordConnection(client, '../invalid')).ok).toBe(false)
    expect((await runDiscordCli(['test', 'vdn', 'extra'], client, async () => '')).ok).toBe(false)
  })
})
