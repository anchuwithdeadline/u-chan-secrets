@echo off
setlocal
set ROOT=%~dp0..

fltmc.exe >nul 2>&1
if %errorlevel% neq 0 (
    echo [*] Requesting Administrator elevation...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%ROOT%"
echo ========================================================
echo       U-Chan Secrets V2 Installation & Setup
echo ========================================================
echo.
echo [*] Step 1: Stopping previous service (if any)...
call node dist\cli.js uninstall
echo.
echo [*] Step 2: Installing U-Chan Windows Service...
call node dist\cli.js install
if %errorlevel% neq 0 (
    echo.
    echo [X] Installation failed with exit code %errorlevel%.
    pause
    exit /b %errorlevel%
)
icacls C:\ProgramData\u-chan-secrets\bin /grant "Users:(OI)(CI)RX" >nul 2>&1
echo.
echo [*] Step 3: Checking service status...
sc.exe query u-chan-secrets
echo.

echo [*] Step 4: Bitwarden Vault Login...
set BITWARDENCLI_APPDATA_DIR=C:\ProgramData\u-chan-secrets\bw-data
set BW_BIN=C:\ProgramData\u-chan-secrets\bin\bw.exe
if not exist "%BW_BIN%" (
    for /f "delims=" %%i in ('where.exe bw.exe 2^>nul') do set BW_BIN=%%i
)

if exist "%BW_BIN%" (
    "%BW_BIN%" status > "%TEMP%\bw_stat.json" 2>&1
    findstr /C:"\"unauthenticated\"" "%TEMP%\bw_stat.json" >nul 2>&1
    if %errorlevel% equ 0 (
        echo [!] Bitwarden is not logged in for the privileged service.
        echo [*] Please log in to your Bitwarden vault below:
        "%BW_BIN%" login
    ) else (
        echo [+] Bitwarden vault is already logged in.
    )
    del "%TEMP%\bw_stat.json" >nul 2>&1
) else (
    echo [!] Warning: bw.exe not found.
)

echo.
copy /y C:\ProgramData\u-chan-secrets\service.log "%ROOT%\service-copy.log" >nul 2>&1
copy /y C:\ProgramData\u-chan-secrets\settings.json "%ROOT%\settings-copy.json" >nul 2>&1
echo ========================================================
echo [+] Service and Bitwarden configuration complete!
echo.
echo Next: Close this window, open your normal terminal, and run:
echo    u-chan import-v1
echo    u-chan unlock
echo ========================================================
echo.
pause
