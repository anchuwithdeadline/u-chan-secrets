import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { VaultClient } from '../core/types.js'
import { bounded, type ServiceDiagnostic, type DiagnosticState } from '../core/doctor.js'
import { checkWindowsPermissions } from '../platform/windows/doctor.js'
import { checkDarwinPermissions } from '../platform/darwin/doctor.js'
export async function diagnoseService(home: string, vault: VaultClient, platform: NodeJS.Platform): Promise<ServiceDiagnostic> {
  const paths = [join(home, 'program', 'dist', 'service', 'main.js'), join(home, 'program', 'node_modules'), chromium.executablePath(),
    platform === 'win32' ? join(home, 'bin', 'node.exe') : process.execPath,
    platform === 'win32' ? join(home, 'bin', 'bw.exe') : '/usr/local/bin/bw']
  const [assets, permissions, status] = await Promise.all([
    bounded(async (): Promise<DiagnosticState> => {
      for (const p of paths) { const s = await lstat(p); if (s.isSymbolicLink()) return 'fail' }
      return 'pass'
    }, 'unknown' as DiagnosticState),
    bounded(() => platform === 'win32' ? checkWindowsPermissions(home) : checkDarwinPermissions(home), 'unknown' as DiagnosticState),
    bounded(() => vault.status(), 'unavailable' as const),
  ])
  return { assets, permissions, vault: status === 'unlocked' ? 'pass' : status === 'unavailable' ? 'unknown' : status }
}
