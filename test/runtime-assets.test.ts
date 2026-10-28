import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageBrowser, privateBrowserPath } from '../src/platform/runtime-assets.js'
const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
it('copies the complete browser bundle and resolves only a service-private executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucs-assets-')); dirs.push(root)
  const source = join(root, 'download', 'chrome.exe'), home = join(root, 'service')
  await mkdir(join(root, 'download'), { recursive: true })
  await writeFile(source, 'binary')
  await writeFile(join(root, 'download', 'resources'), 'assets')
  await stageBrowser(home, source)
  const executable = await privateBrowserPath(home)
  expect(executable).toBe(await realpath(join(home, 'bin', 'browser', 'chrome.exe')))
  expect(await readFile(executable, 'utf8')).toBe('binary')
  expect(await readFile(join(home, 'bin', 'browser', 'resources'), 'utf8')).toBe('assets')
  await writeFile(join(home, 'browser-executable.txt'), '../outside.exe')
  await expect(privateBrowserPath(home)).rejects.toThrow(/private browser/)
})
