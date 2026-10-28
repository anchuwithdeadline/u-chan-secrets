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

  // 1. Check UAC level and warn if default
  try {
    const uac = await checkUacLevel()
    if (uac.isDefault && uac.warning) {
      out(uac.warning)
    }
  } catch {}

  // 2. Create directories and stage admin-owned program copy
  await fs.mkdir(binDir, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(programDir, { recursive: true })
  try {
    const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url))
    await fs.cp( path.join(pkgRoot, 'dist'), path.join(programDir, 'dist'), { recursive: true })
    await fs.cp( path.join(pkgRoot, 'package.json'), path.join(programDir, 'package.json'))
    const srcNm = path.join(pkgRoot, 'node_modules')
    const destNm = path.join(programDir, 'node_modules')
    try {
      await fs.symlink(srcNm, destNm, 'junction')
    } catch {
      await fs.cp(srcNm, destNm, {
        recursive: true,
        filter: (src) => !/[\\/]\.(vite|vitest-cache|vite-temp)/.test(src),
      }).catch(() => {})
    }
  } catch {}

  // 3. Set strict Administrator/SYSTEM ACLs
  await setAdminOnlyAcl(programData, exec)

  // 4. Compile C# assets
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
  const nodeExe = process.execPath
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
  await fs.writeFile(path.join(programData, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')

  // 6. Migrate user Bitwarden CLI
  const migration = await migrateBitwarden({ exec })
  if (migration.warning) {
    out(migration.warning)
  }

  // 7. Register and start Windows service
  const sm = opts.serviceManager ?? new ServiceManager(exec)
  await sm.create('u-chan-secrets', serviceExe, 'U-Chan Secrets Service')
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
