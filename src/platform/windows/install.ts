import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApprovalMode, ToolResult } from '../../core/types.js'
import { defaultExec, setAdminOnlyAcl, type ExecFn } from './acl.js'
import { checkUacLevel } from './uac.js'
import { migrateBitwarden } from './migration.js'
import { ServiceManager } from './service-manager.js'
import { compileCsharp } from './assets/compiler.js'
import { AUTH_HELPER_CSHARP } from './assets/auth-src.js'
import { PROMPT_HELPER_CSHARP } from './assets/prompt-src.js'
import { SERVICE_HOST_CSHARP } from './assets/service-src.js'
import { generateRandomPhrase } from '../darwin/lifecycle.js'
import { assertCompatibleState } from '../../service/state.js'
import { stageBrowser } from '../runtime-assets.js'
import { randomUUID } from 'node:crypto'

export const defaultProgramData = (): string => {
  return process.env.ProgramData
    ? path.join(process.env.ProgramData, 'u-chan-secrets')
    : 'C:\\ProgramData\\u-chan-secrets'
}

export const defaultAdminCheck = async (exec: ExecFn = defaultExec): Promise<boolean> => {
  try {
    await exec('fltmc.exe', [])
    return true
  } catch {
    return false
  }
}

export const defaultGetUserSid = async (exec: ExecFn = defaultExec): Promise<string> => {
  try {
    const { stdout } = await exec('whoami.exe', ['/user'])
    const match = stdout.match(/S-1-[0-9-]+/i)
    if (match) return match[0]
  } catch {}
  return ''
}

export interface WindowsInstallOptions {
  stageBrowser?: (home: string) => Promise<void>
  packageRoot?: string
  mode?: ApprovalMode
  phrase?: string
  adminCheck?: () => Promise<boolean>
  getUserSid?: () => Promise<string>
  programData?: string
  exec?: ExecFn
  serviceManager?: ServiceManager
  out?: (msg: string) => void
  err?: (msg: string) => void
}

