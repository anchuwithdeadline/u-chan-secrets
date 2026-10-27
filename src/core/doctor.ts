import { execFile } from 'node:child_process'

export interface Proc {
  pid: number
  ppid: number
  name: string
  cmd: string
}

export type PlaywrightCheck = 'ok' | 'missing' | 'not_found' | 'unknown'

const SHELLS = new Set(['node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'node', 'sh', 'bash'])
const IS_PLAYWRIGHT = /@playwright[\\/]mcp/i

/**
 * Finds the AI client that launched us (first non-shell ancestor), then checks whether that
 * client's Playwright MCP was started with --cdp-endpoint (i.e. shares our Chrome).
 */
export function checkPlaywrightCdp(procs: Proc[], selfPid: number): Exclude<PlaywrightCheck, 'unknown'> {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const ancestors = (pid: number): Proc[] => {
    const out: Proc[] = []
    const seen = new Set<number>()
    for (let p = byPid.get(byPid.get(pid)?.ppid ?? -1); p && !seen.has(p.pid); p = byPid.get(p.ppid)) {
      seen.add(p.pid)
      out.push(p)
    }
    return out
  }
  const client = ancestors(selfPid).find((p) => !SHELLS.has(p.name.toLowerCase()))
  if (!client) return 'not_found'
  const ours = procs.filter((p) => IS_PLAYWRIGHT.test(p.cmd) && ancestors(p.pid).some((a) => a.pid === client.pid))
  if (ours.length === 0) return 'not_found'
  return ours.some((p) => p.cmd.includes('--cdp-endpoint')) ? 'ok' : 'missing'
}

const PS_LIST =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'

/** Lists processes via PowerShell/CIM; returns 'unknown' on any failure. */
export async function checkPlaywrightNow(selfPid = process.pid): Promise<PlaywrightCheck> {
  try {
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', PS_LIST],
        { timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(String(out))),
      ),
    )
    const raw = JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null }[]
    const procs = raw.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name ?? '', cmd: r.CommandLine ?? '' }))
    return checkPlaywrightCdp(procs, selfPid)
  } catch {
    return 'unknown'
  }
}
