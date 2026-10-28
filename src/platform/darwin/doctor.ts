import { lstat } from 'node:fs/promises'
import { commandState, type DiagnosticState } from '../../core/doctor.js'
import { PLIST_LABEL } from './plist.js'
export const checkDarwinRegistration = () => commandState('/bin/launchctl', ['print', 'system/' + PLIST_LABEL], s => s.includes('state ='))
export async function checkDarwinPermissions(home: string): Promise<DiagnosticState> {
  try { const s = await lstat(home); return s.uid === 0 && (s.mode & 0o022) === 0 && !s.isSymbolicLink() ? 'pass' : 'fail' }
  catch { return 'unknown' }
}
