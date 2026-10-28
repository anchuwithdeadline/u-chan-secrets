import type net from 'node:net'
import { posix } from 'node:path'
import { UserFacingError, type ProtectedPrompt } from '../core/types.js'
import { windowsPlatformAdapters } from './windows/index.js'
import { createDarwinAuthorizer } from './darwin/authorize.js'
import { MacosProtectedPrompt } from './darwin/prompt.js'
import type { PeerCredResolver } from './darwin/peercred.js'

export interface PlatformAdapters {
  prompt: ProtectedPrompt
  /** Decides whether the process on the other end of `socket` may call the service. */
  authorize: (socket: net.Socket) => Promise<boolean>
}

export interface PlatformAdapterOptions {
  home?: string
  ownerPath?: string
  installUid?: number
  resolvePeerCred?: PeerCredResolver
  execPrompt?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; exitCode: number }>
  settingsPath?: string
  binDir?: string
}

export function darwinPlatformAdapters(opts?: PlatformAdapterOptions): PlatformAdapters {
  const ownerPath = opts?.ownerPath ?? (opts?.home ? posix.join(opts.home, 'owner.json') : undefined)
  const authorize = createDarwinAuthorizer({
    ownerPath,
    installUid: opts?.installUid,
    resolvePeerCred: opts?.resolvePeerCred,
  })
  const executor = opts?.execPrompt ? { exec: opts.execPrompt } : undefined
  const prompt = new MacosProtectedPrompt({
    ownerPath,
    installUid: opts?.installUid,
    executor,
  })
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
  throw new UserFacingError(`U-Chan V3 is not supported on ${platform} yet`)
}
