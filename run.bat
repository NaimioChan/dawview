@echo off
setlocal
cd /d "%~dp0"

rem ---- dawview launcher -------------------------------------------------
rem Double-click to open the default project, or drag a .cpr / .flp file
rem onto this file to open that one.
rem Default project order: 1) default-project.txt (local, git-ignored)
rem                        2) the bundled synthetic demo snapshot
rem NOTE: keep this file ASCII-only. cmd.exe parses .bat as GBK here and
rem non-ASCII bytes (even in rem comments) break the script.
rem ----------------------------------------------------------------------

rem Prefer a project-local venv, fall back to whatever python is on PATH.
set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

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
