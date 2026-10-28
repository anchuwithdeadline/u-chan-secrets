@echo off
setlocal
set ROOT=%~dp0..

fltmc.exe >nul 2>&1
if %errorlevel% neq 0 (
    echo [*] Requesting Administrator elevation...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

set BITWARDENCLI_APPDATA_DIR=C:\ProgramData\u-chan-secrets\bw-data
set BW_BIN=C:\ProgramData\u-chan-secrets\bin\bw.exe
if not exist "%BW_BIN%" (
    for /f "delims=" %%i in ('where.exe bw.exe 2^>nul') do set BW_BIN=%%i
)

echo [*] Logging in to Bitwarden for U-Chan Service Store...
"%BW_BIN%" login
echo.
pause
