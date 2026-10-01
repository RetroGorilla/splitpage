# Run the Splitpage test suites and report pass/fail.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1
#   ... -Only 02            run just the suite whose filename starts with 02
#   ... -Headed            watch it happen in a real Edge window (forces -Parallel 1)
#   ... -Port 9601 -CdpPort 10201   pin the port bases instead of auto-picking
#
# Each suite gets its own driver process, its own server port and its own
# browser, so one wedged suite cannot take the others down with it. Up to
# -Parallel suites run at once; nothing is shared between them (distinct
# ports, distinct Edge profiles, distinct log files), which is what makes
# the lanes safe. When -Port/-CdpPort are omitted the bases are auto-picked
# (see below) so two runs on the same machine - two worktrees, two agents -
# don't fight over the same fixed ports. Two runs are also safe together on
# Edge: this script mints its own runId and every driver.ps1 it spawns tags
# its browser profile with it, so each run's leftover-browser sweep (see
# Clear-SplitpageEdge below) only ever touches its own run.

[CmdletBinding()]
param(
  [string]$Only,
  [int]$Port = 0,
  [int]$CdpPort = 0,
  [int]$TimeoutSec = 180,
  [int]$Parallel,
  [switch]$Headed
)

$ErrorActionPreference = 'Stop'
$here  = $PSScriptRoot
$tests = Join-Path $here 'tests'
$logs  = Join-Path $env:TEMP 'splitpage-testlogs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
if ($Headed) { $Parallel = 1 }
elseif (-not $PSBoundParameters.ContainsKey('Parallel')) { $Parallel = [Math]::Floor([Environment]::ProcessorCount * 9 / 16) }
if ($Parallel -lt 1) { $Parallel = 1 }

# Start-Process returns Edge's launcher, which hands off to a process tree and
# exits - so the driver's own Stop-Process kills a corpse and leaves the real
# browser running. Worse, this runner kills the driver the moment it sees the
# RESULT line, which can be before that teardown runs at all. Left alone the
# orphans pile up (20 of them after one six-suite run) until a later suite's
# browser is too slow to answer and its CDP socket times out on the very first
# command - a suite that passes alone and fails in a full run.
#
# Matched on the profile directory, never on the process name: killing every
# msedge.exe would take down the browser the person running the tests is
# reading this in. And matched on a tag this run minted, not on the bare
# "splitpage-edge-*" glob, so a second concurrent run-tests.ps1 on this
# machine (different runId) is never swept - that used to kill a second
# run's browser mid-suite with "The WebSocket is in an invalid state
# ('Aborted')". With parallel lanes the same reasoning applies INSIDE a run:
# each suite gets its own tag "<runId>s<NN>" (driver.ps1 appends "-<guid>"),
# so the per-suite sweep below only touches that suite's browsers and never
# a sibling lane's live one. The final sweep uses the bare runId prefix and
# takes everything this run left behind.
function Clear-SplitpageEdge([string]$Tag) {
  try {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*splitpage-edge-$Tag*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
}

$RunId = [guid]::NewGuid().ToString('N').Substring(0, 8)
Clear-SplitpageEdge $RunId

$files = Get-ChildItem -Path $tests -Filter '*.txt' | Sort-Object Name
if ($Only) { $files = $files | Where-Object { $_.Name -like "$Only*" } }
if (-not $files) { Write-Host "no test files matched"; exit 1 }

# Auto-pick free port bases when the caller didn't pin one. Each suite i gets
# ports ($Port + $i) / ($CdpPort + $i), so the block each run actually needs
# is base+1 .. base+files.Count on both ranges. Two suites on one machine
# (different worktrees, two agents) used to collide on the old fixed
# defaults (9601/10201) and fail with "static server did not come up" -
# instead, derive a starting base from a stable hash of this worktree's own
# path (so two worktrees rarely even try the same block), probe every port
# the run needs with a real TcpListener bind, and step the base forward by
# 100 until the whole block is free on both ranges at once. An explicit
# -Port/-CdpPort bypasses this entirely and is used as-is, as before.
function Test-PortFree([int]$p) {
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $p)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch { return $false }
}

function Get-StableSeed([string]$s) {
  $md5 = [System.Security.Cryptography.MD5]::Create()
  try {
    $bytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
    return [BitConverter]::ToUInt32($bytes, 0)
  } finally { $md5.Dispose() }
}

$autoPort = -not $PSBoundParameters.ContainsKey('Port')
$autoCdp  = -not $PSBoundParameters.ContainsKey('CdpPort')
if ($autoPort -or $autoCdp) {
  $seed     = Get-StableSeed $here
  $portBase = 20000 + ([int]($seed % 100)) * 100         # 20000..29900
  $cdpBase  = 30000 + ([int](($seed / 100) % 100)) * 100 # 30000..39900
  while ($true) {
    $free = $true
    for ($k = 1; $k -le $files.Count; $k++) {
      if ($autoPort -and -not (Test-PortFree ($portBase + $k))) { $free = $false }
      if ($autoCdp  -and -not (Test-PortFree ($cdpBase  + $k))) { $free = $false }
    }
    if ($free) { break }
    if ($autoPort) { $portBase += 100 }
    if ($autoCdp)  { $cdpBase  += 100 }
  }
  if ($autoPort) { $Port = $portBase }
  if ($autoCdp)  { $CdpPort = $cdpBase }
  Write-Host "auto-picked port bases: Port=$Port CdpPort=$CdpPort"
}
Write-Host ("running {0} suite(s), {1} at a time" -f $files.Count, $Parallel)

