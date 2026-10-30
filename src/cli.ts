#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApprovalMode, ControlApi, CoreApi, ToolResult } from './core/types.js'
import { IpcClient } from './ipc/client.js'
import { defaultEndpoint } from './ipc/endpoint.js'
import { MAX_FRAME, encode } from './ipc/protocol.js'
import { runDoctor, doctorExitCode, checkPlaywrightNow, chromeState, safeVersion, SERVICE_DIAGNOSTIC_TIMEOUT_MS, type DiagnosticReport } from './core/doctor.js'
import { loadConfig } from './core/config.js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { configureCodex, isElevated } from './client/codex-setup.js'
import { runSetup, setupExitCode, type SetupOptions, type SetupReport } from './client/setup.js'
import { parseAllowArgs } from './client/allow.js'
import { saveBrowserChoice, type BrowserKind } from './client/browser-choice.js'

const USAGE = 'usage: u-chan install [--mode <easy|hardcore>] [--phrase <phrase>] | uninstall | unlock | lock | mode <easy|hardcore> | import-v1 [path] | audit [limit] | update | doctor [--json] | manage'

export interface CliDeps {
  doctor?: () => Promise<DiagnosticReport>
  clientVersion?: string
  setup?: (options: SetupOptions) => Promise<SetupReport>
  /** Opens a service client; `timeoutMs` undefined means the IpcClient default. */
  connect: (opts: { timeoutMs?: number }) => ControlApi & Pick<CoreApi, 'requestAllow'>
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  readFile: (path: string) => Promise<string>
  out: (line: string) => void
  err: (line: string) => void
  install?: (opts: { mode?: ApprovalMode; phrase?: string }) => Promise<ToolResult>
  uninstall?: () => Promise<ToolResult>
}

/** import-v1 shows one approval window per entry, each open for up to 2 minutes, one after another. */
export const IMPORT_PROMPT_MS = 120000
export const IMPORT_MARGIN_MS = 60000
export const importTimeoutMs = (count: number) => count * IMPORT_PROMPT_MS + IMPORT_MARGIN_MS

/** V1 kept its allowlist in %APPDATA%\u-chan-secrets (the user's profile). */
function defaultV1Path(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix
  return path.join(env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'u-chan-secrets', 'allowlist.json')
}

