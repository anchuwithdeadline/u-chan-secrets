import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { ApprovalMode } from '../../core/types.js'
import { generateLaunchdPlist, PLIST_LABEL, PLIST_PATH } from './plist.js'

const execFileAsync = promisify(execFile)

export const defaultExec = async (
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args)
    return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 }
  } catch (err: any) {
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : (err.message ?? String(err)),
      exitCode: typeof err.code === 'number' ? err.code : (err.status ?? 1),
    }
  }
}

const defaultFs = {
  mkdir: (p: string, opts: { recursive?: boolean; mode?: number }) => fs.mkdir(p, opts).then(() => {}),
  writeFile: (p: string, content: string, opts?: { mode?: number }) => fs.writeFile(p, content, opts),
  chmod: (p: string, mode: number) => fs.chmod(p, mode),
  chown: (p: string, uid: number, gid: number) => fs.chown(p, uid, gid),
  rm: (p: string, opts?: { recursive?: boolean; force?: boolean }) => fs.rm(p, opts),
  cp: (src: string, dest: string, opts?: { recursive?: boolean }) => fs.cp(src, dest, opts),
  exists: (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false),
}

const PHRASE_WORDS = [
  'amber', 'badger', 'beacon', 'breeze', 'castle', 'cedar', 'canyon',
  'comet', 'coral', 'crystal', 'delta', 'ember', 'falcon', 'forest', 'galaxy',
  'glacier', 'harbor', 'haven', 'island', 'jasper', 'lagoon', 'lantern', 'meadow',
  'meteor', 'mountain', 'oasis', 'ocean', 'orchid', 'owl', 'pebble', 'phoenix',
  'quartz', 'raven', 'reef', 'river', 'shadow', 'silver', 'summit', 'voyage', 'winter',
]

export function generateRandomPhrase(): string {
  const words: string[] = []
  for (let i = 0; i < 3; i++) {
    words.push(PHRASE_WORDS[crypto.randomInt(PHRASE_WORDS.length)])
  }
  return words.join(' ')
}

export interface LifecycleDeps {
  mode?: ApprovalMode
  phrase?: string
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  fs: {
    mkdir: (path: string, opts: { recursive?: boolean; mode?: number }) => Promise<void>
    writeFile: (path: string, content: string, opts?: { mode?: number }) => Promise<void>
    chmod: (path: string, mode: number) => Promise<void>
    chown: (path: string, uid: number, gid: number) => Promise<void>
    rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>
    cp?: (src: string, dest: string, opts?: { recursive?: boolean }) => Promise<void>
    exists: (path: string) => Promise<boolean>
  }
  getuid: () => number
  env: NodeJS.ProcessEnv
  out: (line: string) => void
  err: (line: string) => void
  nodePath?: string
  serviceScriptPath?: string
  homeDir?: string
  socketDir?: string
  plistPath?: string
  sessionPath?: string
}

const defaultPackageRoot = (): string | null => {
  try {
    return fileURLToPath(new URL('../../../', import.meta.url))
  } catch {
    return null
  }
}

const defaultGetuid = (): number => {
  return typeof process.getuid === 'function' ? process.getuid() : -1
}

