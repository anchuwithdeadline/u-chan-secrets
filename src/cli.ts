#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ControlApi } from './core/types.js'
import { IpcClient } from './ipc/client.js'
import { defaultEndpoint } from './ipc/endpoint.js'

const USAGE = 'usage: u-chan unlock | lock | mode <easy|hardcore> | import-v1 [path]'

export interface CliDeps {
  client: ControlApi
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  readFile: (path: string) => Promise<string>
  out: (line: string) => void
  err: (line: string) => void
}

/** V1 kept its allowlist in %APPDATA%\u-chan-secrets (the user's profile). */
function defaultV1Path(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix
  return path.join(env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'u-chan-secrets', 'allowlist.json')
}

/** Returns the process exit code: 0 on success, 1 on failure or bad usage. */
export async function main(argv: string[], d: CliDeps): Promise<number> {
  const [cmd, arg, ...rest] = argv
  let call: (() => ReturnType<ControlApi['unlock']>) | undefined
  if (cmd === 'unlock' && arg === undefined) call = () => d.client.unlock()
  else if (cmd === 'lock' && arg === undefined) call = () => d.client.lock()
  else if (cmd === 'mode' && (arg === 'easy' || arg === 'hardcore') && rest.length === 0) call = () => d.client.setMode(arg)
  else if (cmd === 'import-v1' && rest.length === 0) {
    const path = arg ?? defaultV1Path(d.env, d.platform)
    let entries: unknown
    try {
      entries = JSON.parse(await d.readFile(path))
    } catch {
      d.err(`could not read a V1 allowlist at ${path}`)
      return 1
    }
    if (!Array.isArray(entries)) {
      d.err(`${path} is not a V1 allowlist`)
      return 1
    }
    call = () => d.client.importV1(entries)
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
    client: new IpcClient(defaultEndpoint(process.env, process.platform)),
    env: process.env,
    platform: process.platform,
    readFile: (p) => readFile(p, 'utf8'),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  })
  process.exitCode = code
}
