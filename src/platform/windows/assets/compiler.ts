import path from 'node:path'
import fs from 'node:fs/promises'
import { defaultExec, type ExecFn } from '../acl.js'
import { UserFacingError } from '../../../core/types.js'

export interface CompileOptions {
  outputType?: 'ConsoleApplication' | 'WindowsApplication'
  referencedAssemblies?: string[]
  exec?: ExecFn
}

export async function compileCsharp(
  source: string,
  outputPath: string,
  opts?: CompileOptions
): Promise<void> {
  const exec = opts?.exec ?? defaultExec
  const outputType = opts?.outputType ?? 'ConsoleApplication'
  const refs =
    opts?.referencedAssemblies && opts.referencedAssemblies.length > 0
      ? ` -ReferencedAssemblies @(${opts.referencedAssemblies.map((r) => `'${r.replace(/'/g, "''")}'`).join(', ')})`
      : ''

  const escapedOut = outputPath.replace(/'/g, "''")

  const script = `$ErrorActionPreference = 'Stop'
$source = @'
${source}
'@
Add-Type -TypeDefinition $source -OutputAssembly '${escapedOut}' -OutputType ${outputType}${refs}`

  try {
    const dir = path.dirname(outputPath)
    if (dir && dir !== '.') {
      await fs.mkdir(dir, { recursive: true }).catch(() => {})
    }

    const { stderr } = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ])

    if (stderr && /error|failed/i.test(stderr)) {
      throw new Error(stderr)
    }
  } catch (err: any) {
    if (err instanceof UserFacingError) {
      throw err
    }
    let detail =
      err?.stderr && typeof err.stderr === 'string' && err.stderr.trim().length > 0
        ? err.stderr.trim()
        : err?.message || String(err)
    if (detail.startsWith('Command failed:')) {
      const firstLine = detail.split(/\r?\n/)[0] ?? 'Command failed'
      detail = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine
    }
    throw new UserFacingError(`C# compilation failed: ${detail}`)
  }
}
