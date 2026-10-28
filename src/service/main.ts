#!/usr/bin/env node
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import type net from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { AllowlistStore } from '../core/allowlist.js'
import { FileAuditLog } from '../core/audit.js'
import { CdpBrowserProvider, CdpSessionTarget } from '../core/browser.js'
import { loadConfig, serviceConfig } from '../core/config.js'
import { CoreService } from '../core/service.js'
import { UserFacingError, type ControlApi, type CoreApi, type ServiceRestarter } from '../core/types.js'
import { BitwardenVault } from '../core/vault.js'
import { startIpcServer } from '../ipc/server.js'
import { platformAdapters, type PlatformAdapters } from '../platform/index.js'
import { AttemptLimiter } from './attempts.js'
import { ControlService } from './control.js'
import { IsolatedLogin } from './isolated-login.js'
import { PolicyApprover } from './policy-approver.js'
import { SettingsStore } from './settings.js'
import { NpmPackageVerifier } from './update/verifier.js'
import { ServiceUpdater } from './update/updater.js'

export function prepareSocketEndpoint(endpoint: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') {
    const dir = dirname(endpoint)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    try {
      unlinkSync(endpoint)
    } catch {}
  }
}

export async function runService(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<net.Server> {
  let adapters: PlatformAdapters
  try {
    adapters = platformAdapters(platform)
  } catch (e) {
    console.error(e instanceof UserFacingError ? e.message : 'U-Chan service failed to start')
    process.exit(1)
  }

  try {
    const cfg = serviceConfig(env, platform)
    prepareSocketEndpoint(cfg.endpoint, platform)
    const settings = new SettingsStore(cfg.settingsPath)
    const vault = new BitwardenVault({ dataDir: cfg.bwDataDir, idleLockMs: (await settings.get()).idleLockMs })
    const limiter = new AttemptLimiter()
    // One approver and one limiter: lockouts count across approvals, unlock and mode changes.
    const approver = new PolicyApprover({ prompt: adapters.prompt, checker: vault, settings, limiter, platform })
    const allowlist = new AllowlistStore(cfg.allowlistPath)
    const audit = new FileAuditLog(cfg.auditPath)
    const login = new IsolatedLogin({
      launch: () => chromium.launch({ headless: true }),
      target: new CdpSessionTarget(new CdpBrowserProvider(loadConfig(env, platform).cdpEndpoint)),
    })
    const core = new CoreService({ vault, allowlist, approver, audit, login, mode: () => approver.effectiveMode() })

    let currentVersion = '2.0.0-dev.0'
    try {
      currentVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
    } catch {}

    const verifier = new NpmPackageVerifier()
    const restarter: ServiceRestarter = {
      restart: async () => {
        process.exit(0)
      },
    }
    const updater = new ServiceUpdater({
      verifier,
      restarter,
      programDir: cfg.programDir,
      stagingDir: cfg.stagingDir,
      currentVersion,
    })

    const control = new ControlService({ vault, approver, limiter, settings, allowlist, audit, platform, updater })
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
      audit: (limit) => control.audit(limit),
      update: () => control.update(),
    }
    const server = await startIpcServer(cfg.endpoint, api, { authorize: adapters.authorize })
    console.error(`U-Chan service listening on ${cfg.endpoint}`)
    return server
  } catch (e) {
    console.error(e instanceof UserFacingError ? e.message : `U-Chan service failed to start: ${(e as Error)?.message ?? e}`)
    process.exit(1)
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('main.js') ||
  process.argv[1].endsWith('main.ts')
)

if (isMain) {
  runService().catch((e) => {
    console.error(`U-Chan service failed: ${(e as Error)?.message ?? e}`)
    process.exit(1)
  })
}
