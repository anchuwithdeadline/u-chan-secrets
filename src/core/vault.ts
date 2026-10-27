import { execFile } from 'node:child_process'
import { UserFacingError, type Credentials, type MasterPasswordChecker, type VaultClient, type VaultStatus } from './types.js'
import { redact } from './redact.js'

export type Exec = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>

/**
 * Default exec: runs bw directly, never through a shell (item names come from the AI).
 * On Windows this requires the native bw.exe (e.g. `winget install Bitwarden.CLI`),
 * not the npm `.cmd` shim, which cannot be spawned without a shell.
 * Non-zero exit resolves with the code; only spawn failures (ENOENT) reject.
 */
const defaultExec: Exec = (args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.U_CHAN_BW ?? 'bw',
      args,
      { env, shell: false, windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 30000, killSignal: 'SIGKILL' },
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
  private lastUse = 0

  constructor(opts: { dataDir: string; exec?: Exec; idleLockMs: number; now?: () => number }) {
    this.dataDir = opts.dataDir
    this.exec = opts.exec ?? defaultExec
    this.idleLockMs = opts.idleLockMs
    this.now = opts.now ?? Date.now
  }

  /** Returns the in-memory session, dropping it if the idle timeout elapsed. */
  private session(): string {
    if (this.sessionKey && this.now() - this.lastUse > this.idleLockMs) this.sessionKey = ''
    return this.sessionKey
  }

  private run(args: string[], session: string, extra: NodeJS.ProcessEnv = {}): Promise<ExecResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, BW_NOINTERACTION: 'true', BITWARDENCLI_APPDATA_DIR: this.dataDir, ...extra }
    delete env.BW_SESSION
    if (session) env.BW_SESSION = session
    return this.exec(args, env)
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
    this.sessionKey = ''
    const key = await this.tryUnlock(password)
    if (!key) return false
    this.sessionKey = key
    this.lastUse = this.now()
    return true
  }

  async verify(password: string): Promise<boolean> {
    const key = await this.tryUnlock(password)
    if (!key) return false
    this.sessionKey = key
    this.lastUse = this.now()
    return true
  }

  async lock(): Promise<void> {
    const session = this.sessionKey
    this.sessionKey = ''
    try {
      await this.run(['lock'], session)
    } catch {
      // Session is already forgotten; bw lock is best effort.
    }
  }

  async status(): Promise<VaultStatus> {
    const session = this.session()
    if (!session) return 'locked'
    try {
      const r = await this.run(['status'], session)
      const s = (JSON.parse(r.stdout) as { status?: string }).status as VaultStatus
      if (s === 'locked') this.sessionKey = ''
      return STATUSES.includes(s) ? s : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  async getLogin(item: string): Promise<Credentials> {
    const session = this.session()
    if (!session) throw new UserFacingError(UNLOCK_MSG)
    let r: ExecResult
    try {
      r = await this.run(['get', 'item', item], session)
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
        this.sessionKey = ''
        throw new UserFacingError(UNLOCK_MSG)
      }
      if (err.includes('you are not logged in')) throw new UserFacingError(LOGIN_MSG)
      console.error(`bw failed (exit ${r.code}): ${redact(r.stderr.trim(), [session])}`)
      throw new UserFacingError(`bw failed (exit ${r.code})`)
    }
    let login: { username?: unknown; password?: unknown; totp?: unknown } | undefined
    try {
      login = (JSON.parse(r.stdout) as { login?: typeof login }).login
    } catch {
      throw new UserFacingError('unexpected bw output')
    }
    if (typeof login?.username !== 'string' || typeof login?.password !== 'string' || !login.username || !login.password) {
      throw new UserFacingError('item has no username/password')
    }
    this.lastUse = this.now()
    const creds: Credentials = { username: login.username, password: login.password }
    if (typeof login.totp === 'string' && login.totp.trim()) creds.totp = login.totp.trim()
    return creds
  }
}
