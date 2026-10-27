#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ControlApi } from './core/types.js'
import { IpcClient } from './ipc/client.js'
import { defaultEndpoint } from './ipc/endpoint.js'
import { MAX_FRAME, encode } from './ipc/protocol.js'

const USAGE = 'usage: u-chan unlock | lock | mode <easy|hardcore> | import-v1 [path]'

export interface CliDeps {
  /** Opens a service client; `timeoutMs` undefined means the IpcClient default. */
  connect: (opts: { timeoutMs?: number }) => ControlApi
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  readFile: (path: string) => Promise<string>
  out: (line: string) => void
  err: (line: string) => void
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
  let call: (() => ReturnType<ControlApi['unlock']>) | undefined
  if (cmd === 'unlock' && arg === undefined) call = () => d.connect({}).unlock()
  else if (cmd === 'lock' && arg === undefined) call = () => d.connect({}).lock()
  else if (cmd === 'mode' && (arg === 'easy' || arg === 'hardcore') && rest.length === 0) call = () => d.connect({}).setMode(arg)
  else if (cmd === 'import-v1' && rest.length === 0) {
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
  }
  if (!call) {
    d.err(USAGE)
    return 1
  }
  const r = await call()
  if (r.ok) d.out(r.message)
  else d.err(r.message)
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
  const code = await main(process.argv.slice(2), {
    connect: (opts) => new IpcClient(defaultEndpoint(process.env, process.platform), opts),
    env: process.env,
    platform: process.platform,
    readFile: (p) => readFile(p, 'utf8'),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  })
  process.exitCode = code
}
