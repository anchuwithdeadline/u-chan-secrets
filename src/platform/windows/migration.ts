import fs from 'node:fs/promises'
import path from 'node:path'
import { defaultExec, type ExecFn } from './acl.js'

export interface MigrationResult {
  bwLoggedOut: boolean
  sessionFileRemoved: boolean
  warning?: string
}

const defaultFileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

const defaultUnlink = async (filePath: string): Promise<void> => {
  await fs.unlink(filePath)
}

export async function migrateBitwarden(opts: {
  exec?: ExecFn
  unlink?: (path: string) => Promise<void>
  fileExists?: (path: string) => Promise<boolean>
  sessionPath?: string
} = {}): Promise<MigrationResult> {
  const exec = opts.exec ?? defaultExec
  const unlink = opts.unlink ?? defaultUnlink
  const fileExists = opts.fileExists ?? defaultFileExists
  const sessionPath = opts.sessionPath ?? path.join(process.env.APPDATA ?? '', 'u-chan-secrets', 'bw-session')

  let bwLoggedOut = false
  let warning: string | undefined

  try {
    await exec('bw', ['logout'])
    bwLoggedOut = true
  } catch (err: any) {
    warning = `Bitwarden CLI logout skipped or failed: ${err?.message ?? String(err)}`
  }

  let sessionFileRemoved = false
  try {
    if (await fileExists(sessionPath)) {
      await unlink(sessionPath)
      sessionFileRemoved = true
    }
  } catch (err: any) {
    const unlinkWarn = `Failed to remove legacy session file at ${sessionPath}: ${err?.message ?? String(err)}`
    warning = warning ? `${warning}; ${unlinkWarn}` : unlinkWarn
  }

  const result: MigrationResult = {
    bwLoggedOut,
    sessionFileRemoved,
  }
  if (warning !== undefined) {
    result.warning = warning
  }
  return result
}
