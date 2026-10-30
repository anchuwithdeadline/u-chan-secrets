import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeCdpOrigin } from '../core/doctor.js'
import { defaultEndpoint } from '../ipc/endpoint.js'
import { browserKind, type BrowserKind } from './browser-choice.js'

export type CodexSetupState = 'ready' | 'missing' | 'needs_update' | 'manual' | 'unavailable'
export interface CodexSetupOptions {
  apply: boolean; replaceExisting: boolean; endpoint: string; nodePath: string; entryPath: string; configDir: string
  ipcEndpoint?: string
  browser?: BrowserKind
}
export interface CodexSetupResult { state: CodexSetupState; changed: boolean; backupPath?: string; message: string }
interface ExecResult { code: number; stdout: string; stderr: string }
export interface CodexSetupDeps { elevated: () => Promise<boolean>; exec: (args: string[]) => Promise<ExecResult> }

/** Fail closed when privilege inspection is unavailable. Never execute user-owned clients as administrator. */
export async function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return process.getuid?.() === 0
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
  { timeout: 5000, windowsHide: true, maxBuffer: 1024 }, (err, out) => resolve(!!err || out.trim() !== 'False')))
}

function simple(entry: any, name: string): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const keys = ['name', 'enabled', 'disabled_reason', 'transport', 'enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec']
  if (Object.keys(entry).some(k => !keys.includes(k)) || entry.enabled !== true || entry.disabled_reason != null) return false
  for (const key of ['enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec']) {
    if (entry[key] != null) return false
  }
  const t = entry.transport
  if (!t || typeof t !== 'object' || Object.keys(t).some(k => !['type', 'command', 'args', 'env', 'env_vars', 'cwd'].includes(k))) return false
  if (t.type !== 'stdio' || typeof t.command !== 'string' || !Array.isArray(t.args) || !t.args.every((a: unknown) => typeof a === 'string')) return false
  if (t.cwd != null || (t.env_vars != null && (!Array.isArray(t.env_vars) || t.env_vars.length > 0))) return false
  if (t.env != null && (typeof t.env !== 'object' || Array.isArray(t.env) || Object.entries(t.env).some(([key, value]) =>
    name !== 'u_chan_secrets' || (key === 'U_CHAN_BROWSER' ? value !== 'chrome' && value !== 'edge' : key === 'U_CHAN_CDP' ? !safeCdpOrigin(value) : true)))) return false
  const command = basename(t.command.replaceAll('\\', '/')).toLowerCase()
  if (name === 'u_chan_secrets') return ['node', 'node.exe'].includes(command) && t.args.length === 1 && /(?:^|[\\/])index\.js$/.test(t.args[0])
  return ['npx', 'npx.cmd', 'npx.exe'].includes(command) && /^@playwright\/mcp(?:@[^\s]+)?$/.test(t.args[0] ?? '')
    && (t.args.length === 1 || (t.args.length === 3 && t.args[1] === '--cdp-endpoint' && !!safeCdpOrigin(t.args[2])))
}

async function backup(configDir: string): Promise<string | undefined> {
  const root = resolve(configDir)
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(root)).toLowerCase() !== root.toLowerCase()) throw new Error('redirected config')
  const config = join(root, 'config.toml')
  try {
    const file = await lstat(config)
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('redirected config')
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err }
  const dir = join(root, '#0 backup')
  await mkdir(dir, { mode: 0o700 }).catch(err => { if (err.code !== 'EEXIST') throw err })
  const target = await lstat(dir)
  if (!target.isDirectory() || target.isSymbolicLink() || (await realpath(dir)).toLowerCase() !== dir.toLowerCase()) throw new Error('redirected backup')
  const path = join(dir, `u-chan-setup-${randomUUID()}.toml`)
  await copyFile(config, path, constants.COPYFILE_EXCL)
  await chmod(path, 0o600)
  return path
}

