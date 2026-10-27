#!/usr/bin/env node
import { chromium } from 'playwright'
import { AllowlistStore } from '../core/allowlist.js'
import { FileAuditLog } from '../core/audit.js'
import { CdpBrowserProvider, CdpSessionTarget } from '../core/browser.js'
import { loadConfig, serviceConfig } from '../core/config.js'
import { CoreService } from '../core/service.js'
import { UserFacingError, type ControlApi, type CoreApi } from '../core/types.js'
import { BitwardenVault } from '../core/vault.js'
import { startIpcServer } from '../ipc/server.js'
import { platformAdapters, type PlatformAdapters } from '../platform/index.js'
import { AttemptLimiter } from './attempts.js'
import { ControlService } from './control.js'
import { IsolatedLogin } from './isolated-login.js'
import { PolicyApprover } from './policy-approver.js'
import { SettingsStore } from './settings.js'

// The privileged U-Chan service. Logs only to stderr.
const platform = process.platform

let adapters: PlatformAdapters
try {
  adapters = platformAdapters(platform)
} catch (e) {
  console.error(e instanceof UserFacingError ? e.message : 'U-Chan service failed to start')
  process.exit(1)
}

try {
  const cfg = serviceConfig(process.env, platform)
  const settings = new SettingsStore(cfg.settingsPath)
  const vault = new BitwardenVault({ dataDir: cfg.bwDataDir, idleLockMs: (await settings.get()).idleLockMs })
  const limiter = new AttemptLimiter()
  // One approver and one limiter: lockouts count across approvals, unlock and mode changes.
  const approver = new PolicyApprover({ prompt: adapters.prompt, checker: vault, settings, limiter, platform })
  const allowlist = new AllowlistStore(cfg.allowlistPath)
  const audit = new FileAuditLog(cfg.auditPath)
  const login = new IsolatedLogin({
    launch: () => chromium.launch({ headless: true }),
    target: new CdpSessionTarget(new CdpBrowserProvider(loadConfig(process.env).cdpEndpoint)),
  })
  const core = new CoreService({ vault, allowlist, approver, audit, login, mode: () => approver.effectiveMode() })
  const control = new ControlService({ vault, approver, limiter, settings, allowlist, audit, platform })
  const api: CoreApi & ControlApi = {
    login: (domain) => core.login(domain),
    requestAllow: (domain, loginUrl, item, selectors) => core.requestAllow(domain, loginUrl, item, selectors),
    revoke: (domain) => core.revoke(domain),
    listAllowed: () => core.listAllowed(),
    status: () => core.status(),
    unlock: () => control.unlock(),
    lock: () => control.lock(),
    setMode: (mode) => control.setMode(mode),
    importV1: (entries) => control.importV1(entries),
  }
  await startIpcServer(cfg.endpoint, api, { authorize: adapters.authorize })
  console.error(`U-Chan service listening on ${cfg.endpoint}`)
} catch (e) {
  console.error(e instanceof UserFacingError ? e.message : `U-Chan service failed to start: ${(e as Error)?.message ?? e}`)
  process.exit(1)
}
