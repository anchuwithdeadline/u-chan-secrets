param([switch]$Background)
$ErrorActionPreference = 'Stop'
$home_ = if ($env:U_CHAN_HOME) { $env:U_CHAN_HOME } else { Join-Path $env:APPDATA 'u-chan-secrets' }
$profileDir = Join-Path $home_ 'chrome-profile'   # dedicated profile, never the default Chrome profile
$cdp = [Uri]$(if ($env:U_CHAN_CDP) { $env:U_CHAN_CDP } else { 'http://127.0.0.1:9222' })
if ($cdp.Scheme -ne 'http' -or $cdp.Host -notin @('127.0.0.1', 'localhost', '[::1]', '::1') -or $cdp.UserInfo -or $cdp.AbsolutePath -ne '/' -or $cdp.Query -or $cdp.Fragment) {
  throw 'Use an HTTP loopback CDP origin without user information, path, query or fragment.'
}
$port = $cdp.Port
$bindHost = $cdp.Host

# Already listening? Then do nothing (short TCP probe; Test-NetConnection is slow).
$client = New-Object System.Net.Sockets.TcpClient
try {
  $iar = $client.BeginConnect($bindHost, $port, $null, $null)
  if ($iar.AsyncWaitHandle.WaitOne(500) -and $client.Connected) {
    Write-Host "Port $port already open; Chrome is already running with remote debugging."
    return
  }
} catch { } finally { $client.Close() }

$candidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$chrome = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) { throw 'chrome.exe not found' }

New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$chromeArgs = @(
  "--remote-debugging-port=$port",
  "--remote-debugging-address=$bindHost",
  "--user-data-dir=`"$profileDir`"",
  '--no-first-run'
)
if ($Background) { $chromeArgs += '--no-startup-window' }
Start-Process -FilePath $chrome -ArgumentList $chromeArgs -WindowStyle Hidden
Write-Host "Chrome started (profile: $profileDir, CDP: http://${bindHost}:$port)"
