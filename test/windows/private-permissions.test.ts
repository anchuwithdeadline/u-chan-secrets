import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkWindowsPermissions } from '../../src/platform/windows/doctor.js'
const exec = promisify(execFile)
const ps = (script: string) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000 })
it('rejects a real user-owned directory even when its only user grant is read access', async () => {
  if (process.platform !== 'win32') return
  const dir = await mkdtemp(join(tmpdir(), 'ucs-private-acl-'))
  const path = `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(dir).toString('base64')}'))`
  const originalModulePath = process.env.PSModulePath
  const moduleRoot = join(dir, 'modules')
  const poisonModule = join(moduleRoot, 'Microsoft.PowerShell.Security')
  await mkdir(poisonModule, { recursive: true })
  await writeFile(join(poisonModule, 'Security.psm1'), "throw 'incompatible PowerShell module runtime'")
  await writeFile(join(poisonModule, 'Microsoft.PowerShell.Security.psd1'), "@{RootModule='Security.psm1';ModuleVersion='99.0';FunctionsToExport=@('Get-Acl')}")
  let original = ''
  try {
    const r = await ps(`$ErrorActionPreference='Stop'; $p=${path}; $old=[IO.Directory]::GetAccessControl($p); $old.Sddl; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a.SetOwner($u); foreach($sid in @('S-1-5-18','S-1-5-32-544')){ $s=New-Object Security.Principal.SecurityIdentifier($sid); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }; $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($u,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))); [IO.Directory]::SetAccessControl($p,$a)`)
    original = r.stdout.trim()
    process.env.PSModulePath = moduleRoot + delimiter + (originalModulePath ?? '')
    expect(await checkWindowsPermissions(dir)).toBe('fail')
  } finally {
    if (originalModulePath === undefined) delete process.env.PSModulePath
    else process.env.PSModulePath = originalModulePath
    if (original) {
      await ps(`$p=${path}; $a=New-Object Security.AccessControl.DirectorySecurity; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($u,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); [IO.Directory]::SetAccessControl($p,$a)`)
    }
    await rm(dir, { recursive: true, force: true })
  }
}, 15000)
