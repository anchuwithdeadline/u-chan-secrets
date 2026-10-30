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
  await mkdir(join(pkg, 'scripts'))
  for (const file of ['start-browser.ps1', 'desktop-browser.ps1']) await writeFile(join(pkg, 'scripts', file), '# fixture')
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
it('stops an existing service before staging and reuses its registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucs-v3-reinstall-')); dirs.push(root)
  const home = join(root, 'home'), pkg = join(root, 'package')
  await mkdir(join(pkg, 'dist'), { recursive: true })
  await mkdir(join(pkg, 'node_modules'), { recursive: true })
  await mkdir(join(pkg, 'scripts'))
  for (const file of ['start-browser.ps1', 'desktop-browser.ps1']) await writeFile(join(pkg, 'scripts', file), '# fixture')
  await mkdir(join(home, 'program', 'dist'), { recursive: true })
  await writeFile(join(home, 'program', 'dist', 'index.js'), 'old')
  await writeFile(join(pkg, 'package.json'), '{"version":"3.0.0"}')
  await writeFile(join(pkg, 'dist', 'index.js'), 'new')
  let stopped = false, created = false, started = false
  const result = await installWindowsService({
    programData: home, packageRoot: pkg, adminCheck: async () => true, stageBrowser: async () => {},
    getUserSid: async () => 'owner', exec: async () => ({ stdout: '', stderr: '' }),
    serviceManager: {
      status: async () => stopped ? 'stopped' : 'running',
      stop: async () => { expect(await readFile(join(home, 'program', 'dist', 'index.js'), 'utf8')).toBe('old'); stopped = true },
      create: async () => { created = true },
      start: async () => { started = true },
    } as any,
  })
  expect(result.ok).toBe(true)
  expect(stopped).toBe(true)
  expect(created).toBe(false)
  expect(started).toBe(true)
})
