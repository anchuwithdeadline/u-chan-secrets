import fs from 'node:fs/promises'
import type net from 'node:net'
import { resolveDarwinPeerCred, type PeerCredResolver } from './peercred.js'

export const DEFAULT_OWNER_PATH = '/Library/Application Support/u-chan-secrets/owner.json'

export interface AuthorizeOptions {
  ownerPath?: string
  installUid?: number
  resolvePeerCred?: PeerCredResolver
}

export async function readInstallUid(ownerPath: string = DEFAULT_OWNER_PATH): Promise<number | null> {
  try {
    const raw = await fs.readFile(ownerPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.installUid === 'number' && Number.isInteger(parsed.installUid) && parsed.installUid >= 0) {
      return parsed.installUid
    }
    return null
  } catch {
    return null
  }
}

export function createDarwinAuthorizer(opts?: AuthorizeOptions): (socket: net.Socket) => Promise<boolean> {
  const resolve = opts?.resolvePeerCred ?? resolveDarwinPeerCred

  return async (socket: net.Socket): Promise<boolean> => {
    try {
      const expectedUid =
        opts?.installUid !== undefined
          ? opts.installUid
          : await readInstallUid(opts?.ownerPath ?? DEFAULT_OWNER_PATH)

      if (expectedUid === null || expectedUid === undefined) {
        return false
      }

      const cred = await resolve(socket)
      if (!cred || typeof cred.uid !== 'number') {
        return false
      }

      return cred.uid === expectedUid
    } catch {
      return false
    }
  }
}