# One lane record per suite. Lanes are started in file order as slots free
# up; results are printed in the order lanes FINISH, each line prefixed with
# the suite name so interleaving is never ambiguous.
$lanes = @()
$i = 0
foreach ($f in $files) {
  $i++
  $lanes += [pscustomobject]@{
    Index = $i; File = $f; Tag = ('{0}s{1:d2}' -f $RunId, $i)
    Out = Join-Path $logs ($f.BaseName + '.out.txt')
    Err = Join-Path $logs ($f.BaseName + '.err.txt')
    Proc = $null; Watch = $null; Done = $false; DoneAt = $null; Reported = $false; TimedOut = $false
  }
}

function Start-Lane($lane) {
  Remove-Item $lane.Out, $lane.Err -ErrorAction SilentlyContinue
  $a = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $here 'driver.ps1')),
    '-Port', ($Port + $lane.Index), '-CdpPort', ($CdpPort + $lane.Index), '-Script', ('"{0}"' -f $lane.File.FullName),
    '-RunId', $lane.Tag
  )
  if ($Headed) { $a += '-Headed' }
  Write-Host ("--- {0} (started)" -f $lane.File.Name)
  $lane.Proc = Start-Process powershell -ArgumentList $a -RedirectStandardOutput $lane.Out `
               -RedirectStandardError $lane.Err -PassThru -NoNewWindow
  $lane.Watch = [Diagnostics.Stopwatch]::StartNew()
}

# WaitForExit() on a redirected process can hang past the child's own exit,
# so poll the log for the RESULT line the driver always prints last. Once it
# is there, give the driver up to 5 s to reach its own finally block before
# killing it - it prints RESULT first and tears the browser down after.
function Test-LaneFinished($lane) {
  if ($lane.Done) {
    if ($lane.Proc.HasExited) { return $true }
    if (((Get-Date) - $lane.DoneAt).TotalSeconds -ge 5) { try { $lane.Proc.Kill() } catch {}; return $true }
    return $false
  }
  $resultSeen = (Test-Path $lane.Out) -and (Select-String -Path $lane.Out -Pattern '^RESULT:' -Quiet)
  if ($resultSeen -or ($lane.Proc.HasExited -and $lane.Watch.Elapsed.TotalSeconds -gt 3)) {
    $lane.Done = $true; $lane.DoneAt = Get-Date
    return (Test-LaneFinished $lane)
  }
  if ($lane.Watch.Elapsed.TotalSeconds -ge $TimeoutSec) {
    $lane.Done = $true; $lane.TimedOut = $true
    try { $lane.Proc.Kill() } catch {}
    return $true
  }
  return $false
}

$totalChecks = 0; $totalFail = 0; $suiteFail = 0

function Report-Lane($lane) {
  $name = $lane.File.Name
  # Sweep this lane's own leftover browsers only (see Clear-SplitpageEdge).
  Clear-SplitpageEdge $lane.Tag

  if ($lane.TimedOut) {
    Write-Host ("--- {0}: TIMED OUT after {1}s" -f $name, $TimeoutSec) -ForegroundColor Red
    $script:suiteFail++
    if (Test-Path $lane.Out) { Get-Content $lane.Out | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" } }
    return
  }

  $lines = @(Get-Content $lane.Out -ErrorAction SilentlyContinue)
  $result = ($lines | Where-Object { $_ -match '^RESULT:' } | Select-Object -Last 1)
  $failed = ($result -match 'FAILED') -or (-not $result)
  Write-Host ("--- {0}" -f $name)
  foreach ($l in $lines) {
    # -cmatch, not -match: PowerShell's -match is case-insensitive, so the
    # page's own lowercase "error: ..." console noise was being reported as
    # a driver failure.
    if ($l -cmatch '^FAIL')  { Write-Host "    $l" -ForegroundColor Red }
    elseif ($l -cmatch '^ *(expected|actual):') { Write-Host "    $l" -ForegroundColor Red }
    elseif ($l -cmatch '^ERROR') { Write-Host "    $l" -ForegroundColor Red }
  }
  if ($result -match 'RESULT: (\d+)/(\d+)') {
    $script:totalChecks += [int]$Matches[2]
    $script:totalFail   += ([int]$Matches[2] - [int]$Matches[1])
  }
  if (-not $result) { $result = 'RESULT: (driver exited without a RESULT line) FAILED' }
  if ($failed) { $script:suiteFail++; Write-Host "    $result" -ForegroundColor Red }
  else { Write-Host "    $result" -ForegroundColor Green }
}

$pending = [System.Collections.Generic.Queue[object]]::new()
foreach ($lane in $lanes) { $pending.Enqueue($lane) }
$active = New-Object System.Collections.ArrayList

while ($pending.Count -gt 0 -or $active.Count -gt 0) {
  while ($pending.Count -gt 0 -and $active.Count -lt $Parallel) {
    $lane = $pending.Dequeue()
    Start-Lane $lane
    [void]$active.Add($lane)
  }
  Start-Sleep -Milliseconds 500
  foreach ($lane in @($active)) {
    if (Test-LaneFinished $lane) {
      Report-Lane $lane
      $active.Remove($lane)
    }
  }
}

Clear-SplitpageEdge $RunId

Write-Host ''
$passed = $totalChecks - $totalFail
if ($suiteFail -gt 0) {
  Write-Host "FAILED - $passed/$totalChecks checks passed across $($files.Count) suite(s)" -ForegroundColor Red
  Write-Host "logs: $logs"
  exit 1
}
Write-Host "ALL PASS - $passed/$totalChecks checks across $($files.Count) suite(s)" -ForegroundColor Green
Write-Host "logs: $logs"
exit 0
