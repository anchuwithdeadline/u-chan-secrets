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
import { UserFacingError, type ControlApi, type CoreApi } from '../core/types.js'
import { BitwardenVault } from '../core/vault.js'
import { startIpcServer } from '../ipc/server.js'
import { platformAdapters, type PlatformAdapters } from '../platform/index.js'
import { AttemptLimiter } from './attempts.js'
import { ControlService } from './control.js'
import { IsolatedLogin } from './isolated-login.js'
import { PolicyApprover } from './policy-approver.js'
import { SettingsStore } from './settings.js'
import { NpmPackageVerifier } from './update/verifier.js'
import { UpdateCoordinator } from './update/coordinator.js'
import { UpdateGate } from './update/gate.js'
import { readBootIdentity } from './update/files.js'
import { productionJournal, secureUpdateDirectory, verifyUpdateActive, launchUpdateWorker } from './update/native.js'
import { boundedRegistryFetch } from './update/network.js'
import type { CoordinatedUpdateApi } from './update/protocol.js'
import { diagnoseService } from './doctor.js'
import { GrantCoordinator } from './grants.js'
import { ensureV3State } from './state.js'
import { ManagementService } from './manage.js'
import { privateBrowserPath } from '../platform/runtime-assets.js'
import { safeVersion } from '../core/doctor.js'
import { inspectServiceDesktopBrowser } from '../platform/windows/desktop-browser.js'
import type { BrowserKind } from '../client/browser-choice.js'
import { DiscordStore } from '../discord/store.js'
import { DiscordService } from '../discord/service.js'
import { DiscordHttp } from '../discord/http.js'
import type { DiscordApi } from '../discord/policy.js'
import { backupDiscordState } from './state.js'
import { GithubStore, backupGithubPolicy } from '../github/store.js'
import { GithubService } from '../github/service.js'
import { GithubHttp } from '../github/http.js'
import type { GithubApi } from '../github/policy.js'
import type { AgentUnlockApi } from '../core/types.js'

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
    let discordStateReady: Promise<void> | undefined
    const discordStore = new DiscordStore(cfg.discordAllowlistPath, () => discordStateReady ??= backupDiscordState(cfg.home).catch(e => { discordStateReady = undefined; throw e }))
    const discord = new DiscordService({ platform, store: discordStore, vault, approver, audit, http: new DiscordHttp(), queue: work => grants.run(work) })
    let githubStateReady:Promise<void>|undefined
    const githubStore=new GithubStore(join(cfg.home,'github-allowlist.json'),()=>githubStateReady??=ensureV3State(cfg.home).then(()=>backupGithubPolicy(cfg.home,secureUpdateDirectory)).catch(error=>{githubStateReady=undefined;throw error}))
    const github=new GithubService({platform,store:githubStore,vault,approver,audit,http:new GithubHttp(),queue:work=>grants.run(work)})
    const endpoint = loadConfig(env, platform).cdpEndpoint
    const validateTarget = platform === 'win32' ? async (browser: BrowserKind = 'chrome') => {
      const owner = (await settings.get() as unknown as { authorizedSid?: unknown }).authorizedSid
      return typeof owner === 'string' && await inspectServiceDesktopBrowser(endpoint, owner, env, browser) === 'pass'
    } : undefined
    const login = new IsolatedLogin({
      launch: async () => chromium.launch({ headless: true, executablePath: await privateBrowserPath(cfg.home), timeout: 15000, args: ['--disable-http2', '--disable-quic'] }),
      target: new CdpSessionTarget(new CdpBrowserProvider(endpoint, { validate: validateTarget })),
    })
    const core = new CoreService({ vault, allowlist, grants, approver, audit, login, mode: () => approver.effectiveMode() })

    let currentVersion = 'unknown'
    try {
      currentVersion = safeVersion(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version) ?? 'unknown'
    } catch {}

    const updateBoot=await readBootIdentity(cfg.programDir), updateGate=new UpdateGate()
    const coordinator=new UpdateCoordinator({home:cfg.home,boot:updateBoot,platform,verifier:new NpmPackageVerifier({fetcher:boundedRegistryFetch}),journal:productionJournal(cfg.home),gate:updateGate,
      secure:secureUpdateDirectory,verifyActive:path=>verifyUpdateActive(cfg.home,path),launch:job=>launchUpdateWorker(cfg.home,job),audit:result=>audit.record({action:'update',domain:'',result})})
    await coordinator.refreshGate()
    const updater={update:async()=>({ok:false,message:'Use a coordinated-update desktop client; legacy service-only update is disabled'})}

    const diagnose = async () => ({ ...await diagnoseService(cfg.home, vault, platform, loadConfig(env, platform).cdpEndpoint), serviceVersion: safeVersion(currentVersion), discordPolicy: await discordStore.list().then(() => 'pass' as const, () => 'fail' as const), discordBroker: platform === 'win32' ? 'available' as const : 'unsupported' as const })
    const control: ControlService = new ControlService({ vault, approver, limiter, settings, allowlist, grants, audit, platform, updater, diagnose, serviceVersion: safeVersion(currentVersion), manage: () => manager.open(), discordSupported: platform === 'win32', githubSupported:platform==='win32', updateBoot })
    const manager = new ManagementService({
      store: allowlist, grants, vault, audit, diagnose, phrase: async () => (await settings.get()).phrase,
      show: req => adapters.prompt.manage ? adapters.prompt.manage(req) : Promise.reject(new Error('unsupported')),
      lock: () => control.lock(), unlock: () => control.unlock(), revoke: domain => core.revoke(domain),
      discordStore, discordRevoke: alias => discord.discordRevoke(alias),
    })
    const api: CoreApi & ControlApi & DiscordApi & CoordinatedUpdateApi & GithubApi & AgentUnlockApi = {
      requestUnlock:()=>control.requestUnlock(),githubRequestAllow:proposal=>github.githubRequestAllow(proposal),githubListAllowed:()=>github.githubListAllowed(),githubRead:(alias,request)=>github.githubRead(alias,request),githubCreate:(alias,operation)=>github.githubCreate(alias,operation),githubRevoke:alias=>github.githubRevoke(alias),
      planUpdate:()=>coordinator.planUpdate(),beginUpdate:target=>coordinator.beginUpdate(target),updateStatus:id=>coordinator.updateStatus(id),activateUpdate:id=>coordinator.activateUpdate(id),confirmUpdateReady:id=>coordinator.confirmUpdateReady(id),
      discordRequestAllow: proposal => discord.discordRequestAllow(proposal),
      discordListAllowed: () => discord.discordListAllowed(),
      discordInspect: (alias, memberId, page) => discord.discordInspect(alias, memberId, page),
      discordApply: (alias, operations) => discord.discordApply(alias, operations),
      discordRevoke: alias => discord.discordRevoke(alias),
      capabilities: () => control.capabilities(),
      diagnose: () => control.diagnose(),
      manage: () => control.manage(),
      login: (domain, browser) => core.login(domain, browser),
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
    const server = await startIpcServer(cfg.endpoint, api, { authorize: adapters.authorize,admission:updateGate,beforeRequest:()=>coordinator.refreshGate(),afterResponse:(method,params)=>coordinator.afterResponse(method,String(params.id??'')) })
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
