@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo  FT_extensions sample receiver — start
echo ============================================================
echo.

REM --- 1) Node.js ----------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node.js v18 or later from https://nodejs.org/
    goto :fail
)

REM --- 2) Corepack + pnpm -------------------------------------------
where corepack >nul 2>nul
if errorlevel 1 (
    echo [ERROR] corepack not found. Node.js v16.10+ ships corepack; reinstall Node.js.
    goto :fail
)

REM --- 3) node_modules present? -------------------------------------
if not exist "node_modules" (
    echo [ERROR] node_modules not found. Run sample_install.bat first.
    goto :fail
)

REM --- 4) Launch -----------------------------------------------------
echo Starting server.js via "corepack pnpm start" ...
echo Press Ctrl+C to stop.
echo.

call corepack pnpm start
set START_RC=!errorlevel!
if not "!START_RC!"=="0" (
    echo.
    echo [ERROR] pnpm start exited with code !START_RC!.
    goto :fail
)

endlocal
exit /b 0

:fail
echo.
echo Server did not start successfully.
pause
endlocal
exit /b 1
