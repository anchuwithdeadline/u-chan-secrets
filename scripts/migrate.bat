@echo off
setlocal
cd /d "%~dp0\.."

echo ========================================================
echo       U-Chan Secrets V2 Local Migration Helper
echo ========================================================
echo.

fltmc.exe >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Administrator privileges required to install Windows Service.
    echo [*] Requesting UAC elevation...
    powershell -Command "Start-Process cmd -ArgumentList '/k cd /d %~dp0\.. && scripts\migrate.bat' -Verb RunAs"
    exit /b
)

echo [+] Running with Administrator privileges.
echo.
echo Step 1: Installing U-Chan Secrets V2 Windows Service...
node dist/cli.js install

if %errorlevel% neq 0 (
    echo [X] Service installation failed. Check error above.
    pause
    exit /b 1
)

echo.
echo [+] Windows Service successfully installed and started!
echo.
echo ========================================================
echo Step 2: In your user terminal, run:
echo    u-chan import-v1
echo       (Click approve on popup dialogs to import V1 allowlist)
echo.
echo    u-chan unlock
echo       (Enter Bitwarden master password in secure dialog)
echo ========================================================
echo.
pause
