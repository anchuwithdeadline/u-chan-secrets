#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './core/config.js'
import { AllowlistStore } from './core/allowlist.js'
import { BitwardenVault } from './core/vault.js'
import { WindowsDialogApprover } from './core/approver.js'
import { FileAuditLog } from './core/audit.js'
import { CdpBrowserProvider } from './core/browser.js'
import { CoreService } from './core/service.js'
import { createMcpServer } from './mcp/server.js'

// stdout is the MCP channel: log only to stderr.
const cfg = loadConfig()
const core = new CoreService({
  vault: new BitwardenVault({ sessionPath: cfg.sessionPath }),
  allowlist: new AllowlistStore(cfg.allowlistPath),
  approver: new WindowsDialogApprover(),
  audit: new FileAuditLog(cfg.auditPath),
  browser: new CdpBrowserProvider(cfg.cdpEndpoint),
})

let version = '0.1.0'
try {
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
} catch {}

await createMcpServer(core, version).connect(new StdioServerTransport())
