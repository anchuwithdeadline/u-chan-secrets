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
export function checkPlaywrightCdp(procs: Proc[], selfPid: number, expectedEndpoint?: string): Exclude<PlaywrightCheck, 'unknown'> {
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
  if (expectedEndpoint !== undefined) {
    const expected = safeCdpOrigin(expectedEndpoint)
    return expected && ours.every(p => {
      const match = /(?:^|\s)--cdp-endpoint(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/.exec(p.cmd)
      return match && safeCdpOrigin(match[1] ?? match[2] ?? match[3]) === expected
    }) ? 'ok' : 'missing'
  }
  return ours.some((p) => p.cmd.includes('--cdp-endpoint')) ? 'ok' : 'missing'
}

const PS_LIST =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'

/** Lists processes via PowerShell/CIM; returns 'unknown' on any failure. */
export async function checkPlaywrightNow(selfPid = process.pid, expectedEndpoint?: string): Promise<PlaywrightCheck> {
  if (process.platform !== 'win32') return 'unknown'
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
    return checkPlaywrightCdp(procs, selfPid, expectedEndpoint)
  } catch {
    return 'unknown'
  }
}

export type DiagnosticState = 'pass' | 'fail' | 'unknown'
// Leave room for the service's full native ACL scan and IPC overhead.
export const SERVICE_DIAGNOSTIC_TIMEOUT_MS = 25000
export interface DiagnosticCheck { id: string; state: DiagnosticState; required: boolean; message: string; nextAction: string }
export interface DiagnosticReport { version: 1; checks: DiagnosticCheck[] }
export interface ServiceDiagnostic {
  serviceVersion?: string
  browser?: DiagnosticState
  browserEndpoint?: string
  assets: DiagnosticState
  permissions: DiagnosticState
  vault: DiagnosticState | 'locked' | 'unauthenticated'
}
export interface DoctorDeps {
  clientVersion?: string
  clientEndpoint?: string
  elevation?: () => Promise<DiagnosticState>
  platform: NodeJS.Platform
  registration: () => Promise<DiagnosticState>
  service: () => Promise<ServiceDiagnostic>
  chrome: () => Promise<DiagnosticState>
  playwright: () => Promise<DiagnosticState>
}
export function safeVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) ? value : undefined
}
export function safeCdpOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : undefined
  } catch { return undefined }
}
export async function bounded<T>(probe: () => Promise<T>, fallback: T, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([Promise.resolve().then(probe), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs) })]) }
  catch { return fallback }
  finally { clearTimeout(timer) }
}
export async function runDoctor(d: DoctorDeps): Promise<DiagnosticReport> {
  const [registration, service, chrome, playwright, elevation] = await Promise.all([
    bounded(d.registration, 'unknown' as DiagnosticState),
    bounded(d.service, null, SERVICE_DIAGNOSTIC_TIMEOUT_MS),
    bounded(d.chrome, 'unknown' as DiagnosticState),
    bounded(d.playwright, 'unknown' as DiagnosticState),
    bounded(d.elevation ?? (async () => 'unknown' as DiagnosticState), 'unknown' as DiagnosticState),
  ])
  const checks: DiagnosticCheck[] = []
  const add = (id: string, state: DiagnosticState, message: string, nextAction: string, required = true) => {
    checks.push({ id, state, message, nextAction: state === 'pass' ? '' : nextAction, required })
  }
  const supported = d.platform === 'win32' || d.platform === 'darwin'
  add('platform', supported ? 'pass' : 'fail', supported ? 'Platform is supported.' : 'Platform is unsupported.', 'Use Windows or macOS.')
  add('registration', registration, 'Service registration checked.', 'Run u-chan install from a trusted administrator terminal.')
  add('service', service ? 'pass' : 'fail', service ? 'Service is reachable.' : 'Service is unreachable.', 'Check service status; run u-chan install if absent.')
  add('ipc', service ? 'pass' : 'unknown', 'Authenticated service connection checked.', 'Check the installed owner account and service.')
  const state = (value: unknown): DiagnosticState => value === 'pass' || value === 'fail' ? value : 'unknown'
  if (d.clientVersion !== undefined) {
    const client = safeVersion(d.clientVersion), installed = safeVersion(service?.serviceVersion)
    add('version', !client || !installed ? 'unknown' : client === installed ? 'pass' : 'fail',
      'CLI and installed service versions checked.', 'Install the matching trusted service package.')
  }
  if (d.clientEndpoint !== undefined) {
    const client = safeCdpOrigin(d.clientEndpoint), installed = safeCdpOrigin(service?.browserEndpoint)
    add('service_browser', state(service?.browser), 'Service browser endpoint checked.', 'Start dedicated Chrome and check the service browser target.')
    add('browser_target', !client || !installed ? 'unknown' : client === installed ? 'pass' : 'fail',
      'Desktop and service browser targets checked.', 'Align the desktop and service loopback browser targets.')
  }
  if (d.platform === 'win32' && d.elevation) add('uac', elevation, 'Windows administrator prompt policy checked.', 'Set UAC to Always notify in Windows settings.')
  add('assets', state(service?.assets), 'Private service assets checked.', 'Repair the installation from a trusted administrator terminal.')
  add('permissions', state(service?.permissions), 'Protected service permissions checked.', 'Repair protected permissions from a trusted administrator terminal.')
  const v = service?.vault
  add('vault', v === 'locked' ? 'pass' : v === 'unauthenticated' ? 'fail' : state(v),
    v === 'locked' ? 'Vault is locked.' : v === 'unauthenticated' ? 'Vault is not authenticated.' : 'Vault availability checked.',
    'Complete Bitwarden service login during trusted setup.')
  if (v === 'locked') checks[checks.length - 1].nextAction = 'Run u-chan unlock.'
  add('chrome', chrome, 'Dedicated Chrome CDP endpoint checked.', 'Start dedicated Chrome with the provided platform launcher.')
  add('playwright', playwright, 'Playwright shared-browser configuration checked.', 'Configure Playwright MCP with --cdp-endpoint and restart the AI session.', playwright !== 'unknown')
  return { version: 1, checks }
}
export function doctorExitCode(report: DiagnosticReport): 0 | 1 | 2 {
  const required = report.checks.filter(c => c.required)
  return required.some(c => c.state === 'fail') ? 1 : required.some(c => c.state === 'unknown') ? 2 : 0
}
export async function commandState(file: string, args: string[], passes: (stdout: string) => boolean, timeoutMs = 5000): Promise<DiagnosticState> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 65536 }, (err, stdout) => {
      resolve(err ? 'unknown' : passes(stdout) ? 'pass' : 'fail')
    })
  })
}
export async function chromeState(endpoint: string): Promise<DiagnosticState> {
  try {
    const origin = safeCdpOrigin(endpoint)
    if (!origin) return 'fail'
    const url = new URL('/json/version', origin)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') return 'fail'
    const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' })
    const json = await r.json() as { webSocketDebuggerUrl?: unknown }
    return r.ok && typeof json.webSocketDebuggerUrl === 'string' ? 'pass' : 'fail'
  } catch { return 'fail' }
}
