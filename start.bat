@echo off
rem Splitpage on Windows.
rem
rem Prefers the Node that ships inside the app (runtime\node.exe), so an
rem installed copy needs nothing else on the machine - including for hosting a
rem shared session. Falls back to per-arch runtimes for portable copies carrying
rem both architectures, then a Node on PATH for a portable copy, and finally to a
rem plain PowerShell file server if there is no Node at all, which still serves
rem the app well enough for "Install app" and the microphone.
setlocal
cd /d "%~dp0"

if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" start.mjs %*
  goto :eof
)

rem Fallback for portable copies with per-arch runtimes
if "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
  if exist "%~dp0runtime\node-arm64.exe" (
    "%~dp0runtime\node-arm64.exe" start.mjs %*
    goto :eof
  )
)
if "%PROCESSOR_ARCHITECTURE%"=="AMD64" (
  if exist "%~dp0runtime\node-x64.exe" (
    "%~dp0runtime\node-x64.exe" start.mjs %*
    goto :eof
  )
)

where node >nul 2>nul
if %errorlevel%==0 (
  node start.mjs %*
  goto :eof
)

echo Node was not found, so Splitpage is starting its simple built-in server.
echo Editing and exporting work; hosting a shared session does not.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
