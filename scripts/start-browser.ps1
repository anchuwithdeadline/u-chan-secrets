param([ValidateSet('chrome','edge')][string]$Browser, [switch]$Background, [switch]$CheckOnly)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'desktop-browser.ps1')
$configuration=Get-UChanBrowserConfiguration $Browser
$state=Get-UChanBrowserState $configuration
if ($CheckOnly) { if ($state -eq 'missing') { 'fail' } else { $state }; return }
if ($state -eq 'pass') { Write-Host ($configuration.Browser + ' dedicated browser is ready.'); return }
if ($state -ne 'missing') { throw 'The browser endpoint is occupied, mismatched, or unverifiable. Close only the previous dedicated U-Chan browser before switching; keep personal windows open.' }
if ($configuration.Executables.Count -eq 0) { throw ($configuration.Browser + ' is not installed. Install it or explicitly select the other supported browser.') }
New-Item -ItemType Directory -Force -Path $configuration.Profile | Out-Null
$arguments=@(('--remote-debugging-port='+$configuration.Endpoint.Port), '--remote-debugging-address=127.0.0.1', ('--user-data-dir="'+$configuration.Profile+'"'), '--no-first-run')
if ($Background) { $arguments += '--no-startup-window' }
Start-Process -FilePath $configuration.Executables[0] -ArgumentList $arguments -WindowStyle Hidden
$deadline=[DateTime]::UtcNow.AddSeconds(15)
do {
    Start-Sleep -Milliseconds 300
    $state=Get-UChanBrowserState $configuration
    if ($state -eq 'pass') { Write-Host ($configuration.Browser + ' dedicated browser started.'); return }
    if ($state -eq 'fail') { break }
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Selected dedicated browser did not become verifiably ready. Check browser policy and run setup again.'
