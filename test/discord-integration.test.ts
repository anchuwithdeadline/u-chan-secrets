import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp/server.js'
import { IpcClient } from '../src/ipc/client.js'
import { startIpcServer } from '../src/ipc/server.js'
import { runDiscordCli } from '../src/client/discord.js'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DiscordApi } from '../src/discord/policy.js'
const result = { ok: true, message: 'safe result' }
const core = { login: async () => result, requestAllow: async () => result, revoke: async () => result, listAllowed: async () => result, status: async () => result }
const discord: DiscordApi = { discordRequestAllow: async () => result, discordInspect: async () => result, discordApply: async () => result, discordListAllowed: async () => result, discordRevoke: async () => result }
describe('Discord agent surface', () => {
  it('adds scoped MCP tools and preserves existing website tools', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const server = createMcpServer(core, 'test', discord)
    await server.connect(st)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(ct)
    expect((await client.listTools()).tools).toHaveLength(11)
    const tested = await client.callTool({ name: 'discord_test_connection', arguments: { alias: 'vdn' } })
    expect(tested.isError).toBe(true) // The stub inspect response is intentionally not connection-test data.
    expect(tested.content).toEqual([{ type: 'text', text: 'Discord connection test received an invalid service response' }])
    expect((await client.callTool({ name: 'discord_apply', arguments: { alias: 'vdn', operations: [{ type: 'delete' }] } })).isError).toBe(true)
    expect((await client.callTool({ name: 'discord_list_allowed', arguments: {} })).isError).toBe(false)
    expect((await client.callTool({ name: 'discord_request_allow', arguments: { proposal: { alias: 'vdn', item: 'VDN Discord Bot' } } })).isError).toBe(false)
    await client.close()
    await server.close()
  })
  it('checks service capability before forwarding Discord methods over IPC', async () => {
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\ucs-discord-${randomUUID()}` : join(tmpdir(), `ud-${randomUUID().slice(0, 8)}.sock`)
    let enabled = false, discovery = false, forwarded = 0
    const api = { ...core, ...discord, capabilities: async () => ({ ok: true, message: JSON.stringify({ protocol: 3, features: enabled ? ['discord_broker', ...(discovery ? ['discord_discovery'] : [])] : [] }) }), discordListAllowed: async () => { forwarded++; return result } }
    const server = await startIpcServer(path, api as never)
    try {
      const client = new IpcClient(path)
      expect((await client.discordListAllowed()).ok).toBe(false)
      expect(forwarded).toBe(0)
      enabled = true
      expect(await client.discordListAllowed()).toEqual(result)
      expect(forwarded).toBe(1)
      expect((await client.discordRequestAllow({ alias: 'vdn', item: 'VDN Discord Bot' })).ok).toBe(false)
      discovery = true
      expect(await client.discordRequestAllow({ alias: 'vdn', item: 'VDN Discord Bot' })).toEqual(result)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('CLI validates JSON shape, size, and extra arguments without returning file contents', async () => {
    const read = async () => JSON.stringify([{ type: 'role_create', name: 'Debater' }])
    expect(await runDiscordCli(['apply', 'vdn', 'ops.json'], discord, read)).toEqual(result)
    expect((await runDiscordCli(['apply', 'vdn', 'ops.json', 'extra'], discord, read)).ok).toBe(false)
    expect((await runDiscordCli(['allow', 'policy.json'], discord, async () => 'SECRET')).message).not.toContain('SECRET')
    expect((await runDiscordCli(['apply', 'vdn', 'ops.json'], discord, async () => 'x'.repeat(100000))).ok).toBe(false)
    expect(await runDiscordCli(['allow', 'policy.json'], discord, async () => JSON.stringify({ alias: 'vdn', item: 'VDN Discord Bot' }))).toEqual(result)
  })
})
