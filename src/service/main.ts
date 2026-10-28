#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import type net from 'node:net'
import { dirname, join } from 'node:path'
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
import { diagnoseService } from './doctor.js'
import { GrantCoordinator } from './grants.js'
import { ensureV3State } from './state.js'
import { ManagementService } from './manage.js'
import { privateBrowserPath } from '../platform/runtime-assets.js'

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
  const cfg = serviceConfig(env, platform)
  const defaultBw = join(cfg.home, 'bin', platform === 'win32' ? 'bw.exe' : 'bw')
  if (!env.U_CHAN_BW && existsSync(defaultBw)) {
    env.U_CHAN_BW = defaultBw
  }
  let adapters: PlatformAdapters
  try {
    adapters = platformAdapters(platform, { home: cfg.home, settingsPath: cfg.settingsPath })
  } catch (e) {
    console.error(e instanceof UserFacingError ? e.message : 'U-Chan service failed to start')
    process.exit(1)
  }

  try {
    prepareSocketEndpoint(cfg.endpoint, platform)
    const settings = new SettingsStore(cfg.settingsPath)
    const vault = new BitwardenVault({ dataDir: cfg.bwDataDir, idleLockMs: (await settings.get()).idleLockMs })
    const limiter = new AttemptLimiter()
    // One approver and one limiter: lockouts count across approvals, unlock and mode changes.
    const approver = new PolicyApprover({ prompt: adapters.prompt, checker: vault, settings, limiter, platform })
    let stateReady: Promise<void> | undefined
    const allowlist = new AllowlistStore(cfg.allowlistPath, () => stateReady ??= ensureV3State(cfg.home).catch(e => { stateReady = undefined; throw e }))
    const grants = new GrantCoordinator(allowlist)
    const audit = new FileAuditLog(cfg.auditPath)
    const login = new IsolatedLogin({
      launch: async () => chromium.launch({ headless: true, executablePath: await privateBrowserPath(cfg.home), timeout: 15000 }),
      target: new CdpSessionTarget(new CdpBrowserProvider(loadConfig(env, platform).cdpEndpoint)),
    })
    const core = new CoreService({ vault, allowlist, grants, approver, audit, login, mode: () => approver.effectiveMode() })

    let currentVersion = '3.0.0'
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

    const diagnose = () => diagnoseService(cfg.home, vault, platform)
    const control: ControlService = new ControlService({ vault, approver, limiter, settings, allowlist, grants, audit, platform, updater, diagnose, manage: () => manager.open() })
    const manager = new ManagementService({
      store: allowlist, grants, vault, audit, diagnose, phrase: async () => (await settings.get()).phrase,
      show: req => adapters.prompt.manage ? adapters.prompt.manage(req) : Promise.reject(new Error('unsupported')),
      lock: () => control.lock(), unlock: () => control.unlock(), revoke: domain => core.revoke(domain),
    })
    const api: CoreApi & ControlApi = {
      capabilities: () => control.capabilities(),
      diagnose: () => control.diagnose(),
      manage: () => control.manage(),
      login: (domain) => core.login(domain),
      requestAllow: (domain, loginUrl, item, selectors, options) => core.requestAllow(domain, loginUrl, item, selectors, options),
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