export async function installWindowsService(opts: WindowsInstallOptions = {}): Promise<ToolResult> {
  const exec = opts.exec ?? defaultExec
  const adminCheck = opts.adminCheck ?? (() => defaultAdminCheck(exec))
  const isAdmin = await adminCheck()
  if (!isAdmin) {
    return {
      ok: false,
      message: 'u-chan install requires administrator privileges',
    }
  }

  const out = opts.out ?? console.log
  const programData = opts.programData ?? defaultProgramData()
  const binDir = path.join(programData, 'bin')
  const dataDir = path.join(programData, 'bw-data')
  const programDir = path.join(programData, 'program')
  const stagedProgram = path.join(programData, 'program-stage-' + randomUUID())
  const packageRoot = opts.packageRoot ?? fileURLToPath(new URL('../../../', import.meta.url))
  const targetPackage = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  await assertCompatibleState(programData, Number(String(targetPackage.version).split('.')[0]))
  const sm = opts.serviceManager ?? new ServiceManager(exec)
  const priorState = typeof sm.status === 'function' ? await sm.status('u-chan-secrets') : 'not_installed'
  if (priorState === 'running' || priorState === 'pending') {
    await sm.stop('u-chan-secrets')
    const deadline = Date.now() + 30000
    while (!['stopped', 'not_installed'].includes(await sm.status('u-chan-secrets'))) {
      if (Date.now() >= deadline) return { ok: false, message: 'service did not stop; installation was not staged' }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  // 1. Check UAC level and warn if default
  try {
    const uac = await checkUacLevel()
    if (uac.isDefault && uac.warning) {
      out(uac.warning)
    }
  } catch {}

  // 2. Create directories and stage admin-owned program copy
  await fs.mkdir(programData, { recursive: true })
  await setAdminOnlyAcl(programData, exec, false)
  await fs.mkdir(programDir, { recursive: true })
  await setAdminOnlyAcl(programDir, exec, false)
  // Retire only V2's dependency junction; its user-side target remains untouched.
  const legacyModules = path.join(programDir, 'node_modules')
  if ((await fs.lstat(legacyModules).catch(() => undefined))?.isSymbolicLink()) await fs.unlink(legacyModules)
  await setAdminOnlyAcl(programData, exec)
  await fs.mkdir(binDir, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(stagedProgram)
  try {
    const pkgRoot = opts.packageRoot ?? fileURLToPath(new URL('../../../', import.meta.url))
    await fs.cp( path.join(pkgRoot, 'dist'), path.join(stagedProgram, 'dist'), { recursive: true })
    await fs.cp( path.join(pkgRoot, 'package.json'), path.join(stagedProgram, 'package.json'))
    const srcNm = path.join(pkgRoot, 'node_modules')
    const destNm = path.join(stagedProgram, 'node_modules')
    {
      // Never let a privileged service execute a user-writable dependency junction.
      const existing = await fs.lstat(destNm).catch(() => undefined)
      if (existing?.isSymbolicLink()) await fs.unlink(destNm)
      await fs.cp(srcNm, destNm, {
        recursive: true,
        dereference: true,
        filter: (src) => !/[\\/]\.(vite|vitest-cache|vite-temp)/.test(src),
      })
    }
  } catch {
    return { ok: false, message: 'could not stage a private service program copy; service not started' }
  }

  // 3. Set strict Administrator/SYSTEM ACLs
  await setAdminOnlyAcl(programData, exec)

  // 4. Compile C# assets after stopping the service; do not kill unrelated helpers.
  const authExe = path.join(binDir, 'auth-helper.exe')
  const promptExe = path.join(binDir, 'prompt-helper.exe')
  const serviceExe = path.join(binDir, 'service-host.exe')

  await compileCsharp(AUTH_HELPER_CSHARP, authExe, { exec })
  await compileCsharp(PROMPT_HELPER_CSHARP, promptExe, {
    outputType: 'WindowsApplication',
    referencedAssemblies: ['System.Windows.Forms.dll', 'System.Drawing.dll'],
    exec,
  })
  await compileCsharp(SERVICE_HOST_CSHARP, serviceExe, {
    referencedAssemblies: ['System.ServiceProcess.dll'],
    exec,
  })

  // 4b. Write service target configuration so service host runs node + service bundle on boot
  const nodeExe = path.join(binDir, 'node.exe')
  await fs.copyFile(process.execPath, nodeExe)
  try { await (opts.stageBrowser ?? stageBrowser)(programData) }
  catch { return { ok: false, message: 'could not stage private Chromium; run npx playwright install chromium from the trusted installation, then retry' } }
  const mainJs = path.join(programDir, 'dist', 'service', 'main.js')
  await fs.writeFile(path.join(binDir, 'service-target.txt'), `${nodeExe}\n${mainJs}\n`, 'utf8')

  // 4c. Ensure bw.exe is copied to binDir if found on the system
  try {
    const { stdout } = await exec('where.exe', ['bw.exe'])
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length > 0) {
      await fs.copyFile(lines[0], path.join(binDir, 'bw.exe')).catch(() => {})
    }
  } catch {}

  // 5. Write settings file
  const getUserSid = opts.getUserSid ?? (() => defaultGetUserSid(exec))
  const authorizedSid = await getUserSid()
  const settings = {
    mode: opts.mode ?? 'easy',
    phrase: opts.phrase ?? generateRandomPhrase(),
    idleLockMs: 43200000,
    authorizedSid,
  }
  try {
    await fs.writeFile(path.join(programData, 'settings.json'), JSON.stringify(settings, null, 2), { encoding: 'utf8', flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }

  // 6. Migrate user Bitwarden CLI
  const migration = await migrateBitwarden({ exec })
  if (migration.warning) {
    out(migration.warning)
  }

  // 7. Register and start Windows service
  // Normalize ownership of newly copied native/runtime files before starting privileged code.
  await setAdminOnlyAcl(programData, exec)
  const backupParent = path.join(programData, '#0 backup')
  await fs.mkdir(backupParent, { recursive: true })
  const oldProgram = path.join(backupParent, 'program-before-' + randomUUID())
  const root = path.resolve(programData) + path.sep
  if (![programDir, stagedProgram, oldProgram].every(p => path.resolve(p).startsWith(root))) throw new Error('program staging path escaped service home')
  const oldNames = await fs.readdir(programDir)
  await fs.rename(programDir, oldProgram)
  const movedNames = await fs.readdir(oldProgram)
  if (oldNames.length !== movedNames.length || oldNames.some(name => !movedNames.includes(name))) throw new Error('program backup verification failed')
  try { await fs.rename(stagedProgram, programDir) }
  catch (e) { await fs.rename(oldProgram, programDir); throw e }
  if (priorState === 'not_installed') await sm.create('u-chan-secrets', serviceExe, 'U-Chan Secrets Service')
  await sm.start('u-chan-secrets')

  return {
    ok: true,
    message: 'U-Chan Secrets service installed and started successfully',
  }
}

export interface WindowsUninstallOptions {
  adminCheck?: () => Promise<boolean>
  programData?: string
  serviceManager?: ServiceManager
  exec?: ExecFn
  out?: (msg: string) => void
  err?: (msg: string) => void
}

export async function uninstallWindowsService(opts: WindowsUninstallOptions = {}): Promise<ToolResult> {
  const exec = opts.exec ?? defaultExec
  const adminCheck = opts.adminCheck ?? (() => defaultAdminCheck(exec))
  const isAdmin = await adminCheck()
  if (!isAdmin) {
    return {
      ok: false,
      message: 'u-chan uninstall requires administrator privileges',
    }
  }

  const programData = opts.programData ?? defaultProgramData()
  const sm = opts.serviceManager ?? new ServiceManager(exec)

  await sm.stop('u-chan-secrets')
  await sm.delete('u-chan-secrets')

  await fs.rm(programData, { recursive: true, force: true }).catch(() => {})

  return {
    ok: true,
    message: 'U-Chan Secrets service uninstalled successfully',
  }
}
