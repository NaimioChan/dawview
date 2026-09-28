@echo off
setlocal
cd /d "%~dp0"

rem ---- dawview launcher -------------------------------------------------
rem Double-click to open the default project, or drag a .cpr / .flp / .rpp
rem file onto this file to open that one.
rem Default project order: 1) default-project.txt (local, git-ignored)
rem                        2) the bundled synthetic demo snapshot
rem Python lookup order:   1) python-embed\python.exe   (portable package)
rem                        2) .venv\Scripts\python.exe  (local venv)
rem                        3) python on PATH
rem No third-party packages are needed: parser and local HTTP server are pure
rem standard library, and the window is Edge/Chrome in app mode (ships with
rem Windows).
rem NOTE: keep this file ASCII-only. cmd.exe parses .bat as GBK here and
rem non-ASCII bytes (even in rem comments) break the script.
rem ----------------------------------------------------------------------

set "PY=%~dp0python-embed\python.exe"
if not exist "%PY%" set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" -c "import sys" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [dawview] Python 3.10+ not found.
  echo           Install it from https://www.python.org/downloads/
  echo           ^(tick "Add python.exe to PATH" in the installer^)
  echo.
  pause
  exit /b 1
)

set "PROJ=%~1"
if not "%PROJ%"=="" goto :run

set "PROJ="
if exist "%~dp0default-project.txt" set /p PROJ=<"%~dp0default-project.txt"
if "%PROJ%"=="" set "PROJ=%~dp0docs\demo-project.json"

:run
title dawview
echo [dawview] project: "%PROJ%"
"%PY%" -m dawview "%PROJ%"

if errorlevel 1 (
  echo.
  echo [dawview] exited with an error. Press any key to close.
  pause >nul
)
endlocal
