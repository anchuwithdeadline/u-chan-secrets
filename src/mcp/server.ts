import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { CoreApi, ToolResult } from '../core/types.js'

async function run(fn: () => Promise<ToolResult>) {
  let r: ToolResult
  try {
    r = await fn()
  } catch {
    r = { ok: false, message: 'internal error' }
  }
  return { content: [{ type: 'text' as const, text: r.message }], isError: !r.ok }
}

export function createMcpServer(core: CoreApi, version = '0.1.0'): McpServer {
  const server = new McpServer({ name: 'u-chan-secrets', version })

  server.registerTool(
    'login',
    {
      description:
        'Log into an allowlisted website in the shared Chrome using Bitwarden credentials, without revealing them. ' +
        'After the result is ok, continue browsing with the Playwright MCP tools in the same browser.',
      inputSchema: { domain: z.string() },
    },
    ({ domain }) => run(() => core.login(domain)),
  )

  server.registerTool(
    'request_allow',
    {
      description:
        'Ask to allowlist a site for login. Shows a Windows dialog that the user must approve. ' +
        '`item` is the Bitwarden item name or id the user told you; never guess it. Prefer the item id (a name is a search and may match another item).',
      inputSchema: { domain: z.string(), login_url: z.string(), item: z.string() },
    },
    ({ domain, login_url, item }) => run(() => core.requestAllow(domain, login_url, item)),
  )

  server.registerTool(
    'revoke',
    { description: 'Remove a domain from the login allowlist.', inputSchema: { domain: z.string() } },
    ({ domain }) => run(() => core.revoke(domain)),
  )

  server.registerTool(
    'list_allowed',
    { description: 'List allowlisted domains with their Bitwarden item and hosts.' },
    () => run(() => core.listAllowed()),
  )

  server.registerTool(
    'status',
    { description: 'Report Bitwarden vault lock state and Chrome connection state.' },
    () => run(() => core.status()),
  )

  return server
}
