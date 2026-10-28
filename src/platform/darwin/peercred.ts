import { execFile } from 'node:child_process'
import type net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface PeerCredentials {
  uid: number
  gid?: number
  pid?: number
}

export type PeerCredResolver = (socket: net.Socket) => Promise<PeerCredentials | null>

export function parseLsofPeerUid(output: string, selfPid: number = process.pid): PeerCredentials | null {
  let currentPid: number | undefined
  const peerUids = new Set<number>()
  let lastPeerPid: number | undefined

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1))
      currentPid = Number.isInteger(pid) ? pid : undefined
    } else if (line.startsWith('u') && currentPid !== undefined && currentPid !== selfPid) {
      const uid = Number(line.slice(1))
      if (Number.isInteger(uid) && uid >= 0) {
        peerUids.add(uid)
        lastPeerPid = currentPid
      }
    }
  }

  // Only accept when all connected non-service peers belong to a single unambiguous UID
  if (peerUids.size === 1) {
    const [uid] = peerUids
    return { uid, pid: lastPeerPid }
  }
  return null
}

export const resolveDarwinPeerCred: PeerCredResolver = async (
  socket: net.Socket
): Promise<PeerCredentials | null> => {
  if (process.platform !== 'darwin') {
    return null
  }

  const handle = (socket as unknown as { _handle?: { fd?: number; getPeerCredentials?: () => PeerCredentials } })?._handle
  const fd = handle?.fd
  if (typeof fd !== 'number' || fd < 0) {
    return null
  }

  if (typeof handle?.getPeerCredentials === 'function') {
    try {
      const cred = handle.getPeerCredentials()
      if (cred && typeof cred.uid === 'number') {
        return cred
      }
    } catch {
      // ignore and fall back
    }
  }

  const attached = (socket as unknown as { peerCredentials?: PeerCredentials })?.peerCredentials
  if (attached && typeof attached.uid === 'number') {
    return attached
  }

  // Fallback on macOS: inspect Unix domain socket peer processes via /usr/sbin/lsof
  const socketPath = (socket as unknown as { server?: { _pipeName?: string } })?.server?._pipeName
  if (typeof socketPath === 'string' && socketPath.length > 0) {
    try {
      const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-F', 'pu', '--', socketPath], {
        timeout: 3000,
      })
      return parseLsofPeerUid(stdout.toString(), process.pid)
    } catch {
      return null
    }
  }

  return null
}
