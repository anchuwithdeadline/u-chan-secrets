import { execFile } from 'node:child_process'
import { UserFacingError, type Credentials, type MasterPasswordChecker, type VaultClient, type VaultStatus } from './types.js'
import { redact } from './redact.js'
import { snowflake, tokenFieldSchema, type TokenField } from '../discord/policy.js'

export type Exec = (args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>

/**
 * Default exec: runs bw directly, never through a shell (item names come from the AI).
 * On Windows this requires the native bw.exe (e.g. `winget install Bitwarden.CLI`),
 * not the npm `.cmd` shim, which cannot be spawned without a shell.
 * Non-zero exit resolves with the code; only spawn failures (ENOENT) reject.
 */
const defaultExec: Exec = (args, env, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.U_CHAN_BW ?? 'bw',
      args,
      { env, shell: false, windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 30000, killSignal: 'SIGKILL', signal },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr })
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code
        if (typeof code === 'number') return resolve({ code, stdout, stderr })
        reject(err) // spawn failure (ENOENT, EACCES, ...)
      },
    )
  })

const STATUSES: VaultStatus[] = ['unlocked', 'locked', 'unauthenticated']
const SPAWN_CODES = ['ENOENT', 'EACCES', 'EINVAL']
export const LOGIN_MSG = 'not logged in to Bitwarden — run u-chan install'
export const UNLOCK_MSG = 'vault locked — run u-chan unlock'
const PW_ENV = 'UCS_BW_PASSWORD'

type ExecResult = { code: number; stdout: string; stderr: string }

export class BitwardenVault implements VaultClient, MasterPasswordChecker {
  private dataDir: string
  private exec: Exec
  private idleLockMs: number
  private now: () => number
  private sessionKey = ''
  private authorizationVersion = 0
  private lastUse = 0

  constructor(opts: { dataDir: string; exec?: Exec; idleLockMs: number; now?: () => number }) {
    this.dataDir = opts.dataDir
    this.exec = opts.exec ?? defaultExec
    this.idleLockMs = opts.idleLockMs
    this.now = opts.now ?? Date.now
  }

  /** Returns the in-memory session, dropping it if the idle timeout elapsed. */
  private session(): string {
    if (this.sessionKey && this.now() - this.lastUse > this.idleLockMs) { this.sessionKey = ''; this.authorizationVersion++ }
    return this.sessionKey
  }

  /** In-process authorization generation; never a credential or an IPC capability. */
  authorizationEpoch(): number { this.session(); return this.authorizationVersion }