/** Inspect through the official Codex CLI; never parse or rewrite TOML, or return its contents. */
export async function configureCodex(o: CodexSetupOptions, injected?: CodexSetupDeps): Promise<CodexSetupResult> {
  let changed = false, backupPath: string | undefined
  const result = (state: CodexSetupState, message: string): CodexSetupResult => ({ state, changed, ...(backupPath ? { backupPath } : {}), message })
  const d: CodexSetupDeps = injected ?? { elevated: isElevated, exec: args => new Promise(resolve => {
    execFile('codex', args, { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, CODEX_HOME: o.configDir } },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }))
  }) }
  try {
    if (!safeCdpOrigin(o.endpoint) || (o.replaceExisting && !o.apply)) return result('manual', 'Use a safe loopback browser target and explicit apply flags.')
    if (o.browser !== undefined) browserKind(o.browser)
    if (await d.elevated()) return result('unavailable', 'Run setup from a non-administrator desktop terminal.')
    const desired = [
      { name: 'u_chan_secrets', command: o.nodePath, args: [o.entryPath] },
      { name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest', '--cdp-endpoint', safeCdpOrigin(o.endpoint)!] },
    ]
    const pending: { entry: typeof desired[number]; replace: boolean }[] = []
    for (const entry of desired) {
      const r = await d.exec(['mcp', 'get', entry.name, '--json'])
      if (r.code !== 0) {
        if (r.stderr.trim().split(/\r?\n/).at(-1) !== `Error: No MCP server named '${entry.name}' found.`) return result('unavailable', 'Could not inspect Codex registrations.')
        pending.push({ entry, replace: false }); continue
      }
      const current = JSON.parse(r.stdout)
      const env = current?.transport?.env
      const inherited = current?.transport?.env_vars
      const ipc = o.ipcEndpoint ?? defaultEndpoint(process.env, process.platform)
      if ((env && Object.keys(env).some(key => {
        const name = key.toUpperCase()
        return name === 'U_CHAN_CDP' ? safeCdpOrigin(env[key]) !== safeCdpOrigin(o.endpoint)
          : name === 'U_CHAN_IPC' && env[key] !== ipc
      })) || (Array.isArray(inherited) && inherited.some(key => typeof key === 'string' && ['U_CHAN_CDP','U_CHAN_IPC','U_CHAN_BROWSER'].includes(key.toUpperCase())))) {
        return result('manual', 'Custom target environment preserved; align browser and service targets manually.')
      }
      if (current?.enabled === true && current.transport?.type === 'stdio'
        && current.transport.command === entry.command && JSON.stringify(current.transport.args) === JSON.stringify(entry.args)
        && (entry.name !== 'u_chan_secrets' || o.browser === undefined || (env?.U_CHAN_BROWSER === o.browser && safeCdpOrigin(env?.U_CHAN_CDP) === safeCdpOrigin(o.endpoint)))) continue
      if (!simple(current, entry.name)) return result('manual', 'Custom Codex settings preserved; configure this registration manually.')
      pending.push({ entry, replace: true })
    }
    if (pending.length === 0) return result('ready', 'Codex registrations match; active session ownership is unverified.')
    const replaces = pending.some(p => p.replace)
    if (!o.apply || (replaces && !o.replaceExisting)) return result(replaces ? 'needs_update' : 'missing', 'Explicit setup apply is required; replacements also require --replace-existing.')
    // No whole-file rollback: the official CLI or another process may edit unrelated settings concurrently.
    try { await lstat(o.configDir) } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; await mkdir(o.configDir, { recursive: true, mode: 0o700 }) }
    backupPath = await backup(o.configDir)
    for (const { entry, replace } of pending) {
      if (replace) {
        const removed = await d.exec(['mcp', 'remove', entry.name])
        if (removed.code !== 0) return result('unavailable', 'Codex change failed; inspect configuration before retrying.')
        changed = true
      }
      const browserEnv = entry.name === 'u_chan_secrets' && o.browser ? ['--env', `U_CHAN_BROWSER=${o.browser}`, '--env', `U_CHAN_CDP=${safeCdpOrigin(o.endpoint)}`] : []
      const added = await d.exec(['mcp', 'add', entry.name, ...browserEnv, '--', entry.command, ...entry.args])
      if (added.code !== 0) return result('unavailable', 'Codex change failed; completed changes and backup were retained.')
      changed = true
    }
    return result('ready', 'Codex registrations saved. Restart the AI session; active ownership remains unverified.')
  } catch { return result('unavailable', 'Codex setup unavailable; inspect configuration and any retained backup before retrying.') }
}
