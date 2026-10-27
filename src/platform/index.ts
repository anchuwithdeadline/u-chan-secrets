import type net from 'node:net'
import { UserFacingError, type ProtectedPrompt } from '../core/types.js'

export interface PlatformAdapters {
  prompt: ProtectedPrompt
  /** Decides whether the process on the other end of `socket` may call the service. */
  authorize: (socket: net.Socket) => Promise<boolean>
}

/** Platform prompt and caller check. Plans 2–3 provide Windows and macOS. */
export function platformAdapters(platform: NodeJS.Platform): PlatformAdapters {
  throw new UserFacingError(`U-Chan V2 is not supported on ${platform} yet`)
}
