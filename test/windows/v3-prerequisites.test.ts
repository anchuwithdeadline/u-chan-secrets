import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installWindowsService } from '../../src/platform/windows/install.js'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('reinstall preserves owner, phrase, mode and idle timeout and copies dependencies without a junction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucs-v3-install-')); dirs.push(root)
  const home = join(root, 'home'), pkg = join(root, 'package')
  await mkdir(join(pkg, 'dist'), { recursive: true })
  await mkdir(join(pkg, 'node_modules'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), '{"version":"3.0.0"}')
  await writeFile(join(pkg, 'dist', 'index.js'), '// fixture')
  await writeFile(join(pkg, 'node_modules', 'fixture'), 'dependency')
  await mkdir(home)
  const settings = { mode: 'hardcore', phrase: 'existing phrase', idleLockMs: 1234, authorizedSid: 'existing-owner' }
  await writeFile(join(home, 'settings.json'), JSON.stringify(settings))
  const result = await installWindowsService({
    programData: home, packageRoot: pkg, adminCheck: async () => true, getUserSid: async () => 'different-owner',
    stageBrowser: async () => {},
    exec: async () => ({ stdout: '', stderr: '' }),
    serviceManager: { create: vi.fn(), start: vi.fn() } as any,
  })
  expect(result.ok).toBe(true)
  expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))).toEqual(settings)
  expect((await lstat(join(home, 'program', 'node_modules'))).isSymbolicLink()).toBe(false)
  expect(await readFile(join(home, 'program', 'node_modules', 'fixture'), 'utf8')).toBe('dependency')
})
