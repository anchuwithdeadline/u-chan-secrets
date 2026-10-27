param([switch]$Lock)

$ErrorActionPreference = 'Stop'
$home_ = if ($env:U_CHAN_HOME) { $env:U_CHAN_HOME } else { Join-Path $env:APPDATA 'u-chan-secrets' }
New-Item -ItemType Directory -Force -Path $home_ | Out-Null
$sessionFile = Join-Path $home_ 'bw-session'

if ($Lock) {
  bw lock | Out-Null
  Remove-Item -Force -ErrorAction SilentlyContinue $sessionFile
  Write-Host 'Vault locked, session removed.'
  return
}

# bw prompts for the master password itself; --raw prints only the session key.
$session = (bw unlock --raw | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $session) { throw 'bw unlock failed' }

# UTF8 without BOM, no trailing newline. Never echo the session.
[IO.File]::WriteAllText($sessionFile, $session, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Vault unlocked. Session saved to $sessionFile"
