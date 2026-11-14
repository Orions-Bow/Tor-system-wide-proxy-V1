@echo off
setlocal

REM ---------- Ensure correct working directory ----------
cd /d "%~dp0"
if errorlevel 1 (
    echo ERROR: Cannot access directory "%~dp0"
    pause
    exit /b 1
)

REM NOTE: No admin elevation needed. HKCU registry writes (system proxy settings)
REM are per-user and do not require administrator privileges.
REM The only operations that touch the registry are in HKCU\...\Internet Settings.

REM ---------- Launch ----------
echo.
echo Starting Tor System-Wide Proxy...
"%~dp0vendor\nodejs\node.exe" "%~dp0run.js" %*
echo.
pause