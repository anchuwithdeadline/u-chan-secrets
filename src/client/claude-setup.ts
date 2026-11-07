import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { safeCdpOrigin } from '../core/doctor.js'
import { defaultEndpoint } from '../ipc/endpoint.js'
import { browserKind, type BrowserKind } from './browser-choice.js'
import { backupFile, hasLegacyEnv, isElevated, LEGACY_ENV, type CodexSetupResult, type CodexSetupState } from './codex-setup.js'

export interface ClaudeSetupOptions {
  apply: boolean; replaceExisting: boolean; endpoint: string; nodePath: string; entryPath: string
  /** Claude Code's user config file (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`). */
  configPath: string
  /** Directory that receives `#0 backup` (`~/.claude`, or `$CLAUDE_CONFIG_DIR`). */
  configDir: string
  ipcEndpoint?: string
  browser?: BrowserKind
}
interface ExecResult { code: number; stdout: string; stderr: string }
export interface ClaudeSetupDeps { elevated: () => Promise<boolean>; exec: (args: string[]) => Promise<ExecResult>; read: (path: string) => Promise<string> }
interface Server { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }

function simple(entry: any, name: string): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (Object.keys(entry).some(k => !['type', 'command', 'args', 'env'].includes(k)) || (entry.type ?? 'stdio') !== 'stdio') return false
  if (typeof entry.command !== 'string' || !Array.isArray(entry.args) || !entry.args.every((a: unknown) => typeof a === 'string')) return false
  if (entry.env != null && (typeof entry.env !== 'object' || Array.isArray(entry.env) || Object.entries(entry.env).some(([key, value]) =>
    name !== 'u-chan-secrets' || (LEGACY_ENV.includes(key) ? false : key === 'U_CHAN_BROWSER' ? value !== 'chrome' && value !== 'edge' : key === 'U_CHAN_CDP' ? !safeCdpOrigin(value) : true)))) return false
  const command = basename(entry.command.replaceAll('\\', '/')).toLowerCase()
  if (name === 'u-chan-secrets') return ['node', 'node.exe'].includes(command) && entry.args.length === 1 && /(?:^|[\\/])index\.js$/.test(entry.args[0])
  return ['npx', 'npx.cmd', 'npx.exe'].includes(command) && /^@playwright\/mcp(?:@[^\s]+)?$/.test(entry.args[0] ?? '')
    && (entry.args.length === 1 || (entry.args.length === 3 && entry.args[1] === '--cdp-endpoint' && !!safeCdpOrigin(entry.args[2])))
}

/** Inspect Claude Code's user-scope JSON read-only; every change goes through the official `claude mcp` CLI. */
export async function configureClaude(o: ClaudeSetupOptions, injected?: ClaudeSetupDeps): Promise<CodexSetupResult> {
  let changed = false, backupPath: string | undefined
  const result = (state: CodexSetupState, message: string): CodexSetupResult => ({ state, changed, ...(backupPath ? { backupPath } : {}), message })
  const d: ClaudeSetupDeps = injected ?? { elevated: isElevated, read: path => readFile(path, 'utf8'), exec: args => new Promise(resolve => {
    execFile('claude', args, { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }))
  }) }
  try {
    const origin = safeCdpOrigin(o.endpoint)
    if (!origin || (o.replaceExisting && !o.apply)) return result('manual', 'Use a safe loopback browser target and explicit apply flags.')
    if (o.browser !== undefined) browserKind(o.browser)
    if (await d.elevated()) return result('unavailable', 'Run setup from a non-administrator desktop terminal.')
    let servers: Record<string, unknown> = {}
    try {
      const text = await d.read(o.configPath)
      const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
      if (!parsed || typeof parsed !== 'object') return result('unavailable', 'Could not inspect Claude Code registrations.')
      servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return result('unavailable', 'Could not inspect Claude Code registrations.')
    }
    const env: Record<string, string> = o.browser ? { U_CHAN_BROWSER: o.browser, U_CHAN_CDP: origin } : {}
    const desired: { name: string; server: Server }[] = [
      { name: 'u-chan-secrets', server: { type: 'stdio', command: o.nodePath, args: [o.entryPath], env } },
      { name: 'playwright', server: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest', '--cdp-endpoint', origin], env: {} } },
    ]
    const ipc = o.ipcEndpoint ?? defaultEndpoint(process.env, process.platform)
    const pending: { name: string; server: Server; replace: boolean }[] = []
    for (const { name, server } of desired) {
      const current = servers[name] as any
      if (current === undefined) { pending.push({ name, server, replace: false }); continue }
      const curEnv = current?.env && typeof current.env === 'object' ? current.env : {}
      if (Object.keys(curEnv).some(key => {
        const k = key.toUpperCase()
        return k === 'U_CHAN_CDP' ? safeCdpOrigin(curEnv[key]) !== origin : k === 'U_CHAN_IPC' && curEnv[key] !== ipc
      })) return result('manual', 'Custom target environment preserved; align browser and service targets manually.')
      if ((current?.type ?? 'stdio') === 'stdio' && current?.command === server.command && JSON.stringify(current.args) === JSON.stringify(server.args) && !hasLegacyEnv(curEnv)
        && (name !== 'u-chan-secrets' || o.browser === undefined || (curEnv.U_CHAN_BROWSER === o.browser && safeCdpOrigin(curEnv.U_CHAN_CDP) === origin))) continue
      if (!simple(current, name)) return result('manual', 'Custom Claude Code settings preserved; configure this registration manually.')
      pending.push({ name, server, replace: true })
    }
    if (pending.length === 0) return result('ready', 'Claude Code registrations match; active session ownership is unverified.')
    const replaces = pending.some(p => p.replace)
    if (!o.apply || (replaces && !o.replaceExisting)) return result(replaces ? 'needs_update' : 'missing', 'Explicit setup apply is required; replacements also require --replace-existing.')
    backupPath = await backupFile(o.configPath, join(o.configDir, '#0 backup'), '.json')
    for (const { name, server, replace } of pending) {
      if (replace) {
        if ((await d.exec(['mcp', 'remove', '--scope', 'user', name])).code !== 0) return result('unavailable', 'Claude Code change failed; inspect configuration before retrying.')
        changed = true
      }
      if ((await d.exec(['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(server)])).code !== 0) return result('unavailable', 'Claude Code change failed; completed changes and backup were retained.')
      changed = true
    }
    return result('ready', 'Claude Code registrations saved. Restart the AI session; active ownership remains unverified.')
  } catch { return result('unavailable', 'Claude Code setup unavailable; inspect configuration and any retained backup before retrying.') }
}
