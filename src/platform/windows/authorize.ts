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
      if (!clientSid) return false
      return clientSid.toLowerCase() === opts.authorizedSid.toLowerCase()
    } catch {
      return false
    }
  }
}

export async function queryPipeClientSid(
  _socket: net.Socket,
  opts: { authExePath: string; serverPid: number; execFile?: ExecFn }
): Promise<string | null> {
  const exec = opts.execFile ?? defaultExec
  try {
    const { stdout } = await exec(opts.authExePath, [String(opts.serverPid), 'dummy'])
    const match = stdout.match(/AUTHORIZED:(S-[0-9-]+)/i)
    if (match && match[1]) {
      return match[1]
    }
    return null
  } catch {
    return null
  }
}