/** Returns the process exit code: 0 on success, 1 on failure or bad usage. */
export async function main(argv: string[], d: CliDeps): Promise<number> {
  const [cmd, arg, ...rest] = argv
  let call: (() => Promise<ToolResult>) | undefined
  let diagnosticEnv = d.env
  const doctor = d.doctor ?? (() => runDoctor({
    platform: d.platform,
    clientVersion: d.clientVersion ?? 'unknown',
    clientEndpoint: loadConfig(diagnosticEnv, d.platform).cdpEndpoint,
    browser: loadConfig(diagnosticEnv, d.platform).browser,
    browserIdentity: d.platform === 'win32' ? async () => {
      const cfg = loadConfig(diagnosticEnv, d.platform)
      return (await import('./platform/windows/desktop-browser.js')).inspectDesktopBrowser({ endpoint: cfg.cdpEndpoint, browser: cfg.browser, profile: cfg.browserProfile }, diagnosticEnv)
    } : undefined,
    elevation: d.platform === 'win32' ? async () => (await import('./platform/windows/doctor.js')).checkWindowsUac() : undefined,
    registration: async () => d.platform === 'win32' ? (await import('./platform/windows/doctor.js')).checkWindowsRegistration() : d.platform === 'darwin' ? (await import('./platform/darwin/doctor.js')).checkDarwinRegistration() : 'fail',
    service: async () => {
      const r = await d.connect({ timeoutMs: SERVICE_DIAGNOSTIC_TIMEOUT_MS }).diagnose()
      if (!r.ok) throw new Error('unavailable')
      const s = JSON.parse(r.message)
      if (!s || typeof s !== 'object') throw new Error('invalid diagnostics')
      return s
    },
    chrome: () => chromeState(loadConfig(diagnosticEnv, d.platform).cdpEndpoint),
    playwright: async () => {
      if (d.platform !== 'win32') return 'unknown'
      const state = await checkPlaywrightNow(process.pid, loadConfig(diagnosticEnv, d.platform).cdpEndpoint)
      return state === 'ok' ? 'pass' : state === 'missing' ? 'fail' : 'unknown'
    },
  }))
  const printDoctor = (r: DiagnosticReport) => d.out(r.checks.map(c => `${c.state.toUpperCase()} ${c.id}: ${c.message}${c.nextAction ? ' ' + c.nextAction : ''}`).join('\n'))
  if (cmd === 'allow') {
    const proposal = parseAllowArgs(argv.slice(1))
    if (!proposal) { d.err('usage: u-chan allow <domain> --login-url <https-url> --item <label> [--once|--minutes <1..1440>|--permanent] [--success-url <https-url>|--success-selector <selector>]'); return 1 }
    const r = await d.connect({ timeoutMs: 180000 }).requestAllow(proposal.domain, proposal.loginUrl, proposal.item, undefined, proposal.options)
    if (r.ok) {
      d.out(r.message)
      if (!proposal.options.success) d.out('No success condition supplied. Login may return authentication_unconfirmed; independently verify the signed-in page.')
    } else d.err(r.message)
    return r.ok ? 0 : 1
  }
  if (cmd === 'setup') {
    const args = argv.slice(1), seen = new Set<string>()
    let valid = true
    let browser: BrowserKind | undefined
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]
      if (seen.has(flag) || !['--client', '--browser', '--apply', '--replace-existing', '--start-browser', '--json'].includes(flag)) { valid = false; break }
      seen.add(flag)
      if (flag === '--client' && args[++i] !== 'codex') { valid = false; break }
      if (flag === '--browser') { const value = args[++i]; if (value !== 'chrome' && value !== 'edge') { valid = false; break }; browser = value }
    }
    if (!valid || (seen.has('--replace-existing') && !seen.has('--apply'))) {
      d.err('usage: u-chan setup [--client codex] [--browser chrome|edge] [--apply] [--replace-existing] [--start-browser] [--json]'); return 1
    }
    const options = { apply: seen.has('--apply'), replaceExisting: seen.has('--replace-existing'), startBrowser: seen.has('--start-browser'), ...(browser ? { browser } : {}) }
    if (browser) diagnosticEnv = { ...d.env, U_CHAN_BROWSER: browser }
    const cfg = loadConfig(diagnosticEnv, d.platform), endpoint = cfg.cdpEndpoint
    const r = d.setup ? await d.setup(options) : await runSetup(options, {
      platform: d.platform, endpoint, browser: cfg.browser, elevated: isElevated, doctor,
      selectBrowser: choice => saveBrowserChoice(cfg.browserChoicePath, choice),
      configure: opts => configureCodex({ ...opts, browser: cfg.browser, endpoint, ipcEndpoint: defaultEndpoint(d.env, d.platform), nodePath: process.execPath, entryPath: fileURLToPath(new URL('./index.js', import.meta.url)), configDir: d.env.CODEX_HOME ?? join(homedir(), '.codex') }),
      startBrowser: () => new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../scripts/start-browser.ps1', import.meta.url)), '-Browser', cfg.browser, '-Background'],
          { timeout: 24000, windowsHide: true, env: diagnosticEnv, maxBuffer: 65536 }, err => resolve(!err))
      }),
    })
    if (seen.has('--json')) d.out(JSON.stringify(r))
    else d.out([`Setup: ${r.state}; sharing: ${r.sharing}; restart required: ${r.restartRequired}`, ...r.actions.map(a => a.message), ...(r.backupPath ? ['Configuration backup: ' + r.backupPath] : [])].join('\n'))
    return setupExitCode(r)
  }
  if (cmd === 'doctor' && (arg === undefined || arg === '--json') && rest.length === 0) {
    const r = await doctor()
    if (arg === '--json') d.out(JSON.stringify(r))
    else printDoctor(r)
    return doctorExitCode(r)
  }

  if (cmd === 'install') {
    let mode: ApprovalMode | undefined
    let phrase: string | undefined
    let valid = true
    const args = arg !== undefined ? [arg, ...rest] : []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--mode' && (args[i + 1] === 'easy' || args[i + 1] === 'hardcore')) {
        mode = args[++i] as ApprovalMode
      } else if (args[i] === '--phrase' && args[i + 1] !== undefined) {
        phrase = args[++i]
      } else {
        valid = false
        break
      }
    }
    if (!valid) {
      d.err(USAGE)
      return 1
    }
    call = async () => {
      if (d.install) return d.install({ mode, phrase })
      if (d.platform === 'win32') {
        const { installWindowsService } = await import('./platform/windows/install.js')
        return installWindowsService({ mode, phrase, out: d.out, err: d.err })
      }
      if (d.platform === 'darwin') {
        const { macosInstall } = await import('./platform/darwin/lifecycle.js')
        return macosInstall({ mode, phrase, out: d.out, err: d.err })
      }
      return { ok: false, message: `install is not supported on ${d.platform} yet` }
    }
  } else if (cmd === 'uninstall' && arg === undefined) {
    call = async () => {
      if (d.uninstall) return d.uninstall()
      if (d.platform === 'win32') {
        const { uninstallWindowsService } = await import('./platform/windows/install.js')
        return uninstallWindowsService({ out: d.out, err: d.err })
      }
      if (d.platform === 'darwin') {
        const { macosUninstall } = await import('./platform/darwin/lifecycle.js')
        return macosUninstall({ out: d.out, err: d.err })
      }
      return { ok: false, message: `uninstall is not supported on ${d.platform} yet` }
    }
  } else if (cmd === 'unlock' && arg === undefined) {
    call = () => d.connect({}).unlock()
  } else if (cmd === 'lock' && arg === undefined) {
    call = () => d.connect({}).lock()
  } else if (cmd === 'mode' && (arg === 'easy' || arg === 'hardcore') && rest.length === 0) {
    call = () => d.connect({}).setMode(arg)
  } else if (cmd === 'import-v1' && rest.length === 0) {
    const path = arg ?? defaultV1Path(d.env, d.platform)
    let text: string
    try {
      text = await d.readFile(path)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code
      d.err(code === 'ENOENT' ? `no V1 allowlist found at ${path}` : `could not read ${path} (${code ?? 'error'})`)
      return 1
    }
    let entries: unknown
    try {
      entries = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    } catch {
      d.err(`${path} is not valid JSON`)
      return 1
    }
    if (!Array.isArray(entries)) {
      d.err(`${path} is not a V1 allowlist (expected a JSON array)`)
      return 1
    }
    // The service drops frames over MAX_FRAME; a worst-case id keeps this estimate above the real frame.
    const frame = encode({ id: Number.MAX_SAFE_INTEGER, method: 'import_v1', params: { entries } })
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME) {
      d.err('V1 allowlist is too large to import in one go')
      return 1
    }
    const list = entries
    call = () => d.connect({ timeoutMs: importTimeoutMs(list.length) }).importV1(list)
  } else if (cmd === 'audit' && rest.length === 0) {
    let limit: number | undefined
    if (arg !== undefined) {
      const parsed = Number(arg)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        d.err('limit must be a positive integer')
        return 1
      }
      limit = parsed
    }
    call = () => d.connect({}).audit(limit)
  } else if (cmd === 'update' && arg === undefined) {
    call = () => d.connect({ timeoutMs: 120000 }).update()
  } else if (cmd === 'manage' && arg === undefined) {
    call = () => d.connect({ timeoutMs: 15 * 60_000 }).manage()
  }

  if (!call) {
    d.err(USAGE)
    return 1
  }
  const r = await call()
  if (r.ok) d.out(r.message)
  else d.err(r.message)
  if (r.ok && cmd === 'install' && !d.install) printDoctor(await doctor())
  return r.ok ? 0 : 1
}

const isEntry = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntry) {
  let clientVersion = 'unknown'
  try { clientVersion = safeVersion(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version) ?? 'unknown' } catch {}
  const code = await main(process.argv.slice(2), {
    clientVersion,
    connect: (opts) => new IpcClient(defaultEndpoint(process.env, process.platform), opts),
    env: process.env,
    platform: process.platform,
    readFile: (p) => readFile(p, 'utf8'),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  })
  process.exitCode = code
}
