import { commandState } from '../../core/doctor.js'
export const checkWindowsRegistration = () => commandState('sc.exe', ['query', 'u-chan-secrets'], s => /SERVICE_NAME:\s*u-chan-secrets/i.test(s))
export const checkWindowsUac = () => commandState('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "$p=Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'; if($p.EnableLUA -eq 1 -and $p.ConsentPromptBehaviorAdmin -eq 2 -and $p.PromptOnSecureDesktop -eq 1){'SAFE'}else{'UNSAFE'}"], s => s.trim() === 'SAFE')
export function checkWindowsPermissions(home: string) {
  const encoded = Buffer.from(home, 'utf8').toString('base64')
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $root=Get-Item -LiteralPath $p -Force; if($root.Attributes -band [IO.FileAttributes]::ReparsePoint){'UNSAFE';exit}; $items=@($root)+@(Get-ChildItem -LiteralPath $p -Force -Recurse); foreach($i in $items){if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){'UNSAFE';exit}; $acl=$i.GetAccessControl(); $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; if($owner -notin @('S-1-5-18','S-1-5-32-544')){'UNSAFE';exit}; foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')){'UNSAFE';exit}} }; 'SAFE'`
  return commandState('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], s => s.trim() === 'SAFE', 15000)
}
