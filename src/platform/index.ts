import type net from 'node:net'
import { UserFacingError, type ProtectedPrompt } from '../core/types.js'
import { windowsPlatformAdapters } from './windows/index.js'

export interface PlatformAdapters {
  prompt: ProtectedPrompt
  /** Decides whether the process on the other end of `socket` may call the service. */
  authorize: (socket: net.Socket) => Promise<boolean>
}

/** Platform prompt and caller check. Plans 2–3 provide Windows and macOS. */
export function platformAdapters(platform: NodeJS.Platform): PlatformAdapters {
  if (platform === 'win32') {
    return windowsPlatformAdapters()
  }
  throw new UserFacingError(`U-Chan V2 is not supported on ${platform} yet`)
}
