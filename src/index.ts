#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { IpcClient } from './ipc/client.js'
import { defaultEndpoint } from './ipc/endpoint.js'
import { checkPlaywrightNow } from './core/doctor.js'
import { loadConfig, resolveLoginBrowser } from './core/config.js'
import { createMcpServer, withPlaywrightStatus } from './mcp/server.js'

// Thin MCP client: every privileged action goes to the U-Chan service over IPC.
// stdout is the MCP channel: log only to stderr.
let version = '0.0.0'
try {
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
} catch {}

const client = new IpcClient(defaultEndpoint(process.env, process.platform), { browser: () => resolveLoginBrowser(process.env, process.platform) })
await createMcpServer(withPlaywrightStatus(client, () => checkPlaywrightNow(process.pid, loadConfig(process.env, process.platform).cdpEndpoint)), version).connect(new StdioServerTransport())
