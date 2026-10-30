param([switch]$Background, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
# Compatibility entry point: dedicated profile, never the default Chrome profile.
# Already listening? Validate browser identity, owner, profile and CDP before reusing it.
& (Join-Path $PSScriptRoot 'start-browser.ps1') -Browser chrome -Background:$Background -CheckOnly:$CheckOnly
