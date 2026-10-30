import { lstat, mkdir, readFile, rename, realpath } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface WindowsCommandResult { ready: boolean; changed: boolean; message: string; backupPath?: string }

/** Let PowerShell resolve the npm .cmd launcher without changing execution policy or loading a profile. */
export async function configureWindowsCommand(apply: boolean, searchPath: string): Promise<WindowsCommandResult> {
  const result = (ready: boolean, message: string): WindowsCommandResult => ({ ready, changed: false, message })
  try {
    for (const entry of searchPath.split(delimiter).filter(Boolean)) {
      const directory = resolve(entry.replace(/^"|"$/g, ''))
      const script = join(directory, 'u-chan.ps1'), command = join(directory, 'u-chan.cmd')
      const exists = async (file: string) => {
        try { return await lstat(file) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      }
      const ps = await exists(script), cmd = await exists(command)
      if (!ps && !cmd) continue
      if (!cmd?.isFile() || cmd.isSymbolicLink() || (ps && (!ps.isFile() || ps.isSymbolicLink()))) {
        return result(false, 'Custom or redirected u-chan launcher preserved; use u-chan.cmd unlock.')
      }
      const batch = await readFile(command, 'utf8')
      if (!batch.includes('"%dp0%\\node_modules\\u-chan-secrets\\dist\\cli.js" %*')) {
        return result(false, 'Unrecognized u-chan launcher preserved; inspect command installation manually.')
      }
      if (!ps) return result(true, 'PowerShell can use the u-chan.cmd launcher as u-chan.')
      const source = await readFile(script, 'utf8')
      if (!source.startsWith('#!/usr/bin/env pwsh') || !source.includes('"$basedir/node_modules/u-chan-secrets/dist/cli.js" $args') || !source.trimEnd().endsWith('exit $ret')) {
        return result(false, 'Custom PowerShell launcher preserved; use u-chan.cmd unlock.')
      }
      if (!apply) return result(false, 'Run u-chan.cmd setup --apply to make u-chan work without PowerShell scripts.')
      if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error('Redirected launcher directory.')
      const backupDirectory = join(directory, '#0 backup')
      await mkdir(backupDirectory, { recursive: true })
      if ((await lstat(backupDirectory)).isSymbolicLink() || (await realpath(backupDirectory)).toLowerCase() !== backupDirectory.toLowerCase()) throw new Error('Redirected backup directory.')
      const backupPath = join(backupDirectory, `u-chan-${randomUUID()}.ps1`)
      await rename(script, backupPath)
      return { ready: true, changed: true, backupPath, message: 'PowerShell now uses u-chan.cmd as u-chan; original .ps1 launcher retained in #0 backup.' }
    }
    return result(true, 'No npm u-chan launcher found on PATH; source checkout commands remain unchanged.')
  } catch {
    return result(false, 'Could not configure the PowerShell command; use u-chan.cmd unlock and inspect launcher permissions.')
  }
}
