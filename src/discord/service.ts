import { z } from 'zod'
import { abortable } from '../core/abort.js'
import type { Approver, AuditEvent, AuditLog, ToolResult, VaultStatus } from '../core/types.js'
import { UserFacingError } from '../core/types.js'
import { DiscordHttp, DiscordHttpError } from './http.js'
import { aliasSchema, batchSchema, connectionSchema, connectionRequestSchema, permissionNames, snowflake, SUPPORTED_PERMISSION_MASK, type DiscordApi, type DiscordConnection, type DiscordOperation, type TokenField } from './policy.js'
import type { DiscordStore } from './store.js'

const bits = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
const roleSchema = z.object({ id: snowflake, name: z.string().max(100), permissions: bits, position: z.number().int().min(0), managed: z.boolean(), color: z.number().optional(), hoist: z.boolean().optional(), mentionable: z.boolean().optional() })
const overwriteSchema = z.object({ id: snowflake, type: z.union([z.literal(0), z.literal(1)]), allow: bits, deny: bits })
const channelSchema = z.object({ id: snowflake, guild_id: snowflake.optional(), name: z.string().max(100), type: z.number().int(), parent_id: snowflake.nullable().optional(), topic: z.string().max(4096).nullable().optional(), position: z.number().optional(), permission_overwrites: z.array(overwriteSchema).max(100).optional() })
const memberSchema = z.object({ user: z.object({ id: snowflake }), roles: z.array(snowflake).max(1000) })
type Role = z.infer<typeof roleSchema>
type Channel = z.infer<typeof channelSchema>
type Member = z.infer<typeof memberSchema>
type Snapshot = { guild: { id: string; name: string }; roles: Role[]; channels: Channel[]; bot: Member; members: Map<string, Member> }
interface Deps {
  platform: NodeJS.Platform
  store: DiscordStore
  http: DiscordHttp
  vault: { status(signal?: AbortSignal): Promise<VaultStatus>; getToken(item: string, field: TokenField, signal?: AbortSignal): Promise<string> }
    & { getDiscordSetup?(item: string, signal?: AbortSignal): Promise<{ item: string; guildId: string; field: TokenField }> }
  approver: Approver
  audit: Pick<AuditLog, 'record'>
  queue: <T>(work: () => Promise<T>) => Promise<T>
}
class Refused extends Error {}
const refuse = (message: string): never => { throw new Refused(message) }
const safeJson = (value: unknown) => JSON.stringify(value).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const permissionsView = (value: string) => ({ bits: value, names: permissionNames(value) })

