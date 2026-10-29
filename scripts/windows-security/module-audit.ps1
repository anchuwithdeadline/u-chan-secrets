# Internal SYSTEM fixture. The caller supplies auditProcessId and auditServiceHome.
$ErrorActionPreference='Stop'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
$all=@(Get-CimInstance Win32_Process)
$ids=@($auditProcessId)
for($i=0;$i -lt $ids.Count;$i++) {
    $parent=$ids[$i]
    $ids+=@($all|Where-Object{$_.ParentProcessId -eq $parent}|ForEach-Object{[int]$_.ProcessId})
}
$paths=@();$exited=0;$unreadableLive=@()
foreach($id in $ids) {
    try {$paths+=@((Get-Process -Id $id -ErrorAction Stop).Modules|ForEach-Object{$_.FileName})}
    catch {if(Get-Process -Id $id -ErrorAction SilentlyContinue){$unreadableLive+=$id}else{$exited++}}
}
$paths=@($paths|Sort-Object -Unique)
$servicePrefix=[IO.Path]::GetFullPath($auditServiceHome).TrimEnd('\')+'\'
$windowsPrefix=[IO.Path]::GetFullPath($env:windir).TrimEnd('\')+'\'
$outside=@($paths|Where-Object{-not $_.StartsWith($servicePrefix,[StringComparison]::OrdinalIgnoreCase)-and -not $_.StartsWith($windowsPrefix,[StringComparison]::OrdinalIgnoreCase)})
$defender=0;$unsafe=@()
foreach($file in $outside) {
    $item=Get-Item -LiteralPath $file -Force
    $signature=Get-AuthenticodeSignature -LiteralPath $file
    $acl=$item.GetAccessControl()
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $trustedOwner=$owner -in @('S-1-5-18','S-1-5-32-544') -or $owner.StartsWith('S-1-5-80-')
    $bad=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{
        $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band 0xD0156) -and $_.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') -and -not $_.IdentityReference.Value.StartsWith('S-1-5-80-')
    })
    if($file.StartsWith('C:\ProgramData\Microsoft\Windows Defender\Platform\',[StringComparison]::OrdinalIgnoreCase)-and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-and $trustedOwner -and $signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'O=Microsoft Corporation' -and $bad.Count -eq 0){$defender++}else{$unsafe+=$file}
}
@{
    processes=$ids.Count;modules=$paths.Count;outside=$unsafe;verifiedDefenderModules=$defender
    unreadableLive=$unreadableLive.Count;exitedBeforeInspection=$exited
    bitwardenObserved=($paths -contains (Join-Path $auditServiceHome 'bin\bw.exe'))
    browserObserved=(@($paths|Where-Object{$_.StartsWith((Join-Path $servicePrefix 'bin\browser\'),[StringComparison]::OrdinalIgnoreCase)}).Count -gt 0)
}|ConvertTo-Json -Compress
