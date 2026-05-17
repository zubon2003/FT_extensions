@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo  FT_extensions installer (pnpm + supply-chain hardening)
echo ============================================================
echo.

REM --- 1) Node.js ----------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node.js v18 or later from https://nodejs.org/
    goto :fail
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo Node.js : !NODE_VER!

REM --- 2) Corepack + pnpm -------------------------------------------
where corepack >nul 2>nul
if errorlevel 1 (
    echo [ERROR] corepack not found. Node.js v16.10+ ships corepack; reinstall Node.js.
    goto :fail
)

echo.
echo [1/4] Preparing pnpm via corepack ^(no admin needed^) ...

REM Try to create global "pnpm" shims, but fall back gracefully — Node installed
REM under "C:\Program Files\nodejs" rejects this without elevation. The script
REM uses "corepack pnpm" afterwards, which works without enable.
call corepack enable >nul 2>nul
if errorlevel 1 (
    echo   ^(corepack enable skipped — no admin rights; using "corepack pnpm" instead^)
)

REM package.json in this folder pins pnpm@11.1.2 via the "packageManager" field.
REM corepack downloads and caches that version in the user profile, no admin.
call corepack prepare pnpm@11.1.2 --activate
if errorlevel 1 (
    echo [ERROR] corepack prepare pnpm failed. Check network connectivity.
    goto :fail
)
for /f "tokens=*" %%v in ('corepack pnpm --version') do set PNPM_VER=%%v
echo pnpm    : !PNPM_VER!

REM --- 3) Clean legacy npm artifacts --------------------------------
echo.
echo [2/4] Cleaning legacy npm artifacts ...
if exist "package-lock.json" (
    del /f /q "package-lock.json"
    echo   removed package-lock.json
)
if exist "node_modules" (
    echo   removing node_modules ^(may take a minute^) ...
    rmdir /s /q "node_modules"
)

REM --- 4) pnpm install ----------------------------------------------
echo.
echo [3/4] Installing dependencies via pnpm ...
echo   ^(rejecting any package version published in the last 3 days^)
call corepack pnpm install
set PNPM_RC=!errorlevel!
if not "!PNPM_RC!"=="0" (
    echo [ERROR] pnpm install failed with exit code !PNPM_RC!.
    goto :fail
)

REM --- 5) Smoke check: lint -----------------------------------------
echo.
echo [4/4] Running lint as a build smoke check ...
call corepack pnpm run lint
set LINT_RC=!errorlevel!
if not "!LINT_RC!"=="0" (
    echo [WARN] pnpm run lint reported issues ^(exit code !LINT_RC!^). Install itself succeeded.
)

echo.
echo ============================================================
echo  Done.
echo    Start receiver : corepack pnpm start
echo    Re-run lint    : corepack pnpm run lint
echo    ^(For bare "pnpm" command, run "corepack enable" once as Administrator.^)
echo ============================================================
endlocal
exit /b 0

:fail
echo.
echo Installation aborted.
endlocal
exit /b 1
