import type { ToolResult } from '../core/types.js'
import { z } from 'zod'
import { aliasSchema, batchSchema, connectionRequestSchema, snowflake, type DiscordApi } from '../discord/policy.js'

const connectionResult = z.object({ guild: z.object({ id: snowflake }), totals: z.object({ channels: z.number().int().min(0).max(1000), roles: z.number().int().min(0).max(1000) }) })

/** Reuse approved metadata inspection; return only a bounded health summary, never raw metadata. */
export async function testDiscordConnection(client: Partial<DiscordApi>, alias: string): Promise<ToolResult> {
  if (!aliasSchema.safeParse(alias).success) return { ok: false, message: 'invalid Discord alias' }
  if (!client.discordInspect) return { ok: false, message: 'Discord broker unavailable; update the local client' }
  let result: ToolResult
  try { result = await client.discordInspect(alias) }
  catch { return { ok: false, message: 'Discord connection test unavailable; check service and vault status' } }
  if (!result.ok) return result
  try {
    const data = connectionResult.parse(JSON.parse(result.message))
    return { ok: true, message: JSON.stringify({ connection: alias, status: 'connected', readOnly: true, serverId: data.guild.id, channels: data.totals.channels, roles: data.totals.roles }) }
  } catch { return { ok: false, message: 'Discord connection test received an invalid service response' } }
}

export const DISCORD_USAGE = 'usage: u-chan discord allow <connection.json> | list | test <alias> | inspect <alias> [member-id] [--page <0..999>] | apply <alias> <operations.json> | revoke <alias>'
export async function runDiscordCli(args: string[], client: Partial<DiscordApi>, read: (path: string) => Promise<string>): Promise<ToolResult> {
  const [cmd, arg, third] = args
  const invalid = { ok: false, message: DISCORD_USAGE }
  try {
    if (cmd === 'test' && args.length === 2) return await testDiscordConnection(client, arg)
    if (cmd === 'list' && args.length === 1) return await client.discordListAllowed?.() ?? invalid
    if (cmd === 'revoke' && args.length === 2 && aliasSchema.safeParse(arg).success) return await client.discordRevoke?.(arg) ?? invalid
    if (cmd === 'inspect' && aliasSchema.safeParse(arg).success) {
      let member: string | undefined, page = 0
      const extra = args.slice(2)
      if (extra[0] && extra[0] !== '--page') { member = extra.shift(); if (!snowflake.safeParse(member).success) return invalid }
      if (extra.length) {
        if (extra.length !== 2 || extra[0] !== '--page' || !/^(0|[1-9][0-9]{0,2})$/.test(extra[1])) return invalid
        page = Number(extra[1])
      }
      return await client.discordInspect?.(arg, member, page) ?? invalid
    }
    if ((cmd === 'allow' && args.length === 2) || (cmd === 'apply' && args.length === 3 && aliasSchema.safeParse(arg).success)) {
      const raw = await read(cmd === 'allow' ? arg : third)
      if (Buffer.byteLength(raw) > 16384) return { ok: false, message: 'Discord input file is too large' }
      const data: unknown = JSON.parse(raw)
      if (cmd === 'allow') return connectionRequestSchema.safeParse(data).success ? await client.discordRequestAllow?.(data) ?? invalid : invalid
      return batchSchema.safeParse(data).success ? await client.discordApply?.(arg, data) ?? invalid : invalid
    }
    return invalid
  } catch { return { ok: false, message: 'Discord command failed; check input JSON and service availability' } }
}
