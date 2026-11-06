import { describe, expect, it } from 'vitest'
import { batchSchema, connectionSchema, permissionNames } from '../src/discord/policy.js'

const connection = { alias: 'vdn', item: 'VDN Discord Bot', field: { kind: 'password' }, guildId: '123456789012345678' }
describe('Discord policy', () => {
  it('accepts explicit password or hidden field, rejects unknown fields and unsafe strings', () => {
    expect(connectionSchema.parse(connection)).toEqual(connection)
    expect(connectionSchema.safeParse({ ...connection, field: { kind: 'hidden', name: 'Bot token' } }).success).toBe(true)
    for (const value of [{ ...connection, token: 'secret' }, { ...connection, alias: 'x\n' }, { ...connection, guildId: '../evil' }, { ...connection, item: '-x' }]) expect(connectionSchema.safeParse(value).success).toBe(false)
  })
  it('accepts typed operations only; bounds batches and permission bits', () => {
    const op = { type: 'role_create', name: 'Debater', permissions: '1024' }
    expect(batchSchema.parse([op])).toEqual([op])
    for (const ops of [[], Array(11).fill(op), [{ ...op, permissions: '8' }], [{ ...op, permissions: String(1n << 60n) }], [{ type: 'http', url: 'https://evil.test' }], [{ type: 'channel_edit', channelId: '123', changes: {} }]]) expect(batchSchema.safeParse(ops).success).toBe(false)
    expect(permissionNames('268435472')).toEqual(['MANAGE_CHANNELS', 'MANAGE_ROLES'])
  })
  it('rejects overlapping existing targets before any batch can partially change its own approval baseline', () => {
    expect(batchSchema.safeParse([{ type: 'role_edit', roleId: '123', changes: { name: 'A' } }, { type: 'role_edit', roleId: '123', changes: { color: 123 } }]).success).toBe(false)
    expect(batchSchema.safeParse([{ type: 'role_reorder', positions: [{ id: '123', position: 1 }] }, { type: 'member_role_add', roleId: '123', memberId: '456' }]).success).toBe(false)
    expect(batchSchema.safeParse([{ type: 'member_role_add', roleId: '123', memberId: '456' }, { type: 'member_role_add', roleId: '123', memberId: '789' }]).success).toBe(true)
  })
})
