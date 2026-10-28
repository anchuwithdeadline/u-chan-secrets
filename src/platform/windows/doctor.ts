import { commandState } from '../../core/doctor.js'
export const checkWindowsRegistration = () => commandState('sc.exe', ['query', 'u-chan-secrets'], s => /SERVICE_NAME:\s*u-chan-secrets/i.test(s))
export function checkWindowsPermissions(home: string) {
  const encoded = Buffer.from(home, 'utf8').toString('base64')
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $root=Get-Item -LiteralPath $p -Force; if($root.Attributes -band [IO.FileAttributes]::ReparsePoint){'UNSAFE';exit}; $items=@($root)+@(Get-ChildItem -LiteralPath $p -Force -Recurse); foreach($i in $items){if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){'UNSAFE';exit}; $acl=$i.GetAccessControl(); $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; if($owner -notin @('S-1-5-18','S-1-5-32-544')){'UNSAFE';exit}; foreach($ace in $acl.Access){if($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')){'UNSAFE';exit}} }; 'SAFE'`
  return commandState('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], s => s.trim() === 'SAFE')
}
