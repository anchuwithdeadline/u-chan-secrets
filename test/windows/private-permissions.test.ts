import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
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
  let original = ''
  try {
    const r = await ps(`$ErrorActionPreference='Stop'; $p=${path}; $old=Get-Acl -LiteralPath $p; $old.Sddl; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a.SetOwner($u); foreach($sid in @('S-1-5-18','S-1-5-32-544')){ $s=New-Object Security.Principal.SecurityIdentifier($sid); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }; $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($u,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl -LiteralPath $p -AclObject $a`)
    original = r.stdout.trim()
    expect(await checkWindowsPermissions(dir)).toBe('fail')
  } finally {
    if (original) {
      await ps(`$p=${path}; $a=New-Object Security.AccessControl.DirectorySecurity; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($u,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); [IO.Directory]::SetAccessControl($p,$a)`)
    }
    await rm(dir, { recursive: true, force: true })
  }
}, 15000)
