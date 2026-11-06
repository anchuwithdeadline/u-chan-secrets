import { describe, expect, it, vi } from 'vitest'
import { BitwardenVault } from '../src/core/vault.js'

async function vault(item: object, code = 0, stderr = '') {
  const v = new BitwardenVault({ dataDir: 'unused', idleLockMs: 10000, exec: async args => args[0] === 'unlock' ? { code: 0, stdout: 'SESSION', stderr: '' } : { code, stdout: JSON.stringify(item), stderr } })
  await v.unlock('master')
  return v
}
describe('Discord service token retrieval', () => {
  it('refreshes the private vault cache before discovering a newly added item', async () => {
    let synced = false
    const v = new BitwardenVault({ dataDir: 'unused', idleLockMs: 10000, exec: async (args, env) => {
      if (args[0] === 'unlock') return { code: 0, stdout: 'SESSION', stderr: '' }
      expect(env.BW_SESSION).toBe('SESSION')
      if (args[0] === 'sync') { synced = true; return { code: 0, stdout: 'sync complete', stderr: '' } }
      return synced ? { code: 0, stdout: JSON.stringify({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', login: { password: 'SECRET' }, notes: 'Guild ID: 123' }), stderr: '' } : { code: 1, stdout: '', stderr: 'Not found.' }
    } })
    await v.unlock('master')
    expect((await v.getDiscordSetup('VDN Discord Bot')).guildId).toBe('123')
    expect(synced).toBe(true)
  })
  it('discovers setup from named metadata without returning password or note content', async () => {
    const v = await vault({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', login: { password: 'BOT_SECRET' }, notes: 'Server ID: 123456789012345678\nToken: NEVER_RETURN_THIS' })
    const setup = await v.getDiscordSetup('VDN Discord Bot')
    expect(setup).toEqual({ item: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', field: { kind: 'password' }, guildId: '123456789012345678' })
    expect(JSON.stringify(setup)).not.toMatch(/BOT_SECRET|NEVER_RETURN_THIS/)
    const hidden = await vault({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', fields: [{ name: 'Guild ID', type: 0, value: '123456789012345678' }, { name: 'Bot token', type: 1, value: 'SECRET' }] })
    expect((await hidden.getDiscordSetup('item')).field).toEqual({ kind: 'hidden', name: 'Bot token' })
  })
  it('does not confuse application IDs with server IDs or silently choose ambiguous fields', async () => {
    for (const data of [
      { fields: [{ name: 'Application ID', type: 0, value: '123456789012345678' }] },
      { fields: [{ name: 'Guild ID', type: 0, value: '123' }, { name: 'Server ID', type: 0, value: '456' }] },
      { fields: [{ name: 'Guild ID', type: 0, value: '123' }, { name: 'Bot token', type: 1, value: 'A' }, { name: 'Token', type: 1, value: 'B' }] },
    ]) await expect((await vault({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', ...data })).getDiscordSetup('item')).rejects.toThrow()
  })
  it('supports password-only and one exact hidden custom field without fallback', async () => {
    const v = await vault({ login: { password: 'BOT_SECRET' }, fields: [{ name: 'Bot token', type: 1, value: 'HIDDEN_SECRET' }] })
    expect(await v.getToken('VDN Discord Bot', { kind: 'password' })).toBe('BOT_SECRET')
    expect(await v.getToken('VDN Discord Bot', { kind: 'hidden', name: 'Bot token' })).toBe('HIDDEN_SECRET')
    await expect(v.getToken('VDN Discord Bot', { kind: 'hidden', name: 'missing' })).rejects.toThrow('token field is missing or ambiguous')
  })
  it('rejects duplicate/visible fields, unsafe tokens, locked vault and ambiguous items', async () => {
    for (const fields of [[{ name: 'x', type: 0, value: 'SECRET' }], [{ name: 'x', type: 1, value: 'A' }, { name: 'x', type: 1, value: 'B' }]]) await expect((await vault({ fields })).getToken('item', { kind: 'hidden', name: 'x' })).rejects.toThrow()
    await expect((await vault({ login: { password: 'bad\nvalue' } })).getToken('item', { kind: 'password' })).rejects.toThrow()
    const v = await vault({})
    await v.lock()
    await expect(v.getToken('item', { kind: 'password' })).rejects.toThrow()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect((await vault({}, 1, 'unexpected BOT_SECRET SESSION')).getToken('item', { kind: 'password' })).rejects.toThrow('bw failed')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    await expect((await vault({}, 1, 'More than one result was found.')).getToken('item', { kind: 'password' })).rejects.toThrow('multiple items match')
  })
})
