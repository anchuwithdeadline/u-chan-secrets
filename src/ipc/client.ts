import net from 'node:net'
import type { ApprovalMode, ControlApi, CoreApi, Selectors, ToolResult } from '../core/types.js'
import { FrameReader, encode, type Method } from './protocol.js'
import { isResultCode, type AllowOptions } from '../core/types.js'
import { validOptions } from '../core/policy.js'
import { browserKind, type BrowserKind } from '../client/browser-choice.js'
import { identitySchema, idSchema, type CoordinatedUpdateApi, type ReleaseIdentity } from '../service/update/protocol.js'
import { aliasSchema, batchSchema, connectionRequestSchema, snowflake, type DiscordApi } from '../discord/policy.js'

const DOWN = 'U-Chan service is not running — run u-chan install'

/** One connection per call; the service does all privileged work. */
export class IpcClient implements CoreApi, ControlApi, DiscordApi, CoordinatedUpdateApi {
  private nextId = 1
  private timeoutMs: number
  private readonly browser: BrowserKind | (() => BrowserKind)
  constructor(private path: string, opts: { timeoutMs?: number; browser?: BrowserKind | (() => BrowserKind) } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 180000
    this.browser = opts.browser ?? 'chrome'
  }

  private call(method: Method, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<ToolResult> {
    const id = this.nextId++
    return new Promise(resolve => {
      const reader = new FrameReader()
      const socket = net.connect(this.path)
      let done = false
      const finish = (r: ToolResult) => {
        if (done) return
        done = true
        clearTimeout(timer)
        socket.destroy()
        resolve(r)
      }
      const timer = setTimeout(() => finish({ ok: false, message: method === 'discord_apply' ? 'Discord write request timed out; it may have executed; inspect before retrying' : 'U-Chan service timed out' }), timeoutMs)
      socket.on('connect', () => socket.write(encode({ id, method, params })))
      socket.on('data', chunk => {
        try {
          for (const f of reader.push(chunk as Buffer)) {
            const r = f as { id?: unknown; ok?: unknown; message?: unknown; code?: unknown } | undefined
            if (r && r.id === id && typeof r.ok === 'boolean' && typeof r.message === 'string') {
              return finish({ ok: r.ok, message: r.message, ...(isResultCode(r.code) ? { code: r.code } : {}) })
            }
          }
        } catch { finish({ ok: false, message: 'U-Chan service sent a bad response' }) }
      })
      socket.on('error', (e: NodeJS.ErrnoException) =>
        finish({ ok: false, message: e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? DOWN : 'U-Chan service connection failed' }))
      socket.on('close', () => finish({ ok: false, message: 'U-Chan service closed the connection' }))
    })
  }

  async login(domain: string, browser?: BrowserKind): Promise<ToolResult> {
    let selected: BrowserKind
    try { selected = browserKind(browser ?? (typeof this.browser === 'function' ? this.browser() : this.browser)) }
    catch { return { ok: false, code: 'browser_unavailable', message: 'browser selection is invalid or changed; run setup and restart the AI session before login' } }
    const response = await this.capabilities()
    try {
      const capability = JSON.parse(response.message)
      if (response.ok && capability.protocol === 3 && Array.isArray(capability.features) && capability.features.includes('verified_session_transfer')) return this.call('login', { domain, browser: selected })
    } catch {}
    return { ok: false, code: 'unsupported_service', message: 'verified login requires a reachable V5 service; update the installed service before login' }
  }
  async requestAllow(domain: string, loginUrl: string, item: string, selectors?: Selectors, options?: AllowOptions): Promise<ToolResult> {
    if (options !== undefined) {
      if (!validOptions(options)) return { ok: false, code: 'invalid_policy', message: 'invalid approval policy or success condition' }
      const r = await this.capabilities()
      let features: unknown
      try { const cap = JSON.parse(r.message); if (r.ok && cap.protocol === 3) features = cap.features } catch {}
      if (!Array.isArray(features) || (options.grant && !features.includes('grants')) || (options.success && !features.includes('success_conditions'))) {
        return { ok: false, code: 'unsupported_service', message: 'installed service does not support the requested V3 approval; update the service' }
      }
    }
    return this.call('request_allow', { domain, loginUrl, item, ...(selectors ? { selectors } : {}), ...(options !== undefined ? { options } : {}) })
  }
  capabilities() { return this.call('capabilities') }
  private async coordinatedCall(method:Method,params:Record<string,unknown>={}):Promise<ToolResult>{
    const result=await this.capabilities()
    try{const cap=JSON.parse(result.message);if(result.ok&&cap.protocol===3&&Array.isArray(cap.features)&&cap.features.includes('coordinated_update'))return this.call(method,params,Math.max(this.timeoutMs,180000))}catch{}
    return {ok:false,code:'unsupported_service',message:'coordinated updater bootstrap required; install the matching trusted service before updating'}
  }
  planUpdate(){return this.coordinatedCall('plan_update')}
  beginUpdate(target:ReleaseIdentity){return identitySchema.safeParse(target).success?this.coordinatedCall('begin_update',{target}):Promise.resolve({ok:false,message:'invalid update target'})}
  updateStatus(id:string){return idSchema.safeParse(id).success?this.coordinatedCall('update_status',{id}):Promise.resolve({ok:false,message:'invalid update job'})}
  activateUpdate(id:string){return idSchema.safeParse(id).success?this.coordinatedCall('activate_update',{id}):Promise.resolve({ok:false,message:'invalid update job'})}
  confirmUpdateReady(id:string){return idSchema.safeParse(id).success?this.coordinatedCall('confirm_update_ready',{id}):Promise.resolve({ok:false,message:'invalid update job'})}
  private async discordCall(method: Method, params: Record<string, unknown> = {}, discovery = false): Promise<ToolResult> {
    const r = await this.capabilities()
    try {
      const c = JSON.parse(r.message)
      if (r.ok && c.protocol === 3 && Array.isArray(c.features) && c.features.includes('discord_broker') && (!discovery || c.features.includes('discord_discovery'))) return this.call(method, params, discovery ? Math.max(this.timeoutMs, 420000) : this.timeoutMs)
    } catch {}
    return { ok: false, code: 'unsupported_service', message: 'Discord broker requires an upgraded Windows service and protected review helper; perform a trusted administrator reinstall' }
  }
  discordRequestAllow(proposal: unknown) {
    const parsed = connectionRequestSchema.safeParse(proposal)
    if (!parsed.success) return Promise.resolve({ ok: false, message: 'invalid Discord connection policy' })
    return this.discordCall('discord_request_allow', { proposal: parsed.data }, !('guildId' in parsed.data))
  }
  discordListAllowed() { return this.discordCall('discord_list_allowed') }
  discordInspect(alias: string, memberId?: string, page = 0) {
    if (!aliasSchema.safeParse(alias).success || (memberId !== undefined && !snowflake.safeParse(memberId).success) || !Number.isInteger(page) || page < 0 || page > 999) return Promise.resolve({ ok: false, message: 'invalid Discord metadata request' })
    return this.discordCall('discord_inspect', { alias, memberId, page })
  }
  discordApply(alias: string, operations: unknown) {
    if (!aliasSchema.safeParse(alias).success || !batchSchema.safeParse(operations).success) return Promise.resolve({ ok: false, message: 'invalid Discord batch' })
    return this.discordCall('discord_apply', { alias, operations })
  }
  discordRevoke(alias: string) {
    if (!aliasSchema.safeParse(alias).success) return Promise.resolve({ ok: false, message: 'invalid Discord alias' })
    return this.discordCall('discord_revoke', { alias })
  }
  diagnose() { return this.call('diagnose') }
  manage() { return this.call('manage') }
  revoke(domain: string) { return this.call('revoke', { domain }) }
  listAllowed() { return this.call('list_allowed') }
  status() { return this.call('status') }
  unlock() { return this.call('unlock') }
  lock() { return this.call('lock') }
  setMode(mode: ApprovalMode) { return this.call('set_mode', { mode }) }
  importV1(entries: unknown[]) { return this.call('import_v1', { entries }) }
  audit(limit?: number) { return this.call('audit', limit !== undefined ? { limit } : {}) }
  update() { return this.call('update') }
}
