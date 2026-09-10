<#
  Splitpage installer.

  Runs from inside SplitpageSetup.exe, which is a self-extracting archive built
  by IExpress -- a tool that is already on every Windows machine, so building a
  release needs nothing installed and neither does running one. This script is
  the actual installer: it asks where to put things, copies them, makes the
  shortcuts and registers itself with Add/Remove Programs.

  Everything it needs is beside it in the extraction folder, including node.exe.
  That is the point: one download, and hosting a shared session works out of the
  box instead of sending the user off to install Node.

  Silent install (for scripting):  SplitpageSetup.exe /S [/D=C:\path]

  A silent install sets Splitpage to start with Windows, the same as the
  wizard's default. Pass -NoAutostart to this script to leave startup alone.
#>

[CmdletBinding()]
param(
  [switch]$Silent,
  [string]$Dir,
  [switch]$AllUsers,
  [switch]$NoAutostart
)

$ErrorActionPreference = "Stop"
$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppName = "Splitpage"
# Stamped in by package.mjs when the setup is built.
$script:SetupVersion = "@VERSION@"

function Write-Head {
  Write-Host ""
  Write-Host "  $AppName" -ForegroundColor White
  if ($script:SetupVersion) { Write-Host "  version $script:SetupVersion" -ForegroundColor DarkGray }
  Write-Host ""
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator)
}

# --- where to install -------------------------------------------------------
#
# Per-user by default: it needs no administrator, and it keeps the app folder
# writable, which matters because a shared session keeps its documents there
# unless told otherwise.

$defaultUser = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$defaultAll  = Join-Path ${env:ProgramFiles} $AppName

if ($Dir) {
  $target = $Dir
} elseif ($Silent) {
  $target = if ($AllUsers) { $defaultAll } else { $defaultUser }
} else {
  Write-Head
  Write-Host "  Where should Splitpage go?"
  Write-Host ""
  Write-Host "    [1] Just for me            $defaultUser" -ForegroundColor Gray
  Write-Host "        (no administrator needed)"
  Write-Host "    [2] Everyone on this PC    $defaultAll" -ForegroundColor Gray
  Write-Host "        (needs administrator)"
  Write-Host "    [3] Somewhere else         (type a path)"
  Write-Host ""
  $choice = Read-Host "  Choose 1, 2 or 3 [1]"
  switch ($choice) {
    "2" {
      if (-not (Test-Admin)) {
        Write-Host ""
        Write-Host "  That needs administrator rights, and this is not an elevated window." -ForegroundColor Yellow
        Write-Host "  Installing just for you instead - it works exactly the same." -ForegroundColor Yellow
        $target = $defaultUser
      } else {
        $target = $defaultAll
        $AllUsers = $true
      }
    }
    "3" {
      $typed = Read-Host "  Full path"
      if ([string]::IsNullOrWhiteSpace($typed)) { $target = $defaultUser } else { $target = $typed }
    }
    default { $target = $defaultUser }
  }
}

# --- options ----------------------------------------------------------------

$desktopIcon = $true
$hostIcon = $false
$autostart = -not $NoAutostart

if (-not $Silent) {
  Write-Host ""
  $d = Read-Host "  Add a desktop shortcut? [Y/n]"
  $desktopIcon = -not ($d -match '^[Nn]')
  Write-Host ""
  Write-Host "  Splitpage can start with Windows and keep its document server"
  Write-Host "  running in the background, so the app is there the moment you open" -ForegroundColor Gray
  Write-Host "  it. Nothing is shared with anyone: it listens on this PC only." -ForegroundColor Gray
  $a = Read-Host "  Start Splitpage when Windows starts? [Y/n]"
  $autostart = -not ($a -match '^[Nn]')
  Write-Host ""
  Write-Host "  Splitpage can also host a shared session, so other people on your"
  Write-Host "  network open a link and edit the same scripts as you." -ForegroundColor Gray
  $h = Read-Host "  Add a shortcut for that too? [y/N]"
  $hostIcon = ($h -match '^[Yy]')
}

# --- copy -------------------------------------------------------------------

Write-Host ""
Write-Host "  Installing to $target" -ForegroundColor Gray

if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }

# The payload is a zip rather than loose files because IExpress extracts
# everything into one flat folder, which would lose server\ and runtime\.
$payload = Join-Path $Source "splitpage-payload.zip"
if (-not (Test-Path $payload)) { throw "splitpage-payload.zip is missing from this installer." }

