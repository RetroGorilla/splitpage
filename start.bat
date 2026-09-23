@echo off
rem Splitpage on Windows: a thin wrapper around start.mjs.
rem
rem Prefers the Node that ships inside the app (runtime\node.exe), so an
rem installed copy needs nothing else on the machine - including for hosting a
rem shared session. Falls back to per-arch runtimes for portable copies
rem carrying both architectures, then a Node on PATH.
rem
rem There used to be a fourth branch here: a static file server written in
rem PowerShell (start.ps1), for a machine with no Node at all. It was a third
rem implementation of this app's HTTP serving, it could not host a shared
rem session, and it was deleted with the rest of the surplus packaging (#75).
rem Without Node, open index.html directly - that still writes and exports.
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

echo Splitpage needs Node to serve itself. Install it from https://nodejs.org
echo and run this again.
echo.
echo Without a served page a browser will not offer "Install app", will not
echo run the offline service worker, and will not give the teleprompter a
echo microphone for Follow My Voice. You can still open index.html directly
echo in a browser to write and export.
exit /b 1
