import { execFile as defaultExecFile } from 'node:child_process'
import type { PromptRequest, ProtectedPrompt, ManagementAction } from '../../core/types.js'

export interface PromptRunnerOutcome {
  ok: boolean
  password?: string
  action?: ManagementAction
}

export type PromptRunner = (params: {
  mode: 'confirm' | 'password' | 'manage'
  domains?: string[]
  title: string
  lines: string[]
  phrase: string
  timeoutMs: number
}) => Promise<PromptRunnerOutcome>

export type PromptExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void

export interface WindowsPromptOptions {
  phrase: string
  promptExePath?: string
  runner?: PromptRunner
  timeoutMs?: number
  execFile?: PromptExecFile
}

const DEFAULT_TIMEOUT_MS = 120000

export class WindowsProtectedPrompt implements ProtectedPrompt {
  private readonly phrase: string
  private readonly promptExePath?: string
  private readonly runner: PromptRunner
  private readonly timeoutMs: number
  private readonly execFile: PromptExecFile
  private queue: Promise<void> = Promise.resolve()

  constructor(opts: WindowsPromptOptions) {
    this.phrase = opts.phrase
    this.promptExePath = opts.promptExePath
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.execFile = opts.execFile ?? (defaultExecFile as PromptExecFile)
    this.runner = opts.runner ?? this.defaultRunner.bind(this)
  }

  confirm(req: PromptRequest): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        const outcome = await this.runner({
          mode: 'confirm',
          title: req.title,
          lines: req.lines,
          phrase: this.phrase || req.phrase,
          timeoutMs: this.timeoutMs,
        })
        return outcome?.ok === true
      } catch {
        return false
      }
    })
  }
  manage(req: PromptRequest): Promise<ManagementAction | null> {
    return this.enqueue(async () => {
      try {
        const r = await this.runner({ mode: 'manage', title: req.title, lines: req.lines, phrase: this.phrase || req.phrase, domains: req.domains, timeoutMs: this.timeoutMs })
        return r.ok && r.action ? r.action : null
      } catch { return null }
    })
  }

  askPassword(req: PromptRequest): Promise<string | null> {
    return this.enqueue(async () => {
      try {
        const outcome = await this.runner({
          mode: 'password',
          title: req.title,
          lines: req.lines,
          phrase: this.phrase || req.phrase,
          timeoutMs: this.timeoutMs,
        })
        if (outcome?.ok && typeof outcome.password === 'string') {
          return outcome.password.trim()
        }
        return null
      } catch {
        return null
      }
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private defaultRunner(params: {
    mode: 'confirm' | 'password' | 'manage'
    domains?: string[]
    title: string
    lines: string[]
    phrase: string
    timeoutMs: number
  }): Promise<PromptRunnerOutcome> {
    return new Promise((resolve) => {
      if (!this.promptExePath) {
        resolve({ ok: false })
        return
      }

      const args = [
        '--mode',
        params.mode,
        '--title',
        params.title,
        '--phrase',
        params.phrase,
        '--lines',
        JSON.stringify(params.lines),
      ]
      if (params.mode === 'manage') args.push('--domains', JSON.stringify(params.domains ?? []))

      try {
        this.execFile(
          this.promptExePath,
          args,
          { timeout: params.timeoutMs + 20000, windowsHide: true },
          (error, stdout) => {
            if (error) {
              resolve({ ok: false })
              return
            }
            if (params.mode === 'manage') {
              const match = /^(close|refresh|lock|unlock|revoke|next|previous)(?::([^\r\n]*))?$/.exec(stdout.trim())
              resolve(match ? { ok: true, action: { action: match[1] as ManagementAction['action'], ...(match[2] ? { domain: match[2] } : {}) } } : { ok: false })
              return
            }
            resolve({
              ok: true,
              password: params.mode === 'password' ? stdout : undefined,
            })
          }
        )
      } catch {
        resolve({ ok: false })
      }
    })
  }
}
