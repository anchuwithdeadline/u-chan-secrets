import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { CoreApi, ToolResult } from '../core/types.js'
import type { PlaywrightCheck } from '../core/doctor.js'

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
  'If the domain is not allowlisted, ask the user which Bitwarden item to use, then call request_allow; the user approves it in a U-Chan window.',
  'If login fails, call status: a locked vault means the user must run u-chan unlock themselves. If login says "needs you", ask the user to sign in by hand.',
].join('\n')

const PLAYWRIGHT_MSG: Record<PlaywrightCheck, string> = {
  ok: 'shared chrome',
  missing: 'missing --cdp-endpoint (using its own Chrome; restart the AI session)',
  not_found: 'not found',
  unknown: 'unknown',
}

/** Adds the local Playwright MCP check to `status`; exposes only the AI-facing CoreApi. */
export function withPlaywrightStatus(core: CoreApi, check: () => Promise<PlaywrightCheck>): CoreApi {
  return {
    login: (domain) => core.login(domain),
    requestAllow: (domain, loginUrl, item, selectors) =>
      selectors ? core.requestAllow(domain, loginUrl, item, selectors) : core.requestAllow(domain, loginUrl, item),
    revoke: (domain) => core.revoke(domain),
    listAllowed: () => core.listAllowed(),
    status: async () => {
      const [r, pw] = await Promise.all([core.status(), check()])
      return { ok: r.ok && pw !== 'missing', message: `${r.message}; playwright: ${PLAYWRIGHT_MSG[pw]}` }
    },
  }
}

const SELECTOR = z.string().max(1000)
const SELECTORS = z
  .object({ username: SELECTOR, password: SELECTOR, submit: SELECTOR, otp: SELECTOR })
  .partial()
  .strict()

export function createMcpServer(core: CoreApi, version = '0.1.0'): McpServer {
  const server = new McpServer({ name: 'u-chan-secrets', version }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'login',
    {
      description:
        'Use this whenever a website needs sign-in: an admin page, a dashboard, or a Playwright page that shows a login form. ' +
        'Signs into an allowlisted domain with Bitwarden credentials inside the U-Chan service and hands only the session to the shared Chrome; the credentials are never revealed. ' +
        'After the result is ok, continue browsing with the Playwright MCP tools in the same browser.',
      inputSchema: { domain: z.string() },
    },
    ({ domain }) => run(() => core.login(domain)),
  )

  server.registerTool(
    'request_allow',
    {
      description:
        'Ask to allowlist a site for login. Shows a U-Chan window that the user must approve. ' +
        '`item` is the Bitwarden item name or id the user told you; never guess it. Prefer the item id (a name is a search and may match another item). ' +
        '`selectors` (optional) are CSS selectors for the username, password, submit and otp fields when the form is unusual.',
      inputSchema: { domain: z.string(), login_url: z.string(), item: z.string(), selectors: SELECTORS.optional() },
    },
    ({ domain, login_url, item, selectors }) =>
      run(() => (selectors ? core.requestAllow(domain, login_url, item, selectors) : core.requestAllow(domain, login_url, item))),
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
    { description: 'Report Bitwarden vault lock state, approval mode and whether Playwright MCP shares the Chrome. Call it first when login fails.' },
    () => run(() => core.status()),
  )

  return server
}
