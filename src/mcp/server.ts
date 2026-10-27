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

const INSTRUCTIONS = [
  'U-Chan Secrets logs into websites for you without exposing passwords.',
  'Use it whenever a site needs sign-in (admin pages, dashboards, a Playwright page showing a login form).',
  'Never ask the user for a password, and never type one into a form yourself.',
  'Flow: list_allowed -> login(domain) -> continue with the Playwright MCP tools in the same Chrome.',
  'If the domain is not allowlisted, ask the user which Bitwarden item to use, then call request_allow; the user approves it in a Windows dialog.',
  'If login fails, call status: a locked vault means the user must run scripts/unlock.ps1 themselves.',
].join('\n')

export function createMcpServer(core: CoreApi, version = '0.1.0'): McpServer {
  const server = new McpServer({ name: 'u-chan-secrets', version }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'login',
    {
      description:
        'Use this whenever a website needs sign-in: an admin page, a dashboard, or a Playwright page that shows a login form. ' +
        'Logs into an allowlisted domain in the shared Chrome using Bitwarden credentials, without revealing them. ' +
        'Launches Chrome if it is not running. ' +
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
    { description: 'List allowlisted domains with their Bitwarden item and hosts. Call it to check whether a site can be logged into before login or request_allow.' },
    () => run(() => core.listAllowed()),
  )

  server.registerTool(
    'status',
    { description: 'Report Bitwarden vault lock state and Chrome connection state. Call it first when login fails.' },
    () => run(() => core.status()),
  )

  return server
}
