import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { privateBrowserPath } from '../platform/runtime-assets.js'
import type { VaultClient } from '../core/types.js'
import { bounded, chromeState, safeCdpOrigin, type ServiceDiagnostic, type DiagnosticState } from '../core/doctor.js'
import { checkWindowsPermissions } from '../platform/windows/doctor.js'
import { checkDarwinPermissions } from '../platform/darwin/doctor.js'
export async function diagnoseService(home: string, vault: VaultClient, platform: NodeJS.Platform, cdpEndpoint?: string): Promise<ServiceDiagnostic> {
  const paths = [join(home, 'program', 'dist', 'service', 'main.js'), join(home, 'program', 'node_modules'),
    platform === 'win32' ? join(home, 'bin', 'node.exe') : process.execPath,
    platform === 'win32' ? join(home, 'bin', 'bw.exe') : join(home, 'bin', 'bw')]
  const [assets, permissions, status, browser] = await Promise.all([
    bounded(async (): Promise<DiagnosticState> => {
      await privateBrowserPath(home)
      for (const p of paths) { const s = await lstat(p); if (s.isSymbolicLink()) return 'fail' }
      return 'pass'
    }, 'unknown' as DiagnosticState),
    bounded(() => platform === 'win32' ? checkWindowsPermissions(home) : checkDarwinPermissions(home), 'unknown' as DiagnosticState, 65000),
    bounded(() => vault.status(), 'unavailable' as const),
    cdpEndpoint === undefined ? undefined : bounded(() => chromeState(cdpEndpoint), 'unknown' as DiagnosticState),
  ])
  return { assets, permissions, vault: status === 'unlocked' ? 'pass' : status === 'unavailable' ? 'unknown' : status,
    ...(cdpEndpoint === undefined ? {} : { browser, browserEndpoint: safeCdpOrigin(cdpEndpoint) }) }
}
