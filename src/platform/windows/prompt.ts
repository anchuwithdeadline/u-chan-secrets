import { execFile as defaultExecFile } from 'node:child_process'
import type { PromptRequest, ProtectedPrompt } from '../../core/types.js'

export interface PromptRunnerOutcome {
  ok: boolean
  password?: string
}

export type PromptRunner = (params: {
  mode: 'confirm' | 'password'
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
    mode: 'confirm' | 'password'
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

      try {
        this.execFile(
          this.promptExePath,
          args,
          { timeout: params.timeoutMs, windowsHide: false },
          (error, stdout) => {
            if (error) {
              resolve({ ok: false })
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
