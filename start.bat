@echo off
rem Splitpage on Windows. Prefers the Node launcher (start.mjs), which also
rem rebuilds the app from src\ and can keep a document library; falls back to
rem the pure-PowerShell static server, which needs nothing installed at all.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node start.mjs %*
) else (
  echo Node was not found, so Splitpage is starting its simple built-in server.
  echo Install Node from nodejs.org if you want --library or a rebuild on start.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
)
