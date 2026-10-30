import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, rename, writeFile, lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export type BrowserKind = 'chrome' | 'edge'
export function browserKind(value: unknown): BrowserKind {
  if (value !== 'chrome' && value !== 'edge') throw new Error('Invalid browser selection; choose chrome or edge.')
  return value
}
export function readBrowserChoice(file: string): BrowserKind | undefined {
  try {
    const info = lstatSync(file), parent = resolve(dirname(file))
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(parent).toLowerCase() !== parent.toLowerCase()) throw new Error('redirected')
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || Array.isArray(value) || Object.keys(value).length !== 1) throw new Error('invalid')
    return browserKind(value.browser)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Browser preference could not be read safely; inspect browser.json.')
  }
}
export async function saveBrowserChoice(file: string, choice: BrowserKind): Promise<{ changed: boolean; backupPath?: string }> {
  browserKind(choice)
  const previous = readBrowserChoice(file)
  if (previous === choice) return { changed: false }
  const parent = resolve(dirname(file))
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if ((await lstat(parent)).isSymbolicLink() || (await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw new Error('Redirected browser preference directory.')
  let backupPath: string | undefined
  if (previous !== undefined) {
    const backup = join(parent, '#0 backup')
    await mkdir(backup, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    if ((await lstat(backup)).isSymbolicLink() || (await realpath(backup)).toLowerCase() !== backup.toLowerCase()) throw new Error('Redirected browser backup directory.')
    backupPath = join(backup, `browser-${randomUUID()}.json`)
    await writeFile(backupPath, readFileSync(file), { flag: 'wx', mode: 0o600 })
  }
  const temporary = join(parent, `browser-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify({ browser: choice }) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temporary, file)
  return { changed: true, ...(backupPath ? { backupPath } : {}) }
}
