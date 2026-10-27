import type { ApprovalMode, Approver, MasterPasswordChecker, ProtectedPrompt } from '../core/types.js'
import type { SettingsStore } from './settings.js'
import type { AttemptLimiter } from './attempts.js'

interface Deps {
  prompt: ProtectedPrompt
  checker: MasterPasswordChecker
  settings: SettingsStore
  limiter: AttemptLimiter
  platform: NodeJS.Platform
}

/** Easy: click to confirm. Hardcore (forced on macOS): master password, with lockout. One prompt at a time. */
export class PolicyApprover implements Approver {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: Deps) {}

  async effectiveMode(): Promise<ApprovalMode> {
    return this.d.platform === 'darwin' ? 'hardcore' : (await this.d.settings.get()).mode
  }

  ask(title: string, lines: string[]): Promise<boolean> {
    return this.serial(async () => {
      const { limiter, prompt, checker } = this.d
      if ((await this.effectiveMode()) === 'easy') return prompt.confirm({ title, lines, phrase: await this.phrase() })
      if (limiter.blocked()) return false
      const pw = await prompt.askPassword({ title, lines, phrase: await this.phrase() })
      if (pw === null) return false
      if (await checker.verify(pw)) {
        limiter.reset()
        return true
      }
      limiter.fail()
      return false
    })
  }

  /** Collects only; the caller verifies and counts failures. */
  askPassword(title: string, lines: string[]): Promise<string | null> {
    return this.serial(async () => {
      if (this.d.limiter.blocked()) return null
      return this.d.prompt.askPassword({ title, lines, phrase: await this.phrase() })
    })
  }

  private async phrase(): Promise<string> {
    return (await this.d.settings.get()).phrase
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }
}
