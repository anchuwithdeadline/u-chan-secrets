import { z } from 'zod'
import type { ToolResult } from '../core/types.js'

export const snowflake = z.string().refine(v => /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n)
const text = (max: number) => z.string().min(1).max(max).refine(v => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v))
export const aliasSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)
export const tokenFieldSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('password') }), z.strictObject({ kind: z.literal('hidden'), name: text(100) })])
export const connectionSchema = z.strictObject({ alias: aliasSchema, item: text(200).refine(v => !v.startsWith('-') && v.trim() === v), field: tokenFieldSchema, guildId: snowflake })
/** Discovery requests omit both unknown fields; persisted connections always require exact resolved values. */
export const connectionRequestSchema = z.union([connectionSchema, connectionSchema.omit({ field: true, guildId: true })])
export type TokenField = z.infer<typeof tokenFieldSchema>
export type DiscordConnection = z.infer<typeof connectionSchema>

// Deliberately supported permission subset. Unknown/new Discord bits require a reviewed upgrade.
export const PERMISSIONS = ['CREATE_INSTANT_INVITE', 'KICK_MEMBERS', 'BAN_MEMBERS', 'ADMINISTRATOR', 'MANAGE_CHANNELS', 'MANAGE_GUILD', 'ADD_REACTIONS', 'VIEW_AUDIT_LOG', 'PRIORITY_SPEAKER', 'STREAM', 'VIEW_CHANNEL', 'SEND_MESSAGES', 'SEND_TTS_MESSAGES', 'MANAGE_MESSAGES', 'EMBED_LINKS', 'ATTACH_FILES', 'READ_MESSAGE_HISTORY', 'MENTION_EVERYONE', 'USE_EXTERNAL_EMOJIS', 'VIEW_GUILD_INSIGHTS', 'CONNECT', 'SPEAK', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS', 'USE_VAD', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES', 'MANAGE_ROLES', 'MANAGE_WEBHOOKS', 'MANAGE_GUILD_EXPRESSIONS', 'USE_APPLICATION_COMMANDS', 'REQUEST_TO_SPEAK', 'MANAGE_EVENTS', 'MANAGE_THREADS', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS', 'USE_EXTERNAL_STICKERS', 'SEND_MESSAGES_IN_THREADS', 'USE_EMBEDDED_ACTIVITIES', 'MODERATE_MEMBERS'] as const
export const SUPPORTED_PERMISSION_MASK = (1n << BigInt(PERMISSIONS.length)) - 1n
export function permissionNames(bits: string): string[] {
  const known: string[] = PERMISSIONS.filter((_, i) => (BigInt(bits) & (1n << BigInt(i))) !== 0n)
  const unknown = BigInt(bits) & ~SUPPORTED_PERMISSION_MASK
  return unknown ? [...known, `UNSUPPORTED_BITS(${unknown})`] : known
}
const validPermissions = (v: string) => /^(0|[1-9][0-9]{0,12})$/.test(v) && BigInt(v) < (1n << BigInt(PERMISSIONS.length)) && (BigInt(v) & 8n) === 0n
const permissions = z.string().refine(validPermissions)
const roleFields = { name: text(100), permissions, color: z.number().int().min(0).max(0xffffff), hoist: z.boolean(), mentionable: z.boolean() }
const overwrite = z.strictObject({ id: snowflake, type: z.union([z.literal(0), z.literal(1)]), allow: permissions, deny: permissions }).refine(o => validPermissions(o.allow) && validPermissions(o.deny) && (BigInt(o.allow) & BigInt(o.deny)) === 0n)
const channelFields = { name: text(100), parentId: snowflake.nullable(), topic: text(1024).or(z.literal('')), overwrites: z.array(overwrite).max(20).refine(v => new Set(v.map(o => o.id)).size === v.length) }
const position = z.strictObject({ id: snowflake, position: z.number().int().min(0).max(500) })
const positions = z.array(position).min(1).max(30).refine(v => new Set(v.map(p => p.id)).size === v.length)
export const operationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('role_create'), ...roleFields, permissions: permissions.optional(), color: roleFields.color.optional(), hoist: z.boolean().optional(), mentionable: z.boolean().optional() }),
  z.strictObject({ type: z.literal('role_edit'), roleId: snowflake, changes: z.strictObject(roleFields).partial().refine(v => Object.keys(v).length > 0) }),
  z.strictObject({ type: z.literal('role_reorder'), positions }),
  z.strictObject({ type: z.literal('channel_create'), kind: z.enum(['category', 'text', 'voice']), ...channelFields, parentId: snowflake.nullable().optional(), topic: channelFields.topic.optional(), overwrites: channelFields.overwrites.optional() }),
  z.strictObject({ type: z.literal('channel_edit'), channelId: snowflake, changes: z.strictObject(channelFields).partial().refine(v => Object.keys(v).length > 0) }),
  z.strictObject({ type: z.literal('channel_reorder'), positions }),
  z.strictObject({ type: z.enum(['member_role_add', 'member_role_remove']), memberId: snowflake, roleId: snowflake }),
])
export type DiscordOperation = z.infer<typeof operationSchema>
function independentTargets(operations: DiscordOperation[]): boolean {
  const targets = operations.map(op => {
    if ('memberId' in op) return { writes: ['member:' + op.memberId], reads: ['role:' + op.roleId] }
    if ('roleId' in op) return { writes: ['role:' + op.roleId], reads: [] }
    if ('channelId' in op) return { writes: ['channel:' + op.channelId], reads: [] }
    if ('positions' in op) return { writes: op.positions.map(p => (op.type === 'role_reorder' ? 'role:' : 'channel:') + p.id), reads: [] }
    return { writes: [], reads: [] }
  })
  return targets.every((a, i) => targets.every((b, j) => i === j || !a.writes.some(id => b.writes.includes(id) || b.reads.includes(id))))
}
export const batchSchema = z.array(operationSchema).min(1).max(10).refine(v => Buffer.byteLength(JSON.stringify(v)) <= 8192 && independentTargets(v))
export interface DiscordApi {
  discordRequestAllow(proposal: unknown): Promise<ToolResult>
  discordListAllowed(): Promise<ToolResult>
  discordInspect(alias: string, memberId?: string, page?: number): Promise<ToolResult>
  discordApply(alias: string, operations: unknown): Promise<ToolResult>
  discordRevoke(alias: string): Promise<ToolResult>
}
