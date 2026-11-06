import { describe, expect, it, vi } from 'vitest'
import { BitwardenVault } from '../src/core/vault.js'

async function vault(item: object, code = 0, stderr = '') {
  const v = new BitwardenVault({ dataDir: 'unused', idleLockMs: 10000, exec: async args => args[0] === 'unlock' ? { code: 0, stdout: 'SESSION', stderr: '' } : { code, stdout: JSON.stringify(item), stderr } })
  await v.unlock('master')
  return v
}
describe('Discord service token retrieval', () => {
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
