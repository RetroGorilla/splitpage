@echo off
rem Remove a portable Splitpage. If you used SplitpageSetup.exe instead, use
rem Add/Remove Programs - that also clears the Start Menu entry.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node uninstall.mjs %*
) else (
  echo This needs Node to run.
  echo Without it, just delete this folder - but move any scripts in data\ somewhere safe first.
)
pause
