import type net from 'node:net'
import { UserFacingError, type ProtectedPrompt } from '../core/types.js'
import { windowsPlatformAdapters } from './windows/index.js'
import { createDarwinAuthorizer } from './darwin/authorize.js'
import type { PeerCredResolver } from './darwin/peercred.js'

export interface PlatformAdapters {
  prompt: ProtectedPrompt
  /** Decides whether the process on the other end of `socket` may call the service. */
  authorize: (socket: net.Socket) => Promise<boolean>
}

export interface PlatformAdapterOptions {
  home?: string
  installUid?: number
  resolvePeerCred?: PeerCredResolver
  execPrompt?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; exitCode: number }>
  settingsPath?: string
  binDir?: string
}

export function darwinPlatformAdapters(opts?: PlatformAdapterOptions): PlatformAdapters {
  const authorize = createDarwinAuthorizer({
    installUid: opts?.installUid,
    resolvePeerCred: opts?.resolvePeerCred,
  })
  const prompt: ProtectedPrompt = {
    confirm: async () => {
      throw new UserFacingError('click-to-approve easy mode is disabled on macOS')
    },
    askPassword: async () => {
      throw new UserFacingError('macOS protected prompt not implemented yet')
    },
  }
  return { prompt, authorize }
}

/** Platform prompt and caller check. Plans 2–3 provide Windows and macOS. */
export function platformAdapters(platform: NodeJS.Platform, opts?: PlatformAdapterOptions): PlatformAdapters {
  if (platform === 'win32') {
    return windowsPlatformAdapters(opts)
  }
  if (platform === 'darwin') {
    return darwinPlatformAdapters(opts)
  }
  throw new UserFacingError(`U-Chan V2 is not supported on ${platform} yet`)
}
