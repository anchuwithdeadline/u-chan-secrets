import child_process from 'node:child_process'
import { UserFacingError } from '../../core/types.js'

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

export const defaultExec: ExecFn = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    child_process.execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: stdout ?? '', stderr: stderr ?? '' }))
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    })
  })
}

export async function setAdminOnlyAcl(dirPath: string, exec: ExecFn = defaultExec): Promise<void> {
  try {
    const { stdout, stderr } = await exec('icacls.exe', [
      dirPath,
      '/inheritance:r',
      '/grant:r',
      'SYSTEM:(OI)(CI)F',
      'Administrators:(OI)(CI)F',
    ])
    if (/Failed processing [1-9]/i.test(stdout) || /Failed processing [1-9]/i.test(stderr)) {
      throw new Error(`icacls failed: ${stdout || stderr}`)
    }
  } catch (err: any) {
    if (err instanceof UserFacingError) {
      throw err
    }
    throw new UserFacingError(
      `Failed to set administrator-only permissions on ${dirPath}: ${err?.message ?? String(err)}`
    )
  }
}
