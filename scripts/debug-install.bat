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
echo.
echo [*] Step 3: Checking service status...
sc.exe query u-chan-secrets
echo.
copy /y C:\ProgramData\u-chan-secrets\service.log "%ROOT%\service-copy.log" >nul 2>&1
copy /y C:\ProgramData\u-chan-secrets\settings.json "%ROOT%\settings-copy.json" >nul 2>&1
echo ========================================================
echo [+] Service successfully installed and started!
echo.
echo Next: Close this window, open your normal terminal, and run:
echo    u-chan import-v1
echo    u-chan unlock
echo ========================================================
echo.
pause
