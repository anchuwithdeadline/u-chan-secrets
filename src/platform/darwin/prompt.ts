import { execFile } from 'node:child_process'
import { UserFacingError, type PromptRequest, type ProtectedPrompt } from '../../core/types.js'
import { buildJxaPromptScript } from './prompt-script.js'
import { buildJxaManagementScript } from './manage-script.js'
import type { ManagementAction } from '../../core/types.js'
import { readInstallUid } from './authorize.js'

export interface PromptExecutor {
  exec(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number }>
}

export const defaultPromptExecutor: PromptExecutor = {
  exec(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
        if (error) {
          const exitCode = typeof (error as any).code === 'number' ? (error as any).code : 1
          resolve({ stdout: stdout || '', exitCode })
          return
        }
        resolve({ stdout: stdout || '', exitCode: 0 })
      })
    })
  },
}

export interface MacosPromptOptions {
  installUid?: number
  ownerPath?: string
  executor?: PromptExecutor
}

const DEFAULT_PROMPT_TIMEOUT_MS = 120000

export class MacosProtectedPrompt implements ProtectedPrompt {
  private readonly executor: PromptExecutor

  constructor(private readonly opts: MacosPromptOptions = {}) {
    this.executor = opts.executor ?? defaultPromptExecutor
  }
  async manage(req: PromptRequest): Promise<ManagementAction | null> {
    const uid = this.opts.installUid ?? await readInstallUid(this.opts.ownerPath)
    if (uid === null || uid === undefined) return null
    try {
      const r = await this.executor.exec('/bin/launchctl', ['asuser', String(uid), '/usr/bin/osascript', '-l', 'JavaScript', '-e', buildJxaManagementScript(req)], DEFAULT_PROMPT_TIMEOUT_MS)
      if (r.exitCode !== 0) return null
      const action = JSON.parse(r.stdout)
      return action && typeof action.action === 'string' ? action : null
    } catch { return null }
  }

  async confirm(_req: PromptRequest): Promise<boolean> {
    throw new UserFacingError('click-to-approve easy mode is disabled on macOS; only hardcore mode is supported')
  }

  async askPassword(req: PromptRequest): Promise<string | null> {
    const uid =
      this.opts.installUid !== undefined
        ? this.opts.installUid
        : await readInstallUid(this.opts.ownerPath)

    if (uid === null || uid === undefined) {
      return null
    }

    const script = buildJxaPromptScript(req)

    try {
      const res = await this.executor.exec(
        '/bin/launchctl',
        ['asuser', String(uid), '/usr/bin/osascript', '-l', 'JavaScript', '-e', script],
        DEFAULT_PROMPT_TIMEOUT_MS,
      )
      if (res.exitCode !== 0) {
        return null
      }
      return res.stdout.trimEnd()
    } catch {
      return null
    }
  }
}
