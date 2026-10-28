import type net from 'node:net'

export interface PeerCredentials {
  uid: number
  gid?: number
  pid?: number
}

export type PeerCredResolver = (socket: net.Socket) => Promise<PeerCredentials | null>

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
      // ignore and return null
    }
  }

  const attached = (socket as unknown as { peerCredentials?: PeerCredentials })?.peerCredentials
  if (attached && typeof attached.uid === 'number') {
    return attached
  }

  return null
}
