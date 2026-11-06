import { mkdir, readFile, readdir, rename, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { UpdateJournal, noLinks } from './journal.js'
import type { UpdateJob } from './protocol.js'

export interface UpdateWorkerDeps {
  verify(): Promise<void>
  handoff(): Promise<void>
  stopForRollback(): Promise<void>
  startSource(): Promise<void>
  waitReady(kind: 'target' | 'source'): Promise<boolean>
}
export async function runUpdateTransaction(journal: UpdateJournal, id: string, deps: UpdateWorkerDeps): Promise<UpdateJob> {
  const job = await journal.read(id)
  if (job.phase !== 'switching') throw new Error('invalid_update_transition')
  const program = join(journal.home, 'program'), next = join(journal.directory(id), 'next')
  const parent = join(journal.home, '#0 backup'), backup = join(parent, 'update-' + id), failed = join(journal.directory(id), 'failed-program')
  let backedUp = false, activated = false
  try {
    await deps.verify()
    for (const path of [program,next,parent,backup,failed]) await noLinks(path)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    for (const path of [backup,failed]) { try { await lstat(path); throw new Error('recovery_path_exists') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e } }
    const names = await readdir(program), pkg = await readFile(join(program, 'package.json'))
    await rename(program, backup); backedUp = true
    const moved = await readdir(backup)
    if (moved.length !== names.length || names.some(n => !moved.includes(n)) || !(await readFile(join(backup,'package.json'))).equals(pkg)) throw new Error('backup_mismatch')
    await rename(next, program); activated = true
    await journal.transition(id, 'waiting_for_service')
    await deps.handoff()
    if (!await deps.waitReady('target')) throw new Error('startup_failed')
    return await journal.transition(id, 'service_ready')
  } catch {
    if (!backedUp) return journal.transition(id, 'failed', 'worker_failed')
    try {
      await journal.transition(id, 'rolling_back', 'startup_failed')
      await deps.stopForRollback()
      if (activated) await rename(program, failed)
      await rename(backup, program)
      await deps.startSource()
      if (!await deps.waitReady('source')) throw new Error('rollback_start_failed')
      return await journal.transition(id, 'rolled_back', 'startup_failed')
    } catch { return journal.transition(id, 'recovery_required', 'rollback_failed') }
  }
}