/** Fixed-purpose broker. Credentials never cross this privileged module's boundary. */
export class DiscordService implements DiscordApi {
  constructor(private readonly d: Deps) {}
  private run(work: (secrets: string[]) => Promise<ToolResult>): Promise<ToolResult> {
    return this.d.queue(async () => {
      if (this.d.platform !== 'win32') return { ok: false, message: 'Discord broker supports Windows only; complete protected review is required' }
      const secrets: string[] = []
      try {
        const result = await work(secrets)
        const scrub = (s: string) => secrets.reduce((v, secret) => secret ? v.split(secret).join('[REDACTED]') : v, s)
        try { result.message = safeJson(JSON.parse(JSON.stringify(JSON.parse(result.message), (_key, value) => typeof value === 'string' ? scrub(value) : value))) }
        catch { result.message = scrub(result.message) }
        if (Buffer.byteLength(result.message) > 60000) return { ok: false, message: 'Discord result exceeds the safe response limit; request a smaller metadata page' }
        return result
      } catch (e) {
        const message = e instanceof Refused || e instanceof DiscordHttpError ? e.message : 'Discord operation failed; check vault, policy, and service diagnostics'
        return { ok: false, message: secrets.reduce((s, secret) => secret ? s.split(secret).join('[REDACTED]') : s, message) }
      }
    }).catch(() => ({ ok: false, message: 'Discord service unavailable' }))
  }
  private async audit(action: AuditEvent['action'], connection: Pick<DiscordConnection, 'alias' | 'guildId'>, result: string): Promise<void> {
    await this.d.audit.record({ action, domain: `discord:${connection.alias}:${connection.guildId}`, result })
  }
  discordRequestAllow(proposal: unknown): Promise<ToolResult> {
    const parsed = connectionRequestSchema.safeParse(proposal)
    if (!parsed.success) return Promise.resolve({ ok: false, message: 'invalid Discord connection policy' })
    const request = parsed.data
    return this.run(async () => {
      let c: DiscordConnection
      if ('guildId' in request) c = request
      else {
        const target = { alias: request.alias, guildId: 'pending' }
        const approved = await this.d.approver.ask('U-Chan Secrets - Discord vault discovery', [
          'Read setup metadata from this exact Bitwarden item?', `Connection: ${safeJson(request.alias)}`, `Bitwarden item: ${safeJson(request.item)}`,
          'Extract only a labeled server ID and a password/hidden-token field selector. Token values and raw notes stay inside the service.',
          'This does not create a Discord grant or send a Discord request. A second protected prompt must approve the exact server and token field.',
        ])
        await this.audit('discord_allow', target, approved ? 'discovery approved' : 'discovery denied')
        if (!approved) return { ok: false, message: 'denied' }
        if (!this.d.vault.getDiscordSetup) return refuse('service does not support protected Discord metadata discovery')
        const signal = AbortSignal.timeout(30000)
        if (await abortable(this.d.vault.status(signal), signal) !== 'unlocked') return refuse('vault locked or unavailable; run u-chan unlock')
        try {
          const setup = await abortable(this.d.vault.getDiscordSetup(request.item, signal), signal)
          c = connectionSchema.parse({ alias: request.alias, item: setup.item, guildId: setup.guildId, field: setup.field })
        } catch (e) { return refuse(e instanceof UserFacingError ? e.message : 'Discord setup metadata is unavailable or ambiguous') }
      }
      const approved = await this.d.approver.ask('U-Chan Secrets - Discord connection', [
        'Allow server metadata reads? Writes always require a separate exact-batch approval.',
        `Connection: ${safeJson(c.alias)}`, `Bitwarden item: ${safeJson(c.item)}`,
        `Token field: ${safeJson(c.field)}`, `Server ID: ${c.guildId}`,
        'Duration: permanent metadata reads until revoked. No message access.',
        'The token stays inside the privileged service. No credential is fetched for this approval.',
      ])
      await this.audit('discord_allow', c, approved ? 'approved' : 'denied')
      if (!approved) return { ok: false, message: 'denied' }
      await this.d.store.upsert(c)
      return { ok: true, message: 'Discord connection approved; every write batch still requires approval' }
    })
  }
  discordListAllowed(): Promise<ToolResult> {
    return this.run(async () => ({ ok: true, message: safeJson({ connections: await this.d.store.list(), scope: 'server metadata; protected approval per write batch' }) }))
  }
  discordRevoke(alias: string): Promise<ToolResult> {
    return this.run(async () => {
      const c = await this.connection(alias)
      await this.audit('discord_revoke', c, 'intent')
      await this.d.store.remove(alias)
      await this.audit('discord_revoke', c, 'revoked')
      return { ok: true, message: 'Discord connection revoked; completed changes are not undone' }
    })
  }
  private async connection(alias: string): Promise<DiscordConnection> {
    if (!aliasSchema.safeParse(alias).success) return refuse('invalid Discord alias')
    const c = await this.d.store.get(alias)
    if (!c) return refuse('Discord connection is not approved; use discord_request_allow')
    return c
  }
  private async token(c: DiscordConnection, secrets: string[], signal: AbortSignal): Promise<string> {
    if (await abortable(this.d.vault.status(signal), signal) !== 'unlocked') return refuse('vault locked or unavailable; run u-chan unlock')
    const token = await abortable(this.d.vault.getToken(c.item, c.field, signal), signal)
    secrets.push(token)
    return token
  }
  private async snapshot(c: DiscordConnection, token: string, signal: AbortSignal, memberIds: string[] = []): Promise<Snapshot> {
    const get = (path: string) => this.d.http.request(token, 'GET', path, undefined, signal)
    const guild = z.object({ id: snowflake, name: z.string().max(100) }).parse(await get(`/guilds/${c.guildId}`))
    if (guild.id !== c.guildId) return refuse('Discord server does not match approval')
    const roles = z.array(roleSchema).max(1000).parse(await get(`/guilds/${c.guildId}/roles`))
    const channels = z.array(channelSchema).max(1000).parse(await get(`/guilds/${c.guildId}/channels`))
    if (new Set(roles.map(r => r.id)).size !== roles.length || new Set(channels.map(r => r.id)).size !== channels.length || channels.some(ch => ch.guild_id !== undefined && ch.guild_id !== c.guildId)) return refuse('Discord metadata does not match approved server')
    const user = z.object({ id: snowflake }).parse(await get('/users/@me'))
    const bot = memberSchema.parse(await get(`/guilds/${c.guildId}/members/${user.id}`))
    if (bot.user.id !== user.id || bot.roles.some(id => !roles.some(r => r.id === id))) return refuse('Discord bot membership is invalid')
    const members = new Map<string, Member>([[bot.user.id, bot]])
    for (const id of new Set(memberIds)) {
      if (!snowflake.safeParse(id).success) return refuse('invalid member ID')
      const member = memberSchema.parse(await get(`/guilds/${c.guildId}/members/${id}`))
      if (member.user.id !== id) return refuse('member is outside approved server')
      members.set(id, member)
    }
    return { guild, roles, channels, bot, members }
  }
  discordInspect(alias: string, memberId?: string, page = 0): Promise<ToolResult> {
    return this.run(async secrets => {
      if (!Number.isInteger(page) || page < 0 || page > 999 || (memberId !== undefined && !snowflake.safeParse(memberId).success)) return refuse('invalid metadata page or member ID')
      const c = await this.connection(alias), signal = AbortSignal.timeout(30000), token = await this.token(c, secrets, signal)
      const s = await this.snapshot(c, token, signal, memberId ? [memberId] : [])
      await this.audit('discord_read', c, `ok; metadata page ${page}`)
      const channels = s.channels.slice(page, page + 1), roles = s.roles.slice(page, page + 1)
      return { ok: true, message: safeJson({ guild: s.guild, channels, roles, member: memberId ? s.members.get(memberId) : undefined, page, nextPage: page + 1 < Math.max(s.channels.length, s.roles.length) ? page + 1 : null, totals: { channels: s.channels.length, roles: s.roles.length } }) }
    })
  }
  private membersFor(operations: DiscordOperation[]): string[] {
    return operations.flatMap(op => {
      if ('memberId' in op) return [op.memberId]
      const fields = 'changes' in op ? op.changes : op
      return 'overwrites' in fields ? (fields.overwrites ?? []).filter(o => o.type === 1).map(o => o.id) : []
    })
  }
  private validate(s: Snapshot, operations: DiscordOperation[]): void {
    const botRoles = s.roles.filter(r => r.id === s.guild.id || s.bot.roles.includes(r.id))
    const highest = Math.max(0, ...botRoles.map(r => r.position))
    const botPermissions = botRoles.reduce((bits, r) => bits | BigInt(r.permissions), 0n)
    const can = (bit: bigint) => (botPermissions & 8n) !== 0n || (botPermissions & bit) !== 0n
    const role = (id: string): Role => s.roles.find(r => r.id === id) ?? refuse('role is outside approved server')
    const channel = (id: string): Channel => s.channels.find(c => c.id === id) ?? refuse('channel is outside approved server')
    const editable = (id: string) => {
      const r = role(id)
      if (r.managed || s.bot.roles.includes(id) || (id !== s.guild.id && r.position >= highest)) return refuse('role is managed or controls bot authority')
      return r
    }
    for (const op of operations) {
      if (op.type.startsWith('role_') || 'memberId' in op) { if (!can(1n << 28n)) return refuse('bot requires MANAGE_ROLES') }
      else if (!can(16n)) return refuse('bot requires MANAGE_CHANNELS')
      if ('memberId' in op) {
        const r = editable(op.roleId), m = s.members.get(op.memberId)
        if (!m || op.memberId === s.bot.user.id || op.roleId === s.guild.id) return refuse('invalid member-role target')
        if (m.roles.some(id => role(id).position >= highest)) return refuse('member is above bot role hierarchy')
        if (op.type === 'member_role_add' && (BigInt(r.permissions) & 8n) !== 0n) return refuse('administrator role assignment is not supported')
        if (op.type === 'member_role_add' && (BigInt(r.permissions) & ~SUPPORTED_PERMISSION_MASK) !== 0n) return refuse('role contains unsupported permission bits; assignment is refused')
      }
      if (op.type === 'role_edit') {
        editable(op.roleId)
        if (op.roleId === s.guild.id && (op.changes.name !== undefined || op.changes.hoist !== undefined || op.changes.mentionable !== undefined || op.changes.color !== undefined)) return refuse('only explicit permissions changes are supported for @everyone')
      }
      if (op.type === 'role_reorder') for (const p of op.positions) {
        editable(p.id)
        if (p.id === s.guild.id || p.position >= highest) return refuse('role order would cross bot authority')
      }
      if (op.type === 'channel_reorder') for (const p of op.positions) channel(p.id)
      if (op.type === 'channel_create' || op.type === 'channel_edit') {
        const current = op.type === 'channel_edit' ? channel(op.channelId) : undefined
        const fields = op.type === 'channel_edit' ? op.changes : op
        const kind = current?.type ?? (op.type === 'channel_create' ? { text: 0, voice: 2, category: 4 }[op.kind] : -1)
        if (![0, 2, 4].includes(kind)) return refuse('unsupported channel kind')
        if (fields.topic !== undefined && kind !== 0) return refuse('topic is supported only for text channels')
        if (fields.parentId && (kind === 4 || channel(fields.parentId).type !== 4)) return refuse('parent must be an approved-server category')
        if (fields.overwrites) {
          if (!can(1n << 28n)) return refuse('permission overwrites require MANAGE_ROLES')
          for (const o of fields.overwrites) {
            if (o.type === 0) role(o.id)
            else if (!s.members.has(o.id)) return refuse('overwrite member is outside approved server')
            if (s.bot.roles.includes(o.id) || o.id === s.bot.user.id) return refuse('cannot change bot authority overwrites')
          }
          // Replacement would silently remove an existing bot overwrite, too.
          if (current?.permission_overwrites?.some(o => s.bot.roles.includes(o.id) || o.id === s.bot.user.id)) return refuse('channel has bot authority overwrites; edit manually')
        }
      }
    }
  }
  private review(c: DiscordConnection, s: Snapshot, operations: DiscordOperation[]): string[] {
    const before = operations.map(op => {
      if ('memberId' in op) return { role: s.roles.find(r => r.id === op.roleId), member: s.members.get(op.memberId) }
      if ('roleId' in op) return s.roles.find(r => r.id === op.roleId)
      if ('channelId' in op) return s.channels.find(ch => ch.id === op.channelId)
      if ('positions' in op) return op.positions.map(p => op.type === 'role_reorder' ? s.roles.find(r => r.id === p.id) : s.channels.find(ch => ch.id === p.id))
      return undefined
    })
    const named = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(named)
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ['permissions', 'allow', 'deny'].includes(k) && typeof v === 'string' ? permissionsView(v) : named(v)]))
    }
    const lines = ['Approve this exact Discord write batch once?', `Connection: ${c.alias}; server: ${safeJson(s.guild.name)}; server ID: ${c.guildId}`,
      'No deletion. No administrator grants. Completed changes are not rolled back.',
      `Current targets: ${safeJson(named(before))}`, `Exact operations: ${safeJson(named(operations))}`,
      'An overwrite list REPLACES existing overwrites. It may expose private channels.',
      'The server ID also identifies @everyone. Any target or overwrite with that ID affects EVERYONE.',
    ]
    if (Buffer.byteLength(JSON.stringify(lines)) > 12000) return refuse('batch is too large for complete protected review; split into smaller batches')
    return lines
  }
  private dispatch(c: DiscordConnection, op: DiscordOperation): { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; body?: unknown } {
    const fields = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, val]) => [k === 'parentId' ? 'parent_id' : k === 'overwrites' ? 'permission_overwrites' : k, val]))
    switch (op.type) {
      case 'role_create': { const { type, ...body } = op; return { method: 'POST', path: `/guilds/${c.guildId}/roles`, body: { ...body, permissions: body.permissions ?? '0' } } }
      case 'role_edit': return { method: 'PATCH', path: `/guilds/${c.guildId}/roles/${op.roleId}`, body: op.changes }
      case 'role_reorder': return { method: 'PATCH', path: `/guilds/${c.guildId}/roles`, body: op.positions }
      case 'channel_create': { const { type, kind, ...body } = op; return { method: 'POST', path: `/guilds/${c.guildId}/channels`, body: { ...fields(body), type: { text: 0, voice: 2, category: 4 }[kind] } } }
      case 'channel_edit': return { method: 'PATCH', path: `/channels/${op.channelId}`, body: fields(op.changes) }
      case 'channel_reorder': return { method: 'PATCH', path: `/guilds/${c.guildId}/channels`, body: op.positions }
      case 'member_role_add': case 'member_role_remove': return { method: op.type === 'member_role_add' ? 'PUT' : 'DELETE', path: `/guilds/${c.guildId}/members/${op.memberId}/roles/${op.roleId}` }
    }
  }
  discordApply(alias: string, input: unknown): Promise<ToolResult> {
    // Parse synchronously: callers cannot mutate a queued or approved proposal by reference.
    const parsed = batchSchema.safeParse(input)
    if (!parsed.success) return Promise.resolve({ ok: false, message: 'invalid Discord batch; use independent targets, at most 10 typed operations and 8 KiB JSON' })
    const operations = parsed.data
    return this.run(async secrets => {
      const c = await this.connection(alias), preflight = AbortSignal.timeout(30000), token = await this.token(c, secrets, preflight)
      const snapshot = await this.snapshot(c, token, preflight, this.membersFor(operations))
      this.validate(snapshot, operations)
      const lines = this.review(c, snapshot, operations)
      if (!await this.d.approver.ask('U-Chan Secrets - Discord write batch', lines)) {
        await this.audit('discord_write', c, 'denied')
        return { ok: false, message: 'denied' }
      }
      const signal = AbortSignal.timeout(60000)
      const completed: unknown[] = []
      let stopped = 0
      try {
      for (const [index, op] of operations.entries()) {
        stopped = index
        // Lock and policy may change during the protected prompt. Do not reuse the old credential blindly.
        const current = await this.connection(alias)
        if (safeJson(current) !== safeJson(c)) return refuse('connection changed; request a new batch approval')
        if (await this.d.vault.status(signal) !== 'unlocked') return refuse('vault locked; remaining operations were not sent')
        const live = await this.snapshot(c, token, signal, this.membersFor([op]))
        this.validate(live, [op])
        if (safeJson(this.review(c, live, [op])) !== safeJson(this.review(c, snapshot, [op]))) return { ok: false, message: safeJson({ completed, stopped: index, outcome: 'not_sent', reason: 'server state changed after approval; inspect and propose again' }) }
        const request = this.dispatch(c, op)
        const auditTarget = `operation ${index}; ${op.type}; route ${request.path}`
        await this.audit('discord_write', c, `intent; ${auditTarget}`)
        let raw: unknown
        try { raw = await this.d.http.request(token, request.method, request.path, request.body, signal) }
        catch (e) {
          const outcome = e instanceof DiscordHttpError ? e.outcome : 'unknown'
          await this.audit('discord_write', c, `${outcome}; ${auditTarget}`).catch(() => {})
          return { ok: false, message: safeJson({ completed, stopped: index, outcome, reason: e instanceof DiscordHttpError ? e.message : 'inspect before retrying', retryAfter: e instanceof DiscordHttpError ? e.retryAfter : undefined }) }
        }
        const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : undefined
        if ((op.type === 'role_create' || op.type === 'channel_create') && !snowflake.safeParse(id).success) {
          await this.audit('discord_write', c, `unknown; ${auditTarget}; invalid create result`).catch(() => {})
          return { ok: false, message: safeJson({ completed, stopped: index, outcome: 'unknown', reason: 'write may have succeeded but no valid ID was returned; inspect before retrying' }) }
        }
        completed.push({ index, type: op.type, ...(snowflake.safeParse(id).success ? { id } : {}), outcome: 'completed' })
        try { await this.audit('discord_write', c, `completed; ${auditTarget}${typeof id === 'string' && snowflake.safeParse(id).success ? '; target ' + id : ''}`) }
        catch { return { ok: false, message: safeJson({ completed, stopped: index, outcome: 'executed_audit_failed', reason: 'write executed; audit failed; inspect before retrying' }) } }
      }
      } catch (e) { return { ok: false, message: safeJson({ completed, stopped, outcome: 'not_sent', reason: e instanceof Refused ? e.message : 'validation, credential, or audit check failed; remaining operations were not sent' }) } }
      return { ok: true, message: safeJson({ completed }) }
    })
  }
}
