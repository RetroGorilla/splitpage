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

  Silent install (for scripting):  SplitpageSetup.exe /Q     (this user)
                                   SplitpageSetup.exe /Q:A   (everyone; needs admin)
  Custom folder: SplitpageSetup.exe /Q /C:"powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Silent -Dir C:\path"

  -InPlace registers a copy that is ALREADY on disk -- a portable unzip that
  wants to be in the Start Menu. It copies nothing and needs no payload: it
  makes the shortcuts and writes the Add/Remove entry, both pointing at the
  folder given by -Dir. This is what the app's own setup step runs, through
  the launcher's loopback-only endpoint.
#>

[CmdletBinding()]
param(
  [switch]$Silent,
  [string]$Dir,
  [switch]$AllUsers,
  [switch]$InPlace,
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"
$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppName = "Splitpage"
# Stamped in by package.mjs when the setup is built.
$script:SetupVersion = "@VERSION@"
# Set when the setup window did the asking, so the end of the script knows
# whether to report in a window or on a console.
$script:UsedGui = $false
$script:GuiDesktop = $true
$script:GuiHost = $false
$script:ProgressWindow = $null
$script:WpfReady = $false

# --- -Unregister: the inverse of -InPlace -----------------------------------
#
# A copy registered in place was never copied anywhere, so "uninstall" must
# not delete anything the user unzipped (their documents may sit in data\
# right beside it). It only takes back what -InPlace added: the shortcuts,
# the Add/Remove Programs entry and the marker file.
if ($Unregister) {
  if (-not $Dir) { throw "-Unregister needs -Dir pointing at the registered folder." }
  $target = (Resolve-Path $Dir).Path
  foreach ($menuRoot in @($env:APPDATA, $env:ProgramData)) {
    $menu = Join-Path $menuRoot "Microsoft\Windows\Start Menu\Programs"
    foreach ($name in @("$AppName.lnk", "$AppName (shared session).lnk")) {
      $lnk = Join-Path $menu $name
      if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue }
    }
  }
  $wsh = New-Object -ComObject WScript.Shell
  foreach ($desk in @($wsh.SpecialFolders("Desktop"), $wsh.SpecialFolders("AllUsersDesktop"))) {
    if ($desk) {
      $lnk = Join-Path $desk "$AppName.lnk"
      if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue }
    }
  }
  foreach ($hive in @("HKCU:", "HKLM:")) {
    $k = "$hive\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"
    if (Test-Path $k) { Remove-Item $k -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item (Join-Path $target ".splitpage-registered") -Force -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "  Removed the Start Menu entry and the Add/Remove Programs entry." -ForegroundColor Green
  Write-Host "  Nothing in $target was touched; delete the folder yourself if you no longer want it."
  Write-Host ""
  exit 0
}

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

# --- the setup window -------------------------------------------------------
#
# A double-clicked installer has no console anyone can see (IExpress runs it
# hidden), so asking questions with Read-Host meant the setup appeared to do
# nothing at all while it sat waiting for an answer. These build real windows
# instead, with WPF, which ships with Windows - nothing to install.
#
# If WPF cannot load for any reason, Show-SetupDialog returns $null and the
# caller installs to the per-user default rather than asking: doing the
# ordinary thing is always better than hanging on a prompt nobody can see.

function Initialize-Wpf {
  if ($script:WpfReady) { return $true }
  try {
    Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
    Add-Type -AssemblyName PresentationCore -ErrorAction Stop
    Add-Type -AssemblyName WindowsBase -ErrorAction Stop
    $script:WpfReady = $true
    return $true
  } catch {
    return $false
  }
}

# Paints a window that is about to be blocked. The install runs on this same
# thread, so without pumping the dispatcher once the progress window would be
# an empty white rectangle for the whole copy.
function Invoke-UiPump {
  $frame = New-Object System.Windows.Threading.DispatcherFrame
  $null = [System.Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvoke(
    [System.Windows.Threading.DispatcherPriority]::Background,
    [action]{ $frame.Continue = $false })
  [System.Windows.Threading.Dispatcher]::PushFrame($frame)
}

function New-SetupWindow([string]$xaml) {
  $reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
  [Windows.Markup.XamlReader]::Load($reader)
}

# Returns a hashtable of answers, or $null for "cancelled", or $false when
# there is no WPF to show.
function Show-SetupDialog([string]$defaultUser, [string]$defaultAll, [string]$suggested) {
  if (-not (Initialize-Wpf)) { return $false }
  $isAdmin = Test-Admin
  $version = $script:SetupVersion

  $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Splitpage Setup" SizeToContent="Height" Width="520"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        Background="#F6F4EC" FontFamily="Segoe UI" FontSize="13">
  <StackPanel Margin="22,18,22,16">
    <TextBlock Text="Install Splitpage" FontSize="20" Foreground="#221F1A"/>
    <TextBlock x:Name="Version" Foreground="#6E6858" Margin="0,2,0,14"/>
    <TextBlock Text="Where should it go?" Foreground="#221F1A" Margin="0,0,0,8"/>
    <RadioButton x:Name="RbUser" GroupName="Where" IsChecked="True" AutomationProperties.Name="Just for me">
      <StackPanel>
        <TextBlock Text="Just for me" Foreground="#221F1A"/>
        <TextBlock x:Name="PathUser" Foreground="#6E6858" FontSize="11" TextWrapping="Wrap"/>
      </StackPanel>
    </RadioButton>
    <RadioButton x:Name="RbAll" GroupName="Where" Margin="0,10,0,0" AutomationProperties.Name="Everyone on this PC">
      <StackPanel>
        <TextBlock x:Name="AllLabel" Foreground="#221F1A"/>
        <TextBlock x:Name="PathAll" Foreground="#6E6858" FontSize="11" TextWrapping="Wrap"/>
      </StackPanel>
    </RadioButton>
    <RadioButton x:Name="RbCustom" GroupName="Where" Content="Somewhere else" Foreground="#221F1A" Margin="0,10,0,0"/>
    <Grid Margin="18,6,0,0">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <TextBox x:Name="CustomPath" Grid.Column="0" IsEnabled="False" Padding="4,3" VerticalContentAlignment="Center"/>
      <Button x:Name="Browse" Grid.Column="1" Content="Browse..." IsEnabled="False" Margin="8,0,0,0" Padding="12,4"/>
    </Grid>
    <Border Background="#EFEAE0" BorderBrush="#DCD5C4" BorderThickness="1" CornerRadius="6" Margin="0,16,0,0" Padding="12,10">
      <StackPanel>
        <CheckBox x:Name="CbDesktop" Content="Put a shortcut on the desktop" IsChecked="True" Foreground="#221F1A"/>
        <CheckBox x:Name="CbHost" Content="Add a shortcut for hosting a shared session" Foreground="#221F1A" Margin="0,8,0,0"/>
        <TextBlock Text="A shared session lets other people on your network open a link and edit the same scripts as you." Foreground="#6E6858" FontSize="11" TextWrapping="Wrap" Margin="24,3,0,0"/>
      </StackPanel>
    </Border>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,18,0,0">
      <Button x:Name="Cancel" Content="Cancel" Width="92" Height="30" IsCancel="True"/>
      <Button x:Name="Install" Content="Install" Width="110" Height="30" Margin="10,0,0,0" IsDefault="True"/>
    </StackPanel>
  </StackPanel>
</Window>
"@

  try { $win = New-SetupWindow $xaml } catch { return $false }

  $find = { param($n) $win.FindName($n) }
  $rbUser = & $find "RbUser"; $rbAll = & $find "RbAll"; $rbCustom = & $find "RbCustom"
  $custom = & $find "CustomPath"; $browse = & $find "Browse"
  $cbDesktop = & $find "CbDesktop"; $cbHost = & $find "CbHost"

  (& $find "Version").Text = if ($version) { "version $version" } else { "" }
  (& $find "PathUser").Text = $defaultUser
  (& $find "PathAll").Text = $defaultAll
  (& $find "AllLabel").Text = if ($isAdmin) { "Everyone on this PC" } else { "Everyone on this PC (needs an administrator window)" }
  # Offered only when this window can actually do it. Elevating mid-install
  # would mean relaunching the setup, and a greyed-out choice that explains
  # itself is honest where a prompt that then fails is not.
  $rbAll.IsEnabled = $isAdmin

  if ($suggested) { $custom.Text = $suggested; $rbCustom.IsChecked = $true }

  $syncCustom = {
    $on = [bool]$rbCustom.IsChecked
    $custom.IsEnabled = $on
    $browse.IsEnabled = $on
  }
  $rbUser.Add_Checked($syncCustom); $rbAll.Add_Checked($syncCustom); $rbCustom.Add_Checked($syncCustom)
  & $syncCustom

  $browse.Add_Click({
    try {
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
      $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
      $dlg.Description = "Choose a folder for Splitpage"
      if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $custom.Text = Join-Path $dlg.SelectedPath "Splitpage"
      }
    } catch { }
  })

  $script:SetupAnswers = $null
  (& $find "Install").Add_Click({
    $chosen = if ($rbAll.IsChecked) { $defaultAll }
              elseif ($rbCustom.IsChecked) { $custom.Text.Trim() }
              else { $defaultUser }
    if ([string]::IsNullOrWhiteSpace($chosen)) {
      $null = [System.Windows.MessageBox]::Show($win, "Type a folder, or pick one with Browse.", "Splitpage Setup")
      return
    }
    $script:SetupAnswers = @{
      Target = $chosen
      AllUsers = [bool]$rbAll.IsChecked
      Desktop = [bool]$cbDesktop.IsChecked
      Host = [bool]$cbHost.IsChecked
    }
    $win.Close()
  })
  (& $find "Cancel").Add_Click({ $script:SetupAnswers = $null; $win.Close() })

  $null = $win.ShowDialog()
  return $script:SetupAnswers
}

# Stays up, frozen but painted, for the few seconds the copy takes.
function Show-SetupProgress([string]$where) {
  if (-not (Initialize-Wpf)) { return $null }
  $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Splitpage Setup" SizeToContent="Height" Width="420"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        Background="#F6F4EC" FontFamily="Segoe UI" FontSize="13">
  <StackPanel Margin="24,22,24,22">
    <TextBlock Text="Installing Splitpage..." FontSize="16" Foreground="#221F1A"/>
    <TextBlock x:Name="Where" Foreground="#6E6858" FontSize="11" TextWrapping="Wrap" Margin="0,6,0,12"/>
    <ProgressBar IsIndeterminate="True" Height="6" Foreground="#1B7A68" Background="#EFEAE0" BorderThickness="0"/>
  </StackPanel>
</Window>
"@
  try { $win = New-SetupWindow $xaml } catch { return $null }
  $win.FindName("Where").Text = $where
  $win.Show()
  Invoke-UiPump
  return $win
}

# Returns $true when the user asked to open Splitpage now.
function Show-SetupDone([string]$where) {
  if (-not (Initialize-Wpf)) { return $false }
  $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Splitpage Setup" SizeToContent="Height" Width="460"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        Background="#F6F4EC" FontFamily="Segoe UI" FontSize="13">
  <StackPanel Margin="24,22,24,18">
    <TextBlock Text="Splitpage is installed." FontSize="18" Foreground="#221F1A"/>
    <TextBlock x:Name="Where" Foreground="#6E6858" FontSize="11" TextWrapping="Wrap" Margin="0,6,0,0"/>
    <TextBlock Text="It is in your Start Menu. Splitpage opens in your browser - in Chrome or Edge, click the install icon in the address bar to give it its own window." Foreground="#221F1A" TextWrapping="Wrap" Margin="0,12,0,0"/>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,18,0,0">
      <Button x:Name="Close" Content="Close" Width="92" Height="30" IsCancel="True"/>
      <Button x:Name="Open" Content="Open Splitpage" Width="140" Height="30" Margin="10,0,0,0" IsDefault="True"/>
    </StackPanel>
  </StackPanel>
</Window>
"@
  try { $win = New-SetupWindow $xaml } catch { return $false }
  $win.FindName("Where").Text = $where
  $script:OpenNow = $false
  $win.FindName("Open").Add_Click({ $script:OpenNow = $true; $win.Close() })
  $win.FindName("Close").Add_Click({ $script:OpenNow = $false; $win.Close() })
  $null = $win.ShowDialog()
  return $script:OpenNow
}

# Anything that goes wrong below reaches this, and a setup launched by a
# double-click has no console to print it on. Say it in a window, put the
# progress window away first, and leave with a failing exit code.
function Show-SetupFailed([string]$message) {
  if (-not (Initialize-Wpf)) { return }
  try {
    $null = [System.Windows.MessageBox]::Show(
      "Splitpage could not be installed.`r`n`r`n$message",
      "Splitpage Setup",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Error)
  } catch { }
}

trap {
  if ($script:ProgressWindow) {
    try { $script:ProgressWindow.Close() } catch { }
    $script:ProgressWindow = $null
  }
  if ($script:UsedGui) { Show-SetupFailed $_.Exception.Message }
  else { Write-Host ""; Write-Host ("  " + $_.Exception.Message) -ForegroundColor Red; Write-Host "" }
  exit 1
}

# --- where to install -------------------------------------------------------
#
# Per-user by default: it needs no administrator, and it keeps the app folder
# writable, which matters because a shared session keeps its documents there
# unless told otherwise.

$defaultUser = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$defaultAll  = Join-Path ${env:ProgramFiles} $AppName

if ($InPlace) {
  # Registering a copy that is already where it wants to be. -Dir is not a
  # choice here, it is a statement of fact, so there is nothing to ask.
  if (-not $Dir) { throw "-InPlace needs -Dir pointing at the folder to register." }
  if (-not (Test-Path (Join-Path $Dir "start.bat"))) {
    throw "-InPlace was given $Dir, which does not look like a Splitpage folder (no start.bat)."
  }
  $target = (Resolve-Path $Dir).Path
  $Silent = $true
} elseif ($Dir) {
  $target = $Dir
} elseif ($Silent) {
  $target = if ($AllUsers) { $defaultAll } else { $defaultUser }
} else {
  # The window. $UsedGui decides who reports the result at the end: the
  # dialog that asked, or the console the script was started from.
  $answers = Show-SetupDialog $defaultUser $defaultAll $Dir
  if ($answers -is [hashtable]) {
    $script:UsedGui = $true
    $target = $answers.Target
    $AllUsers = $answers.AllUsers
    $script:GuiDesktop = $answers.Desktop
    $script:GuiHost = $answers.Host
  } elseif ($null -eq $answers) {
    # Cancel, and nothing has been written yet.
    exit 0
  } else {
    # No WPF here. Install the ordinary way rather than ask a question into
    # a console the user may well not be able to see.
    $target = $defaultUser
  }
}

# --- options ----------------------------------------------------------------

# Asked in the dialog, alongside where to install. A run with flags (or one
# where WPF would not load) takes the defaults: a desktop shortcut, and no
# shared-session shortcut for a feature the user has not asked for.
$desktopIcon = if ($script:UsedGui) { $script:GuiDesktop } else { $true }
$hostIcon = if ($script:UsedGui) { $script:GuiHost } else { $false }

# --- copy -------------------------------------------------------------------

Write-Host ""
if ($InPlace) {
  Write-Host "  Registering the copy already in $target" -ForegroundColor Gray
} else {
  Write-Host "  Installing to $target" -ForegroundColor Gray
}

if (-not $InPlace) {

if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }

if ($script:UsedGui) { $script:ProgressWindow = Show-SetupProgress $target }

# The payload is a zip rather than loose files because IExpress extracts
# everything into one flat folder, which would lose server\ and runtime\.
$payload = Join-Path $Source "splitpage-payload.zip"
if (-not (Test-Path $payload)) {
  # Per-architecture builds name it splitpage-payload-<arch>.zip.
  $alt = Get-ChildItem -Path $Source -Filter "splitpage-payload-*.zip" | Select-Object -First 1
  if ($alt) { $payload = $alt.FullName } else { throw "splitpage-payload.zip is missing from this installer." }
}

$stage = Join-Path $env:TEMP ("splitpage-install-" + [System.Guid]::NewGuid().ToString("N"))
try {
  Expand-Archive -LiteralPath $payload -DestinationPath $stage -Force
  # The zip has a single splitpage-<version>\ folder at the top.
  $inner = Get-ChildItem $stage -Directory | Select-Object -First 1
  $from = if ($inner) { $inner.FullName } else { $stage }
  Copy-Item (Join-Path $from "*") $target -Recurse -Force

  # Copy-Item above only adds/overwrites - it never removes a file an
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

  # Runs AFTER the mirror step above: the mirror removes anything not in the
  # payload, and runtime\node.exe is created here, not shipped, so doing this
  # earlier would delete the runtime it just chose.
  # --- pick the Node runtime this machine can actually run ----------------
  #
  # NOT $env:PROCESSOR_ARCHITECTURE: that is the architecture of THIS
  # process, and a setup built by IExpress is an x64 program, so on a
  # Windows-on-ARM PC it runs emulated and says "AMD64" about an ARM64
  # machine. Believing it made the arm64 setup look for a runtime it does
  # not carry, find nothing, and install an app with no Node at all.
  #
  # What the download carries decides it. A single-architecture setup (what
  # we publish) has exactly one runtime and there is nothing to choose; the
  # --arch both build has two, and only then does the machine get a vote.

  $runtimeDir = Join-Path $target "runtime"
  $runtimes = @(Get-ChildItem (Join-Path $runtimeDir "node-*.exe") -ErrorAction SilentlyContinue)

  # The machine, not the process - and only sources that survive emulation.
  # Measured on a Snapdragon PC from an emulated x64 shell, where an ARM64
  # machine reports itself as:
  #
  #   registry PROCESSOR_ARCHITECTURE ... ARM64   (right)
  #   Win32_Processor.Architecture ....... 12      (right: ARM64)
  #   RuntimeInformation::OSArchitecture .. X64     (wrong)
  #   $env:PROCESSOR_ARCHITECTURE ........ AMD64   (wrong)
  #
  # The registry value is what Windows itself records about the hardware, so
  # it is asked first and the two liars come last.
  $osArch = $null
  try {
    $osArch = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" -Name PROCESSOR_ARCHITECTURE -ErrorAction Stop).PROCESSOR_ARCHITECTURE
  } catch { }
  if (-not $osArch) {
    try {
      $code = (Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1).Architecture
      if ($code -eq 12) { $osArch = "ARM64" } elseif ($code -eq 9) { $osArch = "AMD64" }
    } catch { }
  }
  if (-not $osArch) {
    try { $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { }
  }
  if (-not $osArch) { $osArch = $env:PROCESSOR_ARCHITEW6432 }
  if (-not $osArch) { $osArch = $env:PROCESSOR_ARCHITECTURE }
  $isArm = ("$osArch" -match "(?i)arm64")

  $selected = $null
  if ($runtimes.Count -eq 1) {
    $selected = $runtimes[0].Name
  } elseif ($runtimes.Count -gt 1) {
    $want = if ($isArm) { "node-arm64.exe" } else { "node-x64.exe" }
    if (Test-Path (Join-Path $runtimeDir $want)) { $selected = $want }
    else { $selected = $runtimes[0].Name }
  } elseif (Test-Path (Join-Path $runtimeDir "node.exe")) {
    $selected = "node.exe"
  }

  # An ARM64 binary cannot run on an Intel PC - the other way round is fine,
  # because Windows on ARM emulates x64. Saying so now beats an installed
  # copy that never starts.
  if ($selected -eq "node-arm64.exe" -and -not $isArm) {
    throw "This is the ARM version of Splitpage and this PC is $osArch. Download SplitpageSetup-x64.exe instead."
  }

  if ($selected -and $selected -ne "node.exe") {
    Move-Item (Join-Path $runtimeDir $selected) (Join-Path $runtimeDir "node.exe") -Force
    foreach ($other in @(Get-ChildItem (Join-Path $runtimeDir "node-*.exe") -ErrorAction SilentlyContinue)) {
      Remove-Item $other.FullName -Force -ErrorAction SilentlyContinue
    }

    # The manifest lists runtime/node-<arch>.exe; the file on disk is now
    # runtime/node.exe. Rename the entry (same hash, same mode) rather than
    # dropping it, so the uninstaller still removes node.exe and the updater
    # still recognises it as a shipped file, and drop the other archs.
    $manifestPath = Join-Path $target ".splitpage-release.json"
    if (Test-Path $manifestPath) {
      $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
      $names = @($manifest.files.PSObject.Properties | ForEach-Object { $_.Name })
      foreach ($name in $names) {
        if ($name -notmatch "^runtime/node-[A-Za-z0-9]+\.exe$") { continue }
        if ($name -eq ("runtime/" + $selected)) {
          $manifest.files | Add-Member -NotePropertyName "runtime/node.exe" -NotePropertyValue $manifest.files.$name -Force
        }
        $manifest.files.PSObject.Properties.Remove($name)
      }
      [System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 10) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    }
  }
} finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

}  # -not $InPlace

# Documents for a shared session live outside the app folder, so that an
# install into Program Files (read-only for normal users) still works and an
# uninstall never has the chance to take someone's scripts with it.
$dataDir = Join-Path $env:LOCALAPPDATA "$AppName\data"

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
# A copy registered in place was never copied, so its Add/Remove entry must
# only unregister it (shortcuts, key, marker) and never delete the folder -
# the user's documents may live in data beside it. The installed copy keeps
# its real uninstaller.
if ($InPlace) {
  Set-Content -Path (Join-Path $target ".splitpage-registered") -Value (Get-Date -Format o) -Encoding ASCII
  Set-ItemProperty $key "UninstallString" `
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$target\installer\install.ps1`" -Unregister -Dir `"$target`""
} elseif (Test-Path (Join-Path $target "uninstall.ps1")) {
  Set-ItemProperty $key "UninstallString" `
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$target\uninstall.ps1`""
} else {
  Set-ItemProperty $key "UninstallString" "`"$target\uninstall.bat`""
}

# --- done -------------------------------------------------------------------

if ($InPlace) {
  # The app that asked for this is already open and reading the exit code;
  # do not start a second copy.
  Write-Host ""
  Write-Host "  Added to the Start Menu and to Add/Remove Programs." -ForegroundColor Green
  Write-Host "  It runs from $target"
  Write-Host ""
  exit 0
}

if ($script:ProgressWindow) {
  $script:ProgressWindow.Close()
  $script:ProgressWindow = $null
}

if ($script:UsedGui) {
  # The dialog asked; the dialog reports. Opening Splitpage is the user's
  # call here, unlike the console path, where the command they typed is
  # itself the request to get on with it.
  if (Show-SetupDone $target) {
    Start-Process -FilePath $launcher -WorkingDirectory $target -WindowStyle Minimized
  }
} elseif (-not $Silent) {
  Write-Host ""
  Write-Host "  Done." -ForegroundColor Green
  Write-Host ""
  Write-Host "  Splitpage is in your Start Menu. Opening it now - in Chrome or Edge,"
  Write-Host "  click the install icon in the address bar to give it its own window."
  Write-Host ""
  Start-Process -FilePath $launcher -WorkingDirectory $target -WindowStyle Minimized
  Start-Sleep -Seconds 2
}
