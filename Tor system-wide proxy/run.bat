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
set "NODE_EXE=%~dp0vendor\nodejs\node.exe"
if not exist "%NODE_EXE%" (
    echo ERROR: The bundled Node.js runtime was not found:
    echo   "%NODE_EXE%"
    echo.
    echo From this folder, install the runtime with:
    echo   powershell -ExecutionPolicy Bypass -File scripts\fetch-vendor.ps1
    echo Then install the Node.js dependencies with:
    echo   npm install
    pause
    exit /b 1
)

"%NODE_EXE%" "%~dp0run.js" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%