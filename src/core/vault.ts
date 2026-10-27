import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { UserFacingError, type Credentials, type VaultClient, type VaultStatus } from './types.js'
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
      { env, shell: false, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr })
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code
        if (typeof code === 'number') return resolve({ code, stdout, stderr })
        reject(err) // spawn failure (ENOENT, EACCES, ...)
      },
    )
  })

const STATUSES: VaultStatus[] = ['unlocked', 'locked', 'unauthenticated']
const UNLOCK_MSG = 'vault locked — chạy scripts/unlock.ps1'

export class BitwardenVault implements VaultClient {
  private sessionPath: string
  private exec: Exec

  constructor(opts: { sessionPath: string; exec?: Exec }) {
    this.sessionPath = opts.sessionPath
    this.exec = opts.exec ?? defaultExec
  }

  private async session(): Promise<string> {
    if (process.env.BW_SESSION) return process.env.BW_SESSION.trim()
    try {
      return (await readFile(this.sessionPath, 'utf8')).trim()
    } catch {
      return ''
    }
  }

  private async run(args: string[], session: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, BW_NOINTERACTION: 'true' }
    if (session) env.BW_SESSION = session
    return this.exec(args, env)
  }

  async status(): Promise<VaultStatus> {
    try {
      const r = await this.run(['status'], await this.session())
      const s = (JSON.parse(r.stdout) as { status?: string }).status as VaultStatus
      return STATUSES.includes(s) ? s : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  async getLogin(item: string): Promise<Credentials> {
    const session = await this.session()
    let r: { code: number; stdout: string; stderr: string }
    try {
      r = await this.run(['get', 'item', item], session)
    } catch {
      throw new UserFacingError('bitwarden CLI (bw) is not available')
    }
    if (r.code !== 0) {
      const err = r.stderr.toLowerCase()
      if (err.includes('more than one result')) throw new UserFacingError('multiple items match, dùng item id')
      if (err.includes('not found')) throw new UserFacingError('item not found')
      if (err.includes('vault is locked') || err.includes('you are not logged in')) throw new UserFacingError(UNLOCK_MSG)
      throw new UserFacingError(`bw failed (exit ${r.code}): ${redact(r.stderr.trim(), [session])}`)
    }
    let login: { username?: unknown; password?: unknown } | undefined
    try {
      login = (JSON.parse(r.stdout) as { login?: typeof login }).login
    } catch {
      throw new UserFacingError('unexpected bw output')
    }
    if (typeof login?.username !== 'string' || typeof login?.password !== 'string' || !login.username || !login.password) {
      throw new UserFacingError('item has no username/password')
    }
    return { username: login.username, password: login.password }
  }
}