export async function macosInstall(deps?: Partial<LifecycleDeps>): Promise<{ ok: boolean; message: string }> {
  const getuid = deps?.getuid ?? defaultGetuid
  if (getuid() !== 0) {
    return { ok: false, message: 'u-chan install on macOS requires root privileges (run with sudo)' }
  }

  if (deps?.mode === 'easy') {
    return { ok: false, message: 'easy mode is not supported on macOS (hardcore mode only)' }
  }

  const env = deps?.env ?? process.env
  const out = deps?.out ?? console.log
  const exec = deps?.exec ?? defaultExec
  const fsOps = { ...defaultFs, ...deps?.fs }

  const sudoUidStr = env.SUDO_UID
  const parsedUid = sudoUidStr ? parseInt(sudoUidStr, 10) : NaN
  const installUid = !Number.isNaN(parsedUid) ? parsedUid : getuid()
  const installUser = env.SUDO_USER || env.USER || 'root'

  const homeDir = deps?.homeDir ?? '/Library/Application Support/u-chan-secrets'
  const programDir = path.posix.join(homeDir, 'program')
  const socketDir = deps?.socketDir ?? '/var/run/u-chan-secrets'
  const plistPath = deps?.plistPath ?? PLIST_PATH

  await fsOps.mkdir(homeDir, { recursive: true, mode: 0o700 })
  await fsOps.mkdir(socketDir, { recursive: true, mode: 0o755 })

  const pkgRoot = defaultPackageRoot()
  if (pkgRoot && (!deps?.fs || deps.fs.cp)) {
    try {
      await fsOps.cp?.(pkgRoot, programDir, { recursive: true })
    } catch {}
  }

  const ownerPath = path.posix.join(homeDir, 'owner.json')
  if (!(await fsOps.exists(ownerPath))) {
    await fsOps.writeFile(ownerPath, JSON.stringify({ installUid, installUser }, null, 2), { mode: 0o600 })
  }

  const settingsPath = path.posix.join(homeDir, 'settings.json')
  if (!(await fsOps.exists(settingsPath))) {
    const phrase = deps?.phrase ?? generateRandomPhrase()
    const settings = {
      mode: 'hardcore',
      phrase,
      idleLockMs: 43200000,
    }
    await fsOps.writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
  }

  const nodePath = deps?.nodePath ?? process.execPath
  const serviceScriptPath = deps?.serviceScriptPath ?? path.posix.join(programDir, 'dist', 'service', 'main.js')
  const outLogPath = path.posix.join(homeDir, 'daemon.out.log')
  const errLogPath = path.posix.join(homeDir, 'daemon.err.log')

  const plistContent = generateLaunchdPlist({
    nodePath,
    serviceScriptPath,
    homeDir,
    outLogPath,
    errLogPath,
  })
  await fsOps.writeFile(plistPath, plistContent, { mode: 0o644 })
  await exec('/bin/launchctl', ['load', '-w', plistPath])

  if (env.SUDO_USER) {
    try {
      const bwRes = await exec('/usr/bin/sudo', ['-u', env.SUDO_USER, 'bw', 'logout'])
      if (bwRes.exitCode !== 0) {
        out(`Warning: Bitwarden CLI logout returned exit code ${bwRes.exitCode}: ${bwRes.stderr}`)
      }
    } catch (e: any) {
      out(`Warning: Bitwarden CLI logout failed: ${e?.message ?? String(e)}`)
    }
  }

  const legacySessionPath = deps?.sessionPath ?? (
    env.U_CHAN_HOME
      ? path.posix.join(env.U_CHAN_HOME, 'bw-session')
      : env.SUDO_USER
        ? `/Users/${env.SUDO_USER}/Library/Application Support/u-chan-secrets/bw-session`
        : path.posix.join(env.HOME ?? '', 'Library', 'Application Support', 'u-chan-secrets', 'bw-session')
  )
  try {
    if (await fsOps.exists(legacySessionPath)) {
      await fsOps.rm(legacySessionPath, { force: true })
    }
  } catch (e: any) {
    out(`Warning: Failed to remove legacy session file at ${legacySessionPath}: ${e?.message ?? String(e)}`)
  }

  return { ok: true, message: 'u-chan service installed successfully' }
}

export async function macosUninstall(deps?: Partial<LifecycleDeps>): Promise<{ ok: boolean; message: string }> {
  const getuid = deps?.getuid ?? defaultGetuid
  if (getuid() !== 0) {
    return { ok: false, message: 'u-chan uninstall on macOS requires root privileges (run with sudo)' }
  }

  const exec = deps?.exec ?? defaultExec
  const fsOps = { ...defaultFs, ...deps?.fs }
  const homeDir = deps?.homeDir ?? '/Library/Application Support/u-chan-secrets'
  const socketDir = deps?.socketDir ?? '/var/run/u-chan-secrets'
  const plistPath = deps?.plistPath ?? PLIST_PATH

  try {
    await exec('/bin/launchctl', ['unload', '-w', plistPath])
  } catch {
    // Ignore errors if service not running
  }

  await fsOps.rm(plistPath, { force: true })
  await fsOps.rm(homeDir, { recursive: true, force: true })
  await fsOps.rm(socketDir, { recursive: true, force: true })

  return { ok: true, message: 'u-chan service uninstalled successfully' }
}
