# Internal admin fixture. Inputs are a fixed ProgramData root and a validated run UUID directory.
$ErrorActionPreference='Stop'
$admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($admins)
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-32-545')) {
    $rights=if($sid -eq 'S-1-5-32-545'){'ReadAndExecute'}else{'FullControl'}
    $id=New-Object Security.Principal.SecurityIdentifier($sid)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id,$rights,'ContainerInherit,ObjectInherit','None','Allow')))
}
function Assert-ProbeChannel([string]$target) {
    $item=Get-Item -LiteralPath $target -Force
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Public channel is redirected'}
    $current=$item.GetAccessControl()
    if($current.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'Public channel has untrusted owner'}
    foreach($rule in $current.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 0xD0156) -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'Public channel is writable by an untrusted identity'}
    }
}
# Parent delete-child access could otherwise override the protected root's DACL.
$parent=(Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($probePublicRoot)) -Force).GetAccessControl()
foreach($rule in $parent.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 0x40) -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') -and -not $rule.IdentityReference.Value.StartsWith('S-1-5-80-')){throw 'Public channel parent permits untrusted deletion'}
}
if(-not [IO.Directory]::Exists($probePublicRoot)){[IO.Directory]::CreateDirectory($probePublicRoot,$acl)|Out-Null}
# Validate after creation as CreateDirectory may return an existing directory after a race.
Assert-ProbeChannel $probePublicRoot
if([IO.Directory]::Exists($probeRunDirectory)-or [IO.File]::Exists($probeRunDirectory)){throw 'Run UUID has already been used'}
[IO.Directory]::CreateDirectory($probeRunDirectory,$acl)|Out-Null
Assert-ProbeChannel $probeRunDirectory
