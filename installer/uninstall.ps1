<#
  Splitpage uninstaller, registered with Add/Remove Programs by install.ps1.

  It removes the app, its shortcuts and its registry entry. It does NOT remove
  documents: a shared session keeps them in %LOCALAPPDATA%\Splitpage\data, and
  uninstalling an editor must never delete the writing. It says where they are
  and leaves them.
#>

[CmdletBinding()]
param([switch]$Silent)

$ErrorActionPreference = "Stop"
$AppName = "Splitpage"
$target = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $env:LOCALAPPDATA "$AppName\data"

if (-not $Silent) {
  Write-Host ""
  Write-Host "  Remove $AppName from $target ?" -ForegroundColor White
  if (Test-Path $dataDir) {
    Write-Host ""
    Write-Host "  Your shared-session scripts in" -ForegroundColor Gray
    Write-Host "    $dataDir" -ForegroundColor Gray
    Write-Host "  will be left where they are." -ForegroundColor Gray
  }
  Write-Host ""
  $answer = Read-Host "  Continue? [y/N]"
  if ($answer -notmatch '^[Yy]') { Write-Host "  Nothing was removed."; exit 0 }
}

# A running server holds node.exe open, so stop anything launched from here
# before trying to delete it. A trailing separator on the prefix matters: a
# bare StartsWith($target) also matches a sibling folder whose name merely
# begins with the same characters (e.g. "Splitpage" install path also
# matching a "SplitpageLegacy" one), force-killing an unrelated process.
$targetPrefix = $target.TrimEnd('\') + "\"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($targetPrefix, "OrdinalIgnoreCase") } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

foreach ($root in @($env:APPDATA, $env:ProgramData)) {
  $menu = Join-Path $root "Microsoft\Windows\Start Menu\Programs"
  foreach ($name in @("$AppName.lnk", "$AppName (shared session).lnk")) {
    $lnk = Join-Path $menu $name
    if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue }
  }
}
$shell = New-Object -ComObject WScript.Shell
foreach ($desk in @($shell.SpecialFolders("Desktop"), $shell.SpecialFolders("AllUsersDesktop"))) {
  if ($desk) {
    $lnk = Join-Path $desk "$AppName.lnk"
    if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue }
  }
}

$registryLeftBehind = @()
foreach ($root in @("HKCU:", "HKLM:")) {
  $key = "$root\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"
  if (Test-Path $key) {
    Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue
    # A non-elevated run against an all-users (HKLM) install fails here
    # with access-denied, silently, leaving an orphaned Add/Remove
    # Programs entry with no self-uninstall recourse — surfaced below
    # instead of just swallowing it.
    if (Test-Path $key) { $registryLeftBehind += $root }
  }
}

# This script is inside the folder it is deleting, so hand the last step to a
# detached cmd that waits for PowerShell to exit first. Because that rmdir
# runs after this process has already exited, its own success can't be
# checked from here — "Removed" below describes what this script did
# (shortcuts, registry), not a confirmed guarantee about the folder itself.
$cmd = "ping 127.0.0.1 -n 1 > nul & timeout /t 2 /nobreak > nul & rmdir /s /q `"$target`""
Start-Process cmd.exe -ArgumentList "/c", $cmd -WindowStyle Hidden

if (-not $Silent) {
  Write-Host ""
  Write-Host "  Removed." -ForegroundColor Green
  Write-Host "  The app folder is being deleted in the background and may take a" -ForegroundColor Gray
  Write-Host "  moment to finish after this window closes." -ForegroundColor Gray
  if ($registryLeftBehind.Count) {
    Write-Host "  Could not remove the $($registryLeftBehind -join ', ') registry entry" -ForegroundColor Yellow
    Write-Host "  (needs an admin prompt) — Add/Remove Programs may still list Splitpage." -ForegroundColor Yellow
  }
  if (Test-Path $dataDir) { Write-Host "  Your scripts are still in $dataDir" -ForegroundColor Gray }
  Write-Host ""
  Start-Sleep -Seconds 2
}