  private run(args: string[], session: string, extra: NodeJS.ProcessEnv = {}, signal?: AbortSignal): Promise<ExecResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, BW_NOINTERACTION: 'true', BITWARDENCLI_APPDATA_DIR: this.dataDir, ...extra }
    delete env.BW_SESSION
    if (session) env.BW_SESSION = session
    return signal ? this.exec(args, env, signal) : this.exec(args, env)
  }

  /** Runs `bw unlock`; returns the new session key or null. The password travels only in env. */
  private async tryUnlock(password: string): Promise<string | null> {
    let r: ExecResult
    try {
      r = await this.run(['unlock', '--passwordenv', PW_ENV, '--raw'], '', { [PW_ENV]: password })
    } catch (e) {
      const err = e as { code?: unknown }
      if (typeof err.code === 'string' && SPAWN_CODES.includes(err.code)) throw new UserFacingError('bitwarden CLI (bw) is not available')
      throw new UserFacingError('bw failed')
    }
    const key = r.stdout.trim()
    if (r.code !== 0 || !key) {
      console.error(`bw unlock failed (exit ${r.code}): ${redact(r.stderr.trim(), [password, key])}`)
      return null
    }
    return key
  }

  async unlock(password: string): Promise<boolean> {
    const key = await this.tryUnlock(password)
    if (!key) return false // keep any previous session until a new one succeeds
    this.sessionKey = key
    this.authorizationVersion++
    this.lastUse = this.now()
    return true
  }

  verify(password: string): Promise<boolean> {
    return this.unlock(password)
  }

  async lock(): Promise<void> {
    this.authorizationVersion++
    const session = this.sessionKey
    this.sessionKey = ''
    try {
      await this.run(['lock'], session)
    } catch {
      // Session is already forgotten; bw lock is best effort.
    }
  }

  async status(signal?: AbortSignal): Promise<VaultStatus> {
    const session = this.session()
    try {
      const r = await this.run(['status'], session, {}, signal)
      const s = (JSON.parse(r.stdout) as { status?: string }).status as VaultStatus
      if (!STATUSES.includes(s)) return 'unavailable'
      if (s === 'locked' && session && this.sessionKey === session) this.sessionKey = ''
      // Without a key held in memory the vault is effectively locked.
      return s === 'unlocked' && !session ? 'locked' : s
    } catch {
      return 'unavailable'
    }
  }

  private async getItem(item: string, signal?: AbortSignal, quiet = false): Promise<Record<string, unknown>> {
    const session = this.session()
    if (!session) throw new UserFacingError((await this.status(signal)) === 'unauthenticated' ? LOGIN_MSG : UNLOCK_MSG)
    let r: ExecResult
    try {
      r = await this.run(['get', 'item', item], session, {}, signal)
    } catch (e) {
      // Fixed messages only: error text may contain argv.
      const err = e as { code?: unknown; signal?: unknown; killed?: unknown }
      if (typeof err.code === 'string' && SPAWN_CODES.includes(err.code)) {
        throw new UserFacingError('bitwarden CLI (bw) is not available')
      }
      if (err.signal || err.killed) throw new UserFacingError('bw timed out')
      throw new UserFacingError('bw failed')
    }
    if (r.code !== 0) {
      const err = r.stderr.toLowerCase()
      if (err.includes('more than one result')) throw new UserFacingError('multiple items match, use the item id')
      if (err.includes('not found')) throw new UserFacingError('item not found')
      if (err.includes('vault is locked')) {
        if (this.sessionKey === session) this.sessionKey = ''
        throw new UserFacingError(UNLOCK_MSG)
      }
      if (err.includes('you are not logged in')) throw new UserFacingError(LOGIN_MSG)
      if (!quiet) console.error(`bw failed (exit ${r.code}): ${redact(r.stderr.trim(), [session])}`)
      throw new UserFacingError(`bw failed (exit ${r.code})`)
    }
    try {
      const value = JSON.parse(r.stdout)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value
    } catch { throw new UserFacingError('unexpected bw output') }
  }

  /** Protected discovery only: return scoped setup metadata, never note contents or token values. */
  async getDiscordSetup(item: string, signal?: AbortSignal): Promise<{ item: string; guildId: string; field: TokenField }> {
    const session = this.session()
    if (!session) throw new UserFacingError(UNLOCK_MSG)
    try {
      const result = await this.run(['sync'], session, {}, signal)
      if (result.code !== 0) throw new Error()
    } catch { throw new UserFacingError('Bitwarden vault sync failed; check the private vault connection') }
    if (this.sessionKey !== session) throw new UserFacingError(UNLOCK_MSG)
    const data = await this.getItem(item, signal, true)
    if (typeof data.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.id)) throw new UserFacingError('vault item has no stable item ID')
    const normalize = (value: string) => value.toLowerCase().replace(/[ _-]/g, '')
    const guildKeys = new Set(['guildid', 'serverid', 'discordguildid', 'discordserverid'])
    const tokenKeys = new Set(['token', 'bottoken', 'discordtoken', 'discordbottoken'])
    const guildIds = new Set<string>(), fields: TokenField[] = []
    const addGuild = (value: unknown) => {
      if (typeof value !== 'string') throw new UserFacingError('vault item has invalid Discord server metadata')
      const id = value.trim().replace(/^[`"']|[`"']$/g, '')
      if (!snowflake.safeParse(id).success) throw new UserFacingError('vault item has invalid Discord server metadata')
      guildIds.add(id)
    }
    const password = (data.login as { password?: unknown } | undefined)?.password
    if (typeof password === 'string' && password) fields.push({ kind: 'password' })
    for (const field of Array.isArray(data.fields) ? data.fields : []) {
      if (!field || typeof field !== 'object' || typeof field.name !== 'string') continue
      const key = normalize(field.name)
      if (guildKeys.has(key)) addGuild(field.value)
      if (tokenKeys.has(key) && field.type === 1 && typeof field.value === 'string' && field.value) fields.push(tokenFieldSchema.parse({ kind: 'hidden', name: field.name }))
    }
    if (typeof data.notes === 'string') {
      for (const line of data.notes.split(/\r?\n/)) {
        const match = /^\s*(?:[-*#]\s*)?([a-z _-]+)\s*[:=]\s*(.*?)\s*$/i.exec(line)
        if (match && guildKeys.has(normalize(match[1].trim()))) addGuild(match[2])
      }
      try {
        const object: unknown = JSON.parse(data.notes)
        if (object && typeof object === 'object' && !Array.isArray(object)) for (const [key, value] of Object.entries(object)) if (guildKeys.has(normalize(key))) addGuild(value)
      } catch (e) { if (e instanceof UserFacingError) throw e }
    }
    if (guildIds.size !== 1) throw new UserFacingError('vault item does not contain one unambiguous labeled Discord server ID')
    if (fields.length !== 1) throw new UserFacingError('vault item does not contain one unambiguous password or named hidden bot-token field')
    signal?.throwIfAborted()
    this.lastUse = this.now()
    return { item: data.id, guildId: [...guildIds][0], field: fields[0] }
  }

  /** Privileged service only. Never expose this method through IPC or MCP. */
  async getToken(item: string, field: TokenField, signal?: AbortSignal): Promise<string> {
    const parsed = tokenFieldSchema.safeParse(field)
    if (!parsed.success) throw new UserFacingError('invalid token field')
    const data = await this.getItem(item, signal, true)
    let token: unknown
    if (field.kind === 'password') token = (data.login as { password?: unknown } | undefined)?.password
    else {
      const fields = Array.isArray(data.fields) ? data.fields.filter(f => f && typeof f === 'object' && f.name === field.name) : []
      if (fields.length !== 1 || fields[0].type !== 1) throw new UserFacingError('token field is missing or ambiguous')
      token = fields[0].value
    }
    if (typeof token !== 'string' || !token || token.length > 4096 || /[\s\p{Cc}\p{Cf}]/u.test(token)) throw new UserFacingError('token field is missing or invalid')
    signal?.throwIfAborted()
    this.lastUse = this.now()
    return token
  }

  async getLogin(item: string, signal?: AbortSignal): Promise<Credentials> {
    // bw reads its local cache, which keeps an item's old username/password after it is edited
    // elsewhere. Sync first; when offline or failing, fall back to the cache as before.
    const session = this.session()
    if (session) await this.run(['sync'], session, {}, signal).catch(() => undefined)
    const data = await this.getItem(item, signal)
    let login: { username?: unknown; password?: unknown; totp?: unknown } | undefined
    login = data.login as typeof login
    if (typeof login?.username !== 'string' || typeof login?.password !== 'string' || !login.username || !login.password) {
      throw new UserFacingError('item has no username/password')
    }
    this.lastUse = this.now()
    const creds: Credentials = { username: login.username, password: login.password }
    if (typeof login.totp === 'string' && login.totp.trim()) creds.totp = login.totp.trim()
    return creds
  }
}
