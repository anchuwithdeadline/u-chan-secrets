import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceUpdater } from '../src/service/update/updater.js'
import type { PackageVerifier, ServiceRestarter } from '../src/core/types.js'

describe('ServiceUpdater', () => {
  let rootDir: string
  let programDir: string
  let stagingDir: string
  let restarter: ServiceRestarter
  let verifier: PackageVerifier

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'ucs-update-'))
    programDir = join(rootDir, 'program')
    stagingDir = join(rootDir, 'staging')

    await mkdir(programDir, { recursive: true })
    await writeFile(join(programDir, 'package.json'), JSON.stringify({ name: 'u-chan-secrets', version: '2.0.0' }))
    await mkdir(join(programDir, 'dist'), { recursive: true })
    await writeFile(join(programDir, 'dist', 'index.js'), 'console.log("v2.0.0 index")')
    await writeFile(join(programDir, 'dist', 'cli.js'), 'console.log("v2.0.0 cli")')

    restarter = {
      restart: vi.fn(async () => {}),
    }

    verifier = {
      checkLatest: vi.fn(async () => ({ isNewer: true, latestVersion: '2.1.0' })),
      verify: vi.fn(async () => ({
        ok: true,
        targetVersion: '2.1.0',
        tarball: Buffer.from('mock-tarball'),
      })),
    }
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('reports already up to date when no newer version', async () => {
    vi.mocked(verifier.checkLatest).mockResolvedValue({ isNewer: false, latestVersion: '2.0.0' })

    const updater = new ServiceUpdater({
      verifier,
      restarter,
      programDir,
      stagingDir,
      currentVersion: '2.0.0',
    })

    const res = await updater.update()
    expect(res).toEqual({ ok: true, message: 'already up to date (version 2.0.0)' })
    expect(verifier.verify).not.toHaveBeenCalled()
    expect(restarter.restart).not.toHaveBeenCalled()
  })

  it('stages verified package, validates files, and performs atomic replacement', async () => {
    const extractArchive = vi.fn(async (_tarball: Buffer, destDir: string) => {
      await mkdir(join(destDir, 'dist'), { recursive: true })
      await writeFile(join(destDir, 'package.json'), JSON.stringify({ name: 'u-chan-secrets', version: '2.1.0' }))
      await writeFile(join(destDir, 'dist', 'index.js'), 'console.log("v2.1.0 index")')
      await writeFile(join(destDir, 'dist', 'cli.js'), 'console.log("v2.1.0 cli")')
    })

    const updater = new ServiceUpdater({
      verifier,
      restarter,
      programDir,
      stagingDir,
      currentVersion: '2.0.0',
      extractArchive,
    })

    const res = await updater.update()
    expect(res).toEqual({ ok: true, message: 'updated to version 2.1.0 — restarting service' })

    // Verify programDir updated
    const newPkg = JSON.parse(await readFile(join(programDir, 'package.json'), 'utf8'))
    expect(newPkg.version).toBe('2.1.0')
    const newIndex = await readFile(join(programDir, 'dist', 'index.js'), 'utf8')
    expect(newIndex).toBe('console.log("v2.1.0 index")')

    // Verify restarter scheduled asynchronously
    await new Promise((r) => setImmediate(r))
    expect(restarter.restart).toHaveBeenCalled()
  })

  it('aborts update and rolls back if staged package is malformed', async () => {
    const extractArchive = vi.fn(async (_tarball: Buffer, destDir: string) => {
      await mkdir(join(destDir, 'dist'), { recursive: true })
      await writeFile(join(destDir, 'package.json'), JSON.stringify({ name: 'u-chan-secrets', version: '2.1.0' }))
      // omits dist/index.js!
      await writeFile(join(destDir, 'dist', 'cli.js'), 'console.log("v2.1.0 cli")')
    })

    const updater = new ServiceUpdater({
      verifier,
      restarter,
      programDir,
      stagingDir,
      currentVersion: '2.0.0',
      extractArchive,
    })

    const res = await updater.update()
    expect(res).toEqual({ ok: false, message: 'staged package is invalid: missing dist/index.js' })

    // Original programDir untouched
    const pkg = JSON.parse(await readFile(join(programDir, 'package.json'), 'utf8'))
    expect(pkg.version).toBe('2.0.0')
    expect(restarter.restart).not.toHaveBeenCalled()
  })

  it('restores from backup if file swap fails', async () => {
    const extractArchive = vi.fn(async (_tarball: Buffer, destDir: string) => {
      await mkdir(join(destDir, 'dist'), { recursive: true })
      await writeFile(join(destDir, 'package.json'), JSON.stringify({ name: 'u-chan-secrets', version: '2.1.0' }))
      await writeFile(join(destDir, 'dist', 'index.js'), 'console.log("v2.1.0 index")')
      await writeFile(join(destDir, 'dist', 'cli.js'), 'console.log("v2.1.0 cli")')
    })

    const updater = new ServiceUpdater({
      verifier,
      restarter,
      programDir,
      stagingDir,
      currentVersion: '2.0.0',
      extractArchive,
    })

    // Simulate swap failure by spying on rename inside updater or causing an error after backup
    const renameSpy = vi.spyOn(updater as any, 'swapDirs').mockRejectedValue(new Error('simulated disk error during swap'))

    const res = await updater.update()
    expect(res.ok).toBe(false)
    expect(res.message).toContain('simulated disk error during swap')

    // Original programDir restored
    expect(existsSync(programDir)).toBe(true)
    const pkg = JSON.parse(await readFile(join(programDir, 'package.json'), 'utf8'))
    expect(pkg.version).toBe('2.0.0')
    expect(restarter.restart).not.toHaveBeenCalled()
    renameSpy.mockRestore()
  })
})