$stage = Join-Path $env:TEMP ("splitpage-install-" + [System.Guid]::NewGuid().ToString("N"))
try {
  Expand-Archive -LiteralPath $payload -DestinationPath $stage -Force
  # The zip has a single splitpage-<version>\ folder at the top.
  $inner = Get-ChildItem $stage -Directory | Select-Object -First 1
  $from = if ($inner) { $inner.FullName } else { $stage }
  Copy-Item (Join-Path $from "*") $target -Recurse -Force

  # Copy-Item above only adds/overwrites — it never removes a file an
  # upgrade left behind. Mirror instead: anything in $target that isn't
  # in this release's payload gets removed, so reinstalling over an older
  # version doesn't accumulate stale files (e.g. a renamed/deleted script)
  # indefinitely. Scoped entirely to $target, which never contains the
  # user's documents (those live in $dataDir, outside the app folder).
  $fromFull = (Resolve-Path $from).Path
  $newRel = @{}
  Get-ChildItem -Path $from -Recurse -File | ForEach-Object {
    $newRel[$_.FullName.Substring($fromFull.Length).TrimStart('\')] = $true
  }
  $targetFull = (Resolve-Path $target).Path
  Get-ChildItem -Path $target -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($targetFull.Length).TrimStart('\')
    if (-not $newRel.ContainsKey($rel)) { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
  }
} finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

# Documents live outside the app folder, so that an install into Program Files
# (read-only for normal users) still works and an uninstall never has the
# chance to take someone's scripts with it.
$dataDir = Join-Path $env:LOCALAPPDATA "$AppName\data"

# --- first-run setup --------------------------------------------------------
#
# Done here rather than left to the first launch, so the document server exists
# and Splitpage is registered to start with Windows before anyone has clicked
# anything. It is the app's own setup (start.mjs --setup) rather than a second
# implementation in PowerShell: one place decides what "set up" means, and a
# portable copy that was never installed goes through exactly the same code.
#
# Both of these are per-user by design -- the Run entry and the settings file
# live in the profile of whoever runs this. Installing for all users from an
# admin account therefore sets it up for that account; everyone else's first
# launch sets up their own, which is the behaviour you want anyway.

$node = Join-Path $target "runtime\node.exe"
if (Test-Path $node) {
  $setupArgs = @((Join-Path $target "start.mjs"), "--setup", "--data", $dataDir)
  $setupArgs += $(if ($autostart) { "--autostart" } else { "--no-autostart" })
  & $node @setupArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  Setup did not finish cleanly - Splitpage will set itself up on first launch." -ForegroundColor Yellow
  }
} else {
  Write-Host "  No bundled runtime found - Splitpage will set itself up on first launch." -ForegroundColor Yellow
}

# --- shortcuts --------------------------------------------------------------

$shell = New-Object -ComObject WScript.Shell
$icon = Join-Path $target "icon.ico"
$launcher = Join-Path $target "start.bat"

function New-Shortcut($path, $arguments, $description) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $launcher
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $target
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Description = $description
  # The launcher's console window is how you stop the server, but it should
  # not be what greets you: start it minimised and let the browser be the app.
  $lnk.WindowStyle = 7
  $lnk.Save()
}

$startMenu = if ($AllUsers) {
  Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs"
} else {
  Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
}
New-Shortcut (Join-Path $startMenu "$AppName.lnk") "" "Open Splitpage"

if ($hostIcon) {
  New-Shortcut (Join-Path $startMenu "$AppName (shared session).lnk") `
    "--library --host --data `"$dataDir`"" `
    "Host a shared Splitpage session for people on your network"
}

if ($desktopIcon) {
  $desktop = if ($AllUsers) { $shell.SpecialFolders("AllUsersDesktop") } else { $shell.SpecialFolders("Desktop") }
  New-Shortcut (Join-Path $desktop "$AppName.lnk") "" "Open Splitpage"
}

# --- register with Add/Remove Programs --------------------------------------

$root = if ($AllUsers) { "HKLM:" } else { "HKCU:" }
$key = "$root\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"
New-Item -Path $key -Force | Out-Null

$version = (Get-Content (Join-Path $target "VERSION") -ErrorAction SilentlyContinue)
if (-not $version) { $version = $script:SetupVersion }
$size = (Get-ChildItem $target -Recurse -File | Measure-Object -Property Length -Sum).Sum

Set-ItemProperty $key "DisplayName" $AppName
if ($version) { Set-ItemProperty $key "DisplayVersion" $version }
Set-ItemProperty $key "Publisher" "Adam Sondergard"
Set-ItemProperty $key "InstallLocation" $target
Set-ItemProperty $key "DisplayIcon" $icon
Set-ItemProperty $key "NoModify" 1 -Type DWord
Set-ItemProperty $key "NoRepair" 1 -Type DWord
Set-ItemProperty $key "EstimatedSize" ([int]($size / 1024)) -Type DWord
Set-ItemProperty $key "UninstallString" `
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$target\uninstall.ps1`""

# --- done -------------------------------------------------------------------

if (-not $Silent) {
  Write-Host ""
  Write-Host "  Done." -ForegroundColor Green
  Write-Host ""
  Write-Host "  Splitpage is in your Start Menu. Opening it now - in Chrome or Edge,"
  Write-Host "  click the install icon in the address bar to give it its own window."
  if ($autostart) {
    Write-Host ""
    Write-Host "  It will start with Windows from now on and keep running in the" -ForegroundColor Gray
    Write-Host "  background, so opening it later is instant. Turn that off with:" -ForegroundColor Gray
    Write-Host "    `"$target\start.bat`" --no-autostart --setup" -ForegroundColor Gray
  }
  Write-Host ""
  Start-Process -FilePath $launcher -WorkingDirectory $target -WindowStyle Minimized
  Start-Sleep -Seconds 2
}
