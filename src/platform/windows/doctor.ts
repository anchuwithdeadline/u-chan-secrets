import { commandState } from '../../core/doctor.js'
export const checkWindowsRegistration = () => commandState('sc.exe', ['query', 'u-chan-secrets'], s => /SERVICE_NAME:\s*u-chan-secrets/i.test(s))
export function checkWindowsPermissions(home: string) {
  const encoded = Buffer.from(home, 'utf8').toString('base64')
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $acl=Get-Acl -LiteralPath $p; $bad=@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544') -and ($_.FileSystemRights -band 278) -ne 0 }); if($bad.Count -eq 0){'SAFE'}else{'UNSAFE'}`
  return commandState('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], s => s.trim() === 'SAFE')
}
