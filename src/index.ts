#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './core/config.js'
import { AllowlistStore } from './core/allowlist.js'
import { BitwardenVault } from './core/vault.js'
import { WindowsDialogApprover } from './core/approver.js'
import { FileAuditLog } from './core/audit.js'
import { fileURLToPath } from 'node:url'
import { CdpBrowserProvider, startChromeScript } from './core/browser.js'
import { chromium } from 'playwright'
import { join } from 'node:path'
import { CdpSessionTarget } from './core/browser.js'
import { IsolatedLogin } from './service/isolated-login.js'
import { SettingsStore } from './service/settings.js'
import { CoreService } from './core/service.js'
import { createMcpServer } from './mcp/server.js'

// stdout is the MCP channel: log only to stderr.
const cfg = loadConfig()
// Temporary wiring until Task 6 rewrites this file.
const cdp = new CdpBrowserProvider(cfg.cdpEndpoint, {
  launch: startChromeScript(fileURLToPath(new URL('../scripts/start-chrome.ps1', import.meta.url))),
})
const settings = new SettingsStore(join(cfg.home, 'settings.json'))
const core = new CoreService({
  vault: new BitwardenVault({ dataDir: cfg.bwDataDir, idleLockMs: 43200000 }),
  allowlist: new AllowlistStore(cfg.allowlistPath),
  approver: new WindowsDialogApprover(),
  audit: new FileAuditLog(cfg.auditPath),
  login: new IsolatedLogin({ launch: () => chromium.launch(), target: new CdpSessionTarget(cdp) }),
  mode: async () => (await settings.get()).mode,
})

let version = '0.1.0'
try {
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
} catch {}

await createMcpServer(core, version).connect(new StdioServerTransport())
