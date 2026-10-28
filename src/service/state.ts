import { chmod, cp, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { UserFacingError } from '../core/types.js'
import { setAdminOnlyAcl } from '../platform/windows/acl.js'
import { checkWindowsPermissions } from '../platform/windows/doctor.js'
import { checkDarwinPermissions } from '../platform/darwin/doctor.js'

async function marker(home: string): Promise<{ schema: number; minimumServiceMajor: number } | undefined> {
  try {
    const path = join(home, 'schema.json')
    if ((await lstat(path)).isSymbolicLink()) throw new Error('link')
    const m = JSON.parse(await readFile(path, 'utf8'))
    if (m.schema !== 3 || m.minimumServiceMajor !== 3) throw new Error('schema')
    return m
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new UserFacingError('protected schema marker is invalid; repair state before continuing')
  }
}
export async function assertCompatibleState(home: string, targetMajor: number): Promise<void> {
  const m = await marker(home)
  if (m && (!Number.isSafeInteger(targetMajor) || targetMajor < m.minimumServiceMajor)) throw new UserFacingError('downgrade refused: restore the pre-V3 backup explicitly before installing V2')
}
async function protect(path: string): Promise<void> {
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink()) throw new UserFacingError('protected state path must be a private directory')
  if (process.platform === 'win32') {
    await setAdminOnlyAcl(path)
    if (await checkWindowsPermissions(path) !== 'pass') throw new UserFacingError('could not verify private backup permissions')
  } else {
    await chmod(path, 0o700)
    if (await checkDarwinPermissions(path) !== 'pass') throw new UserFacingError('could not verify private backup ownership')
  }
}
export async function ensureV3State(home: string, secureDirectory: (path: string) => Promise<void> = protect): Promise<void> {
  if (await marker(home)) return
  // Permissions are established before any protected contents are copied.
  await secureDirectory(home)
  const parent = join(home, '#0 backup'), backup = join(parent, 'v2-before-v3')
  await mkdir(parent, { mode: 0o700, recursive: true })
  await secureDirectory(parent)
  const existing = await lstat(backup).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return undefined })
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new UserFacingError('pre-V3 backup path is unsafe')
    try { if ((await readFile(join(backup, 'complete'), 'utf8')) !== '3') throw new Error('invalid') }
    catch { throw new UserFacingError('pre-V3 backup is incomplete; inspect it before retrying') }
  } else {
    await mkdir(backup, { mode: 0o700 })
    await secureDirectory(backup)
    for (const name of ['allowlist.json', 'settings.json', 'owner.json', 'audit.log', 'bw-data']) {
      const source = join(home, name)
      try { await lstat(source) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
      await cp(source, join(backup, name), { recursive: true, filter: async p => {
        if ((await lstat(p)).isSymbolicLink()) throw new UserFacingError('protected backup refuses symbolic links')
        return true
      } })
    }
    await writeFile(join(backup, 'complete'), '3', { mode: 0o600, flag: 'wx' })
  }
  const tmp = join(home, 'schema.json.tmp')
  await writeFile(tmp, JSON.stringify({ schema: 3, minimumServiceMajor: 3 }), { mode: 0o600 })
  await rename(tmp, join(home, 'schema.json'))
}
