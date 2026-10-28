import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { chromium } from 'playwright'
import { UserFacingError } from '../core/types.js'

export async function stageBrowser(home: string, source = chromium.executablePath()): Promise<void> {
  let bundle = dirname(source)
  for (let p = bundle; p !== dirname(p); p = dirname(p)) {
    if (p.endsWith('.app')) { bundle = p; break }
  }
  const destination = join(home, 'bin', 'browser')
  const existing = await lstat(destination).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return undefined })
  if (existing?.isSymbolicLink()) throw new UserFacingError('private browser destination cannot be a link')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await cp(bundle, destination, { recursive: true, dereference: true })
  await writeFile(join(home, 'browser-executable.txt'), relative(bundle, source), { mode: 0o600 })
}
export async function privateBrowserPath(home: string): Promise<string> {
  try {
    const root = join(home, 'bin', 'browser')
    const value = (await readFile(join(home, 'browser-executable.txt'), 'utf8')).trim()
    if (!value || isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('path')
    const resolvedRoot = await realpath(root), resolved = await realpath(join(root, value))
    const rel = relative(resolvedRoot, resolved)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('outside')
    return resolved
  } catch { throw new UserFacingError('private browser is missing or invalid; repair the trusted installation') }
}
