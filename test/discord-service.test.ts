import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DiscordService } from '../src/discord/service.js'
import { DiscordStore } from '../src/discord/store.js'
import { DiscordHttp } from '../src/discord/http.js'

const guild = '123456789012345678', channel = '223456789012345678', bot = '323456789012345678', botRole = '423456789012345678', role = '523456789012345678', member = '623456789012345678'
const connection = { alias: 'vdn', item: 'VDN Discord Bot', field: { kind: 'password' as const }, guildId: guild }
async function fixture(options: { approve?: boolean; admin?: boolean; foreign?: boolean; auditFail?: boolean; platform?: NodeJS.Platform; uncertain?: boolean; afterApprove?: () => void; secondAuditFail?: boolean; failureAfterFirst?: boolean; token?: string; missingId?: boolean } = {}) {
  const store = new DiscordStore(join(await realpath(await mkdtemp(join(tmpdir(), 'ucs-broker-'))), 'discord.json'))
  const writes: string[] = [], prompts: string[][] = [], audit: unknown[] = []
  let fetched = 0, writeIntents = 0
  const roles = [{ id: guild, name: '@everyone', permissions: '1024', position: 0, managed: false }, { id: botRole, name: 'Bot', permissions: '268435472', position: 10, managed: false }, { id: role, name: 'Debater', permissions: options.admin ? '8' : '1024', position: 1, managed: false }]
  const http = new DiscordHttp(async (url, init) => {
    const path = url.replace('https://discord.com/api/v10', '')
    if (init.method !== 'GET') {
      writes.push(path)
      if (options.uncertain) throw new Error('TOKEN_SECRET')
      return new Response(JSON.stringify(options.missingId ? {} : { id: role, name: 'TOKEN_SECRET' }), { status: 200 })
    }
    const data = path === '/users/@me' ? { id: bot } : path.endsWith('/roles') ? roles : path.endsWith('/channels') ? [{ id: channel, guild_id: options.foreign ? '999' : guild, name: options.token ?? 'general', type: 0, parent_id: null, permission_overwrites: [] }] : path.includes('/members/') ? { user: { id: path.split('/').at(-1) }, roles: path.endsWith(bot) ? [botRole] : [] } : { id: guild, name: 'VDN' }
    return new Response(JSON.stringify(data))
  })
  const service = new DiscordService({ store, http, platform: options.platform ?? 'win32', vault: { status: async () => options.failureAfterFirst && writes.length > 0 ? 'locked' : 'unlocked', getToken: async () => { fetched++; return options.token ?? 'TOKEN_SECRET' } }, queue: work => work(), approver: { ask: async (_title, lines) => { prompts.push(lines); options.afterApprove?.(); return options.approve !== false } }, audit: { record: async e => { if (e.result.startsWith('intent')) writeIntents++; if (options.auditFail || (options.secondAuditFail && writeIntents === 2)) throw new Error('failed'); audit.push(e) } } })
  return { service, store, writes, prompts, audit, fetched: () => fetched, roles }
}
describe('Discord broker service', () => {
  it('approves only connection metadata before fetching any credential', async () => {
    const f = await fixture()
    expect((await f.service.discordRequestAllow(connection)).ok).toBe(true)
    expect(f.fetched()).toBe(0)
    expect((await f.service.discordInspect('vdn')).ok).toBe(true)
    expect(f.writes).toEqual([])
    expect(f.prompts[0].join('\n')).toContain(guild)
    expect((await f.service.discordRevoke('vdn')).ok).toBe(true)
    expect((await f.service.discordInspect('vdn')).ok).toBe(false)
  })
  it('protects item discovery, then requires a second exact server/field approval', async () => {
    const store = new DiscordStore(join(await realpath(await mkdtemp(join(tmpdir(), 'ucs-discovery-'))), 'discord.json'))
    let discoveries = 0, prompts = 0, tokenReads = 0
    const service = new DiscordService({ store, http: new DiscordHttp(), platform: 'win32', queue: work => work(), approver: { ask: async () => { prompts++; return true } }, audit: { record: async () => {} }, vault: { status: async () => 'unlocked', getToken: async () => { tokenReads++; return 'SECRET' }, getDiscordSetup: async () => { expect(prompts).toBe(1); discoveries++; return { ...connection, item: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } } } })
    expect((await service.discordRequestAllow({ alias: 'vdn', item: 'VDN Discord Bot' })).ok).toBe(true)
    expect(prompts).toBe(2)
    expect(discoveries).toBe(1)
    expect(tokenReads).toBe(0)
    expect((await store.get('vdn'))?.guildId).toBe(guild)
  })
  it('never reads vault metadata when protected discovery is denied', async () => {
    const store = new DiscordStore(join(await realpath(await mkdtemp(join(tmpdir(), 'ucs-discovery-'))), 'discord.json'))
    let reads = 0
    const service = new DiscordService({ store, http: new DiscordHttp(), platform: 'win32', queue: work => work(), approver: { ask: async () => false }, audit: { record: async () => {} }, vault: { status: async () => 'unlocked', getToken: async () => 'SECRET', getDiscordSetup: async () => { reads++; throw new Error('must not read') } } })
    expect((await service.discordRequestAllow({ alias: 'vdn', item: 'VDN Discord Bot' })).ok).toBe(false)
    expect(reads).toBe(0)
    expect(await store.list()).toEqual([])
  })
  it('does not persist or contact Discord when the second approval is denied', async () => {
    const store = new DiscordStore(join(await realpath(await mkdtemp(join(tmpdir(), 'ucs-discovery-'))), 'discord.json'))
    let prompts = 0, network = 0
    const service = new DiscordService({ store, http: new DiscordHttp(async () => { network++; throw new Error('no network') }), platform: 'win32', queue: work => work(), approver: { ask: async () => ++prompts === 1 }, audit: { record: async () => {} }, vault: { status: async () => 'unlocked', getToken: async () => { throw new Error('must not fetch token') }, getDiscordSetup: async () => ({ item: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', guildId: guild, field: { kind: 'password' } }) } })
    expect((await service.discordRequestAllow({ alias: 'vdn', item: 'VDN Discord Bot' })).ok).toBe(false)
    expect(prompts).toBe(2)
    expect(await store.list()).toEqual([])
    expect(network).toBe(0)
  })
  it('requires exact protected approval for writes and redacts echoed token', async () => {
    const f = await fixture()
    await f.store.upsert(connection)
    const result = await f.service.discordApply('vdn', [{ type: 'role_create', name: 'Debater', permissions: '1024' }])
    expect(result.ok).toBe(true)
    expect(f.writes).toHaveLength(1)
    expect(f.prompts[0].join('\n')).toContain('VIEW_CHANNEL')
    expect(result.message).not.toContain('TOKEN_SECRET')
    expect(JSON.stringify(f.audit)).not.toContain('TOKEN_SECRET')
  })
  it('rejects denied approval, foreign channels and existing administrator assignment', async () => {
    for (const options of [{ approve: false }, { foreign: true }, { admin: true }]) {
      const f = await fixture(options)
      await f.store.upsert(connection)
      const op = options.admin ? { type: 'member_role_add', memberId: member, roleId: role } : { type: 'channel_edit', channelId: channel, changes: { name: 'new' } }
      expect((await f.service.discordApply('vdn', [op])).ok).toBe(false)
      expect(f.writes).toHaveLength(0)
    }
  })
  it('fails closed on missing audit, unsupported platform, and unknown writes', async () => {
    for (const options of [{ auditFail: true }, { platform: 'darwin' as const }, { uncertain: true }]) {
      const f = await fixture(options)
      await f.store.upsert(connection)
      const result = await f.service.discordApply('vdn', [{ type: 'role_create', name: 'Debater' }, { type: 'role_create', name: 'Judge' }])
      expect(result.ok).toBe(false)
      expect(f.writes.length).toBe(options.uncertain ? 1 : 0)
      if (options.uncertain) expect(result.message).toContain('unknown')
    }
  })
  it('snapshots caller operations before approval and rechecks role permissions afterward', async () => {
    const f = await fixture()
    await f.store.upsert(connection)
    const operations = [{ type: 'role_create', name: 'Safe' }]
    const result = f.service.discordApply('vdn', operations)
    operations[0].name = 'Unapproved'
    expect((await result).ok).toBe(true)
    expect(f.prompts[0].join('\n')).toContain('Safe')
    expect(f.prompts[0].join('\n')).not.toContain('Unapproved')
    const changed = await fixture({ afterApprove: () => { changed.roles[2].permissions = '8' } })
    await changed.store.upsert(connection)
    expect((await changed.service.discordApply('vdn', [{ type: 'member_role_add', roleId: role, memberId: member }])).ok).toBe(false)
    expect(changed.writes).toHaveLength(0)
  })
  it('preserves completed results when a later audit or vault check fails', async () => {
    for (const options of [{ secondAuditFail: true }, { failureAfterFirst: true }]) {
      const f = await fixture(options)
      await f.store.upsert(connection)
      const result = await f.service.discordApply('vdn', [{ type: 'role_create', name: 'A' }, { type: 'role_create', name: 'B' }])
      expect(result.ok).toBe(false)
      expect(JSON.parse(result.message).completed).toHaveLength(1)
      expect(JSON.parse(result.message).outcome).toBe('not_sent')
      expect(f.writes).toHaveLength(1)
    }
  })
  it('redacts JSON-escaped token echoes and stops on a missing create-result ID', async () => {
    const f = await fixture({ token: 'SECRET"ESCAPED' })
    await f.store.upsert(connection)
    const result = await f.service.discordInspect('vdn')
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.message).channels[0].name).toBe('[REDACTED]')
    const bad = await fixture({ missingId: true })
    await bad.store.upsert(connection)
    const applied = await bad.service.discordApply('vdn', [{ type: 'role_create', name: 'A' }, { type: 'role_create', name: 'B' }])
    expect(applied.ok).toBe(false)
    expect(JSON.parse(applied.message).outcome).toBe('unknown')
    expect(bad.writes).toHaveLength(1)
  })
  it('audits member and role IDs without recording raw payloads', async () => {
    const f = await fixture()
    await f.store.upsert(connection)
    expect((await f.service.discordApply('vdn', [{ type: 'member_role_add', memberId: member, roleId: role }])).ok).toBe(true)
    expect(JSON.stringify(f.audit)).toContain(member)
    expect(JSON.stringify(f.audit)).toContain(role)
    expect(JSON.stringify(f.audit)).not.toContain('TOKEN_SECRET')
  })
  it('refuses assigning existing roles with unknown permission bits', async () => {
    const f = await fixture()
    await f.store.upsert(connection)
    f.roles[2].permissions = String(1n << 60n)
    const result = await f.service.discordApply('vdn', [{ type: 'member_role_add', memberId: member, roleId: role }])
    expect(result.ok).toBe(false)
    expect(f.writes).toHaveLength(0)
  })
})
