@echo off
setlocal
set ROOT=%~dp0..
set LOG=%ROOT%\install-debug.log

fltmc.exe >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting elevation...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%ROOT%"
echo === %DATE% %TIME% === > "%LOG%"
echo [uninstall] >> "%LOG%"
call node dist\cli.js uninstall >> "%LOG%" 2>&1
echo [install] >> "%LOG%"
call node dist\cli.js install >> "%LOG%" 2>&1
echo [install exit code %errorlevel%] >> "%LOG%"
echo [sc query] >> "%LOG%"
sc.exe query u-chan-secrets >> "%LOG%" 2>&1
echo [bin dir] >> "%LOG%"
dir C:\ProgramData\u-chan-secrets /s /b >> "%LOG%" 2>&1
echo [service.log] >> "%LOG%"
type C:\ProgramData\u-chan-secrets\service.log >> "%LOG%" 2>&1
type "%LOG%"
echo.
echo Log saved to %LOG%
pause
