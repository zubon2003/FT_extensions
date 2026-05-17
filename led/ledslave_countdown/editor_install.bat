@echo off
REM ===========================================================================
REM  install.bat - ledslave_countdown editor dependency installer (Windows)
REM
REM  Installs the only external library required by
REM  ledslave_countdown_editor.py / ledslave_countdown_editor_en.py:
REM      Pillow  (image loading / thumbnails)
REM
REM  SUPPLY-CHAIN COOLDOWN
REM  ---------------------
REM  Installation goes through pip_cooldown_install.py, which refuses any
REM  release published fewer than PIP_COOLDOWN_DAYS days ago (default 3) and
REM  pins the newest version that is old enough. This blunts attacks that
REM  rely on a malicious release being grabbed before it is detected/yanked.
REM  To change the window, set PIP_COOLDOWN_DAYS before running, e.g.:
REM      set PIP_COOLDOWN_DAYS=7 && install.bat
REM
REM  tkinter is part of the Python standard library and is NOT installed here.
REM  If "import tkinter" fails, reinstall Python from python.org with the
REM  "tcl/tk and IDLE" option enabled.
REM ===========================================================================

setlocal

echo.
echo === ledslave_countdown editor - dependency setup ===
echo.

if not defined PIP_COOLDOWN_DAYS set "PIP_COOLDOWN_DAYS=3"

REM --- Locate a Python interpreter -----------------------------------------
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)

if not defined PY (
    echo [ERROR] Python was not found on PATH.
    echo         Install Python 3 from https://www.python.org/ and retry.
    echo.
    pause
    exit /b 1
)

echo Using interpreter: %PY%
%PY% --version
echo Release cooldown : %PIP_COOLDOWN_DAYS% day(s)
echo.

REM --- Install Pillow through the cooldown gate -----------------------------
%PY% "%~dp0pip_cooldown_install.py" Pillow
if errorlevel 1 (
    echo.
    echo [ERROR] Pillow was not installed. Common causes:
    echo          - no internet / proxy blocking pypi.org
    echo          - no Pillow release is older than %PIP_COOLDOWN_DAYS% day(s)
    echo            ^(very unlikely; lower PIP_COOLDOWN_DAYS only if you must^)
    echo.
    pause
    exit /b 1
)

echo.
echo === Done. You can now run: ===
echo     %PY% ledslave_countdown_editor.py        ^(Japanese UI^)
echo     %PY% ledslave_countdown_editor_en.py     ^(English UI^)
echo.
pause
endlocal
