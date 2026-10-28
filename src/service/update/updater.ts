import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { assertCompatibleState } from '../state.js'
import { promisify } from 'node:util'
import type { PackageVerifier, ServiceRestarter, ToolResult } from '../../core/types.js'

const execFileAsync = promisify(execFile)

export interface UpdaterDeps {
  verifier: PackageVerifier
  restarter: ServiceRestarter
  programDir: string
  stagingDir: string
  currentVersion: string
  packageName?: string
  extractArchive?: (tarball: Buffer, destDir: string) => Promise<void>
}

async function defaultExtractArchive(tarball: Buffer, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const tmpTar = join(destDir, `temp-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`)
  await writeFile(tmpTar, tarball)
  try {
    await execFileAsync('tar', ['-xzf', tmpTar, '-C', destDir])
  } finally {
    try {
      await unlink(tmpTar)
    } catch {}
  }
}

export class ServiceUpdater {
  constructor(private readonly d: UpdaterDeps) {}

  protected async swapDirs(sourceDir: string, targetDir: string, backupDir: string): Promise<void> {
    await rm(backupDir, { recursive: true, force: true }).catch(() => {})
    let backedUp = false
    if (existsSync(targetDir)) {
      await rename(targetDir, backupDir)
      backedUp = true
    }
    try {
      await rename(sourceDir, targetDir)
    } catch (err) {
      if (backedUp && !existsSync(targetDir) && existsSync(backupDir)) {
        try {
          await rename(backupDir, targetDir)
        } catch (rollbackErr) {
          console.error('rollback failed:', rollbackErr)
        }
      }
      throw err
    }
    await rm(backupDir, { recursive: true, force: true }).catch(() => {})
  }

  async update(): Promise<ToolResult> {
    try {
      const check = await this.d.verifier.checkLatest(this.d.currentVersion)
      if (!check.isNewer) {
        return { ok: true, message: `already up to date (version ${this.d.currentVersion})` }
      }
      const targetVersion = check.latestVersion
      await assertCompatibleState(dirname(this.d.programDir), Number(targetVersion.split('.')[0]))

      const verification = await this.d.verifier.verify(targetVersion)
      if (!verification.ok || !verification.tarball) {
        return { ok: false, message: `update failed: ${verification.error ?? 'verification failed'}` }
      }

      await mkdir(this.d.stagingDir, { recursive: true })
      const stageDir = join(this.d.stagingDir, `staging-${targetVersion}`)
      await rm(stageDir, { recursive: true, force: true }).catch(() => {})
      await mkdir(stageDir, { recursive: true })

      const extract = this.d.extractArchive ?? defaultExtractArchive
      await extract(verification.tarball, stageDir)

      let sourceDir = stageDir
      if (!existsSync(join(sourceDir, 'package.json')) && existsSync(join(sourceDir, 'package', 'package.json'))) {
        sourceDir = join(sourceDir, 'package')
      }

      const pkgPath = join(sourceDir, 'package.json')
      if (!existsSync(pkgPath)) {
        await rm(stageDir, { recursive: true, force: true }).catch(() => {})
        return { ok: false, message: 'staged package is invalid: missing package.json' }
      }

      let pkg: { name?: string; version?: string }
      try {
        pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
      } catch {
        await rm(stageDir, { recursive: true, force: true }).catch(() => {})
        return { ok: false, message: 'staged package is invalid: package.json is not valid JSON' }
      }

      const expectedName = this.d.packageName ?? 'u-chan-secrets'
      if (pkg.name !== expectedName || pkg.version !== targetVersion) {
        await rm(stageDir, { recursive: true, force: true }).catch(() => {})
        return { ok: false, message: `staged package is invalid: expected ${expectedName}@${targetVersion}` }
      }

      if (!existsSync(join(sourceDir, 'dist', 'index.js'))) {
        await rm(stageDir, { recursive: true, force: true }).catch(() => {})
        return { ok: false, message: 'staged package is invalid: missing dist/index.js' }
      }

      if (!existsSync(join(sourceDir, 'dist', 'cli.js'))) {
        await rm(stageDir, { recursive: true, force: true }).catch(() => {})
        return { ok: false, message: 'staged package is invalid: missing dist/cli.js' }
      }

      const installed = JSON.parse(await readFile(join(this.d.programDir, 'package.json'), 'utf8'))
      const staged = JSON.parse(await readFile(pkgPath, 'utf8'))
      const dependencies = (p: { dependencies?: Record<string, string> }) => JSON.stringify(Object.entries(p.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)))
      if (dependencies(installed) !== dependencies(staged)) {
        return { ok: false, message: 'update needs different dependencies; perform a trusted administrator reinstall' }
      }
      for (const file of ['prompt-src.js', 'auth-src.js', 'service-src.js']) {
        const relative = join('dist', 'platform', 'windows', 'assets', file)
        const current = join(this.d.programDir, relative), next = join(sourceDir, relative)
        if (existsSync(current) && (!existsSync(next) || await readFile(current, 'utf8') !== await readFile(next, 'utf8'))) {
          return { ok: false, message: 'update changes native helpers; perform a trusted administrator reinstall' }
        }
      }
      const modules = join(this.d.programDir, 'node_modules')
      if (existsSync(modules)) {
        await cp(modules, join(sourceDir, 'node_modules'), { recursive: true, filter: async p => {
          if ((await lstat(p)).isSymbolicLink()) throw new Error('private dependencies contain a link; reinstall from a trusted administrator terminal')
          return true
        } })
      }

      const backupDir = `${this.d.programDir}.bak`
      try {
        await this.swapDirs(sourceDir, this.d.programDir, backupDir)
      } catch (err) {
        await rm(stageDir, { recursive: true, force: true }).catch(() => {})
        return { ok: false, message: `update failed: ${(err as Error).message}` }
      }

      await rm(stageDir, { recursive: true, force: true }).catch(() => {})

      setImmediate(() => {
        void this.d.restarter.restart().catch(console.error)
      })

      return { ok: true, message: `updated to version ${targetVersion} — restarting service` }
    } catch (err) {
      return { ok: false, message: `update failed: ${(err as Error).message}` }
    }
  }
}
