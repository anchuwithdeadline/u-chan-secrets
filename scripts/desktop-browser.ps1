# Shared user-side Chrome/Edge launcher and read-only process policy. No elevation or vault access.
function Test-UChanBrowserProcess($Observation, [string]$Executable, [string]$Profile, [string]$OwnerSid, [int]$Port) {
    if (-not $Observation.ExecutablePath -or -not $Observation.OwnerSid -or -not $Observation.CommandLine -or -not $Observation.Addresses) { return 'unknown' }
    if ($Observation.ExecutablePath -ine $Executable -or $Observation.OwnerSid -ne $OwnerSid) { return 'fail' }
    foreach ($address in $Observation.Addresses) { if ($address -notin @('127.0.0.1','::1')) { return 'fail' } }
    $profiles = [regex]::Matches($Observation.CommandLine, '(?i)(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|([^\s"]+))|--user-data-dir\s+(?:"([^"]+)"|([^\s"]+)))')
    if ($profiles.Count -ne 1) { return 'fail' }
    $actual = @($profiles[0].Groups | Select-Object -Skip 1 | Where-Object Success | ForEach-Object Value)
    if ($actual.Count -ne 1) { return 'fail' }
    try { if ([IO.Path]::GetFullPath($actual[0]).TrimEnd('\') -ine [IO.Path]::GetFullPath($Profile).TrimEnd('\')) { return 'fail' } } catch { return 'fail' }
    $ports = [regex]::Matches($Observation.CommandLine, '(?i)(?:^|\s)"?--remote-debugging-port=(\d+)"?(?=\s|$)')
    if ($ports.Count -ne 1 -or [int]$ports[0].Groups[1].Value -ne $Port) { return 'fail' }
    return 'pass'
}

function Get-UChanBrowserConfiguration([string]$Browser, [string]$HomeOverride, [string]$OwnerOverride, [string]$LocalOverride) {
    $userHome = if ($HomeOverride) { $HomeOverride } elseif ($env:U_CHAN_HOME) { $env:U_CHAN_HOME } else { Join-Path $env:APPDATA 'u-chan-secrets' }
    if (-not $Browser) { $Browser = $env:U_CHAN_BROWSER }
    if (-not $Browser) {
        $choice = Join-Path $userHome 'browser.json'
        if (Test-Path -LiteralPath $choice) {
            $item = Get-Item -LiteralPath $choice -Force
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Browser preference path is redirected.' }
            $saved = Get-Content -LiteralPath $choice -Raw | ConvertFrom-Json
            if (@($saved.PSObject.Properties).Count -ne 1) { throw 'Invalid browser preference.' }
            $Browser = $saved.browser
            if (-not $Browser) { throw 'Invalid browser preference.' }
        } else { $Browser = 'chrome' }
    }
    if ($Browser -cnotin @('chrome','edge')) { throw 'Choose chrome or edge.' }
    $profile = Join-Path $userHome ($Browser + '-profile')
    $check = [IO.Path]::GetFullPath($profile)
    while ($check) {
        if ((Test-Path -LiteralPath $check) -and ((Get-Item -LiteralPath $check -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Dedicated browser profile is redirected.' }
        $check = [IO.Path]::GetDirectoryName($check)
    }
    $cdp = [Uri]$(if ($env:U_CHAN_CDP) { $env:U_CHAN_CDP } else { 'http://127.0.0.1:9222' })
    if ($cdp.Scheme -ne 'http' -or $cdp.Host -notin @('127.0.0.1','localhost','[::1]','::1') -or $cdp.UserInfo -or $cdp.AbsolutePath -ne '/' -or $cdp.Query -or $cdp.Fragment) { throw 'Use an HTTP loopback CDP origin without credentials, path, query or fragment.' }
    $suffix = if ($Browser -eq 'edge') { 'Microsoft\Edge\Application\msedge.exe' } else { 'Google\Chrome\Application\chrome.exe' }
    $local = if ($LocalOverride) { $LocalOverride } else { $env:LOCALAPPDATA }
    $candidates = @(foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $local)) { if ($base) { Join-Path $base $suffix } })
    $executables = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    $owner = if ($OwnerOverride) { $OwnerOverride } else { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    return @{ Browser=$Browser; Profile=$profile; Endpoint=$cdp; Executables=$executables; OwnerSid=$owner }
}

# Privileged checks derive the desktop home from the installed owner's SID, never SYSTEM's APPDATA or user preference files.
function Get-UChanOwnerBrowserConfiguration([string]$OwnerSid, [string]$Browser) {
    if ($OwnerSid -notmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') { throw 'Installed desktop owner is invalid.' }
    $profile = (Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$OwnerSid) -ErrorAction Stop).ProfileImagePath
    if (-not $profile) { throw 'Installed desktop owner profile is unavailable.' }
    $profile = [Environment]::ExpandEnvironmentVariables($profile)
    $roaming = Join-Path $profile 'AppData\Roaming'
    $local = Join-Path $profile 'AppData\Local'
    $shell = Get-ItemProperty -LiteralPath ('Registry::HKEY_USERS\'+$OwnerSid+'\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders') -ErrorAction SilentlyContinue
    if ($shell.AppData) { $roaming = [Environment]::ExpandEnvironmentVariables(($shell.AppData -ireplace '%USERPROFILE%', $profile)) }
    if ($shell.'Local AppData') { $local = [Environment]::ExpandEnvironmentVariables(($shell.'Local AppData' -ireplace '%USERPROFILE%', $profile)) }
    $desktopHome = if ($env:U_CHAN_DESKTOP_HOME) { $env:U_CHAN_DESKTOP_HOME } else { Join-Path $roaming 'u-chan-secrets' }
    return Get-UChanBrowserConfiguration $Browser $desktopHome $OwnerSid $local
}

function Get-UChanBrowserState($Configuration) {
    try {
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $Configuration.Endpoint.Port)
        if ($listeners.Count -eq 0) { return 'missing' }
        $owners = @($listeners.OwningProcess | Select-Object -Unique)
        if ($owners.Count -ne 1) { return 'fail' }
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $owners[0]) -ErrorAction Stop
        if (-not $process) { return 'unknown' }
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
        $observation = @{ ExecutablePath=$process.ExecutablePath; OwnerSid=$owner.Sid; CommandLine=$process.CommandLine; Addresses=@($listeners.LocalAddress) }
        if (-not $process.ExecutablePath) { return 'unknown' }
        if ($process.ExecutablePath -notin $Configuration.Executables) { return 'fail' }
        $policy = Test-UChanBrowserProcess $observation $process.ExecutablePath $Configuration.Profile $Configuration.OwnerSid $Configuration.Endpoint.Port
        if ($policy -ne 'pass') { return $policy }
        $version = Invoke-RestMethod -Uri ([Uri]::new($Configuration.Endpoint,'/json/version')) -TimeoutSec 2 -ErrorAction Stop
        $socket = [Uri]$version.webSocketDebuggerUrl
        if ($socket.Scheme -ne 'ws' -or $socket.Host -notin @('127.0.0.1','localhost','[::1]','::1') -or $socket.Port -ne $Configuration.Endpoint.Port -or $socket.UserInfo) { return 'fail' }
        $edge = $version.'User-Agent' -match '(?:Edg|Edge)/'
        if (($Configuration.Browser -eq 'edge') -ne $edge) { return 'fail' }
        return 'pass'
    } catch { return 'unknown' }
}
