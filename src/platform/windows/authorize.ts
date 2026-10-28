import type net from 'node:net'
import { defaultExec, type ExecFn } from './acl.js'

export interface AuthorizerOptions {
  authorizedSid: string
  authExePath?: string
  serverPid?: number
  getClientSid?: (socket: net.Socket) => Promise<string | null>
  execFile?: ExecFn
}

export function createWindowsAuthorizer(
  opts: AuthorizerOptions
): (socket: net.Socket) => Promise<boolean> {
  const getClientSid =
    opts.getClientSid ??
    ((socket: net.Socket) =>
      queryPipeClientSid(socket, {
        authExePath: opts.authExePath!,
        serverPid: opts.serverPid ?? process.pid,
        execFile: opts.execFile,
      }))

  return async (socket: net.Socket): Promise<boolean> => {
    try {
      const clientSid = await getClientSid(socket)
      try {
        const fsMod = await import('node:fs')
        fsMod.appendFileSync('D:\\NorthStar.AG\\u-chan-secrets\\auth-debug.log', `[AUTH] clientSid=${clientSid} authorizedSid=${opts.authorizedSid}\n`)
      } catch {}
      if (!clientSid) return false
      const ok = clientSid.toLowerCase() === opts.authorizedSid.toLowerCase()
      if (!ok) console.error(`caller SID ${clientSid} != authorized ${opts.authorizedSid || '(empty)'}`)
      return ok
    } catch {
      return false
    }
  }
}

export async function queryPipeClientSid(
  socket: net.Socket,
  opts: { authExePath: string; serverPid: number; execFile?: ExecFn }
): Promise<string | null> {
  const exec = opts.execFile ?? defaultExec
  // libuv exposes the pipe HANDLE value as fd on Windows; it identifies exactly this connection.
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd
  const args = [String(opts.serverPid), 'dummy']
  if (typeof fd === 'number' && fd > 0) args.push(String(fd))
  try {
    const { stdout, stderr } = await exec(opts.authExePath, args)
    try {
      const fsMod = await import('node:fs')
      fsMod.appendFileSync('D:\\NorthStar.AG\\u-chan-secrets\\auth-debug.log', `[QUERY] args=${JSON.stringify(args)} stdout=${stdout.trim()} stderr=${stderr.trim()}\n`)
    } catch {}
    const match = stdout.match(/AUTHORIZED:(S-[0-9-]+)/i)
    if (match && match[1]) {
      return match[1]
    }
    console.error(`auth-helper gave no SID: ${stdout.trim()}`)
    return null
  } catch (err: any) {
    try {
      const fsMod = await import('node:fs')
      fsMod.appendFileSync('D:\\NorthStar.AG\\u-chan-secrets\\auth-debug.log', `[QUERY-ERR] ${String(err?.stderr ?? err?.message ?? err).trim()}\n`)
    } catch {}
    console.error(`auth-helper failed: ${String(err?.stderr ?? err?.message ?? err).trim()}`)
    return null
  }
}
