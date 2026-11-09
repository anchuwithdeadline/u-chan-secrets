import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { defaultProgramData } from './windows/install.js'

export type BwRun = (args: string[], opts: { interactive: boolean }) => Promise<{ code: number; stdout: string }>
export interface BwLoginDeps { run: BwRun; interactive: boolean; manualCommand: string; lockCommand: string; out(line: string): void }
export type BwLoginOutcome = 'already' | 'logged_in' | 'skipped' | 'failed'

const MAC_HOME = '/Library/Application Support/u-chan-secrets'

export async function ensureServiceBitwardenLogin(d: BwLoginDeps): Promise<BwLoginOutcome> {
  const manual = () => d.out(`Bitwarden service login still needed. From this elevated terminal run:\n${d.manualCommand}`)
  try {
    const st = await d.run(['status'], { interactive: false })
    if (JSON.parse(st.stdout).status !== 'unauthenticated') return 'already'
    if (!d.interactive) { manual(); return 'skipped' }
    if ((await d.run(['login'], { interactive: true })).code !== 0) { manual(); return 'failed' }
    let locked = false
    try { locked = (await d.run(['lock'], { interactive: false })).code === 0 } catch { /* reported below */ }
    if (!locked) {
      d.out(`Bitwarden service lock failed; the printed session key may still work. From this elevated terminal run:
${d.lockCommand}`)
      return 'failed'
    }
    return 'logged_in'
  } catch {
    manual()
    return 'failed'
  }
}

export function serviceBwRunner(bwPath: string, dataDir: string, env: NodeJS.ProcessEnv): BwRun {
  const { BW_SESSION: _drop, ...rest } = env
  const e = { ...rest, BITWARDENCLI_APPDATA_DIR: dataDir }
  return (args, { interactive }) => new Promise((resolve, reject) => {
    if (interactive) {
      const c = spawn(bwPath, args, { stdio: 'inherit', env: e, windowsHide: false })
      c.on('error', reject)
      c.on('close', code => resolve({ code: code ?? 1, stdout: '' }))
      return
    }
    execFile(bwPath, args, { env: e, timeout: 30000, maxBuffer: 65536, windowsHide: true }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout) })
      const code = (err as { code?: unknown }).code
      if (typeof code === 'number') resolve({ code, stdout: String(stdout) })
      else reject(err)
    })
  })
}

export function serviceBwPaths(platform: NodeJS.Platform): { bwPath: string; dataDir: string; manualCommand: string; lockCommand: string } | null {
  if (platform === 'win32') {
    const pd = defaultProgramData()
    const cmd = (verb: string) => [
      String.raw`$env:BITWARDENCLI_APPDATA_DIR = Join-Path $env:ProgramData 'u-chan-secrets\bw-data'`,
      String.raw`Remove-Item Env:\BW_SESSION -ErrorAction SilentlyContinue`,
      String.raw`& (Join-Path $env:ProgramData 'u-chan-secrets\bin\bw.exe') ` + verb,
    ].join('\n')
    return { bwPath: join(pd, 'bin', 'bw.exe'), dataDir: join(pd, 'bw-data'), manualCommand: cmd('login'), lockCommand: cmd('lock') }
  }
  if (platform === 'darwin') {
    const cmd = (verb: string) => `sudo env -u BW_SESSION BITWARDENCLI_APPDATA_DIR="${MAC_HOME}/bw-data" "${MAC_HOME}/bin/bw" ${verb}`
    return { bwPath: `${MAC_HOME}/bin/bw`, dataDir: `${MAC_HOME}/bw-data`, manualCommand: cmd('login'), lockCommand: cmd('lock') }
  }
  return null
}
