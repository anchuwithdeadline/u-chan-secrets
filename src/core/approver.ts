import { execFile } from 'node:child_process'
import type { Approver } from './types.js'

export type SpawnPs = (
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string }>

// Fixed script: AI-supplied text only ever arrives via env vars, never in this string.
const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$r = [System.Windows.Forms.MessageBox]::Show($owner, $env:UCS_BODY, $env:UCS_TITLE, [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)',
  'if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { Write-Output "YES" } else { Write-Output "NO" }',
].join('; ')

const defaultSpawnPs: SpawnPs = (script, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env, timeout: timeoutMs, windowsHide: false },
      (err, stdout) => {
        if (err) reject(err)
        else resolve({ code: 0, stdout: String(stdout) })
      },
    )
  })

export class WindowsDialogApprover implements Approver {
  private spawnPs: SpawnPs
  private timeoutMs: number
  constructor(opts: { spawnPs?: SpawnPs; timeoutMs?: number } = {}) {
    this.spawnPs = opts.spawnPs ?? defaultSpawnPs
    this.timeoutMs = opts.timeoutMs ?? 120000
  }

  async ask(title: string, lines: string[]): Promise<boolean> {
    try {
      const env = { ...process.env, UCS_TITLE: title, UCS_BODY: lines.join('\n') }
      const res = await this.spawnPs(SCRIPT, env, this.timeoutMs)
      return res.code === 0 && res.stdout.trim() === 'YES'
    } catch {
      return false
    }
  }
}
