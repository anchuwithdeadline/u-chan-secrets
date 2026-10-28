import { defaultExec, type ExecFn } from './acl.js'

export class ServiceManager {
  constructor(private exec: ExecFn = defaultExec) {}

  async create(name: string, binPath: string, displayName?: string): Promise<void> {
    const args = [
      'create',
      name,
      `binPath= "${binPath}"`,
      'start= auto',
      'obj= LocalSystem',
    ]
    if (displayName) {
      args.push(`DisplayName= "${displayName}"`)
    }
    await this.exec('sc.exe', args, { windowsVerbatimArguments: true })
  }

  async start(name: string): Promise<void> {
    try {
      await this.exec('sc.exe', ['start', name])
    } catch (err: any) {
      const output = `${err?.stdout ?? ''} ${err?.stderr ?? ''} ${err?.message ?? ''}`
      if (/1056|already running/i.test(output)) {
        return
      }
      throw err
    }
  }

  async stop(name: string): Promise<void> {
    try {
      await this.exec('sc.exe', ['stop', name])
    } catch (err: any) {
      const output = `${err?.stdout ?? ''} ${err?.stderr ?? ''} ${err?.message ?? ''}`
      if (/1062|1060|1061|not been started|not running|does not exist/i.test(output)) {
        return
      }
      throw err
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await this.exec('sc.exe', ['delete', name])
    } catch (err: any) {
      const output = `${err?.stdout ?? ''} ${err?.stderr ?? ''} ${err?.message ?? ''}`
      if (/1060|does not exist/i.test(output)) {
        return
      }
      throw err
    }
  }

  async status(name: string): Promise<'running' | 'stopped' | 'pending' | 'not_installed'> {
    try {
      const { stdout } = await this.exec('sc.exe', ['query', name])
      if (/STATE\s*:\s*[0-9]+\s+RUNNING/i.test(stdout)) {
        return 'running'
      }
      if (/STATE\s*:\s*[0-9]+\s+STOPPED/i.test(stdout)) {
        return 'stopped'
      }
      return 'pending'
    } catch (err: any) {
      const output = `${err?.stdout ?? ''} ${err?.stderr ?? ''} ${err?.message ?? ''}`
      if (/1060|does not exist/i.test(output)) {
        return 'not_installed'
      }
      throw err
    }
  }
}
