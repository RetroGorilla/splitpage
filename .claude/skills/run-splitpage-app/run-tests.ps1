# Run the Splitpage test suites and report pass/fail.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1
#   ... -Only 02            run just the suite whose filename starts with 02
#   ... -Headed             watch it happen in a real Edge window
#   ... -Port 9601 -CdpPort 10201   pin the port bases instead of auto-picking
#
# Each suite gets its own driver process, its own server port and its own
# browser, so one wedged suite cannot take the others down with it. When
# -Port/-CdpPort are omitted the bases are auto-picked (see below) so two
# runs on the same machine — two worktrees, two agents — don't fight over
# the same fixed ports.

[CmdletBinding()]
param(
  [string]$Only,
  [int]$Port = 0,
  [int]$CdpPort = 0,
  [int]$TimeoutSec = 180,
  [switch]$Headed
)

$ErrorActionPreference = 'Stop'
$here  = $PSScriptRoot
$tests = Join-Path $here 'tests'
$logs  = Join-Path $env:TEMP 'splitpage-testlogs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# Start-Process returns Edge's launcher, which hands off to a process tree and
# exits — so the driver's own Stop-Process kills a corpse and leaves the real
# browser running. Worse, this runner kills the driver the moment it sees the
# RESULT line, which can be before that teardown runs at all. Left alone the
# orphans pile up (20 of them after one six-suite run) until a later suite's
# browser is too slow to answer and its CDP socket times out on the very first
# command — a suite that passes alone and fails in a full run.
#
# Matched on the profile directory, never on the process name: killing every
# msedge.exe would take down the browser the person running the tests is
# reading this in.
function Clear-SplitpageEdge {
  try {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*splitpage-edge-*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
}

Clear-SplitpageEdge

$files = Get-ChildItem -Path $tests -Filter '*.txt' | Sort-Object Name
if ($Only) { $files = $files | Where-Object { $_.Name -like "$Only*" } }
if (-not $files) { Write-Host "no test files matched"; exit 1 }

# Auto-pick free port bases when the caller didn't pin one. Each suite i gets
# ports ($Port + $i) / ($CdpPort + $i), so the block each run actually needs
# is base+1 .. base+files.Count on both ranges. Two suites on one machine
# (different worktrees, two agents) used to collide on the old fixed
# defaults (9601/10201) and fail with "static server did not come up" —
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

$totalChecks = 0; $totalFail = 0; $suiteFail = 0
$i = 0

foreach ($f in $files) {
  $i++
  $out = Join-Path $logs ($f.BaseName + '.out.txt')
  $err = Join-Path $logs ($f.BaseName + '.err.txt')
  Remove-Item $out, $err -ErrorAction SilentlyContinue

  # Distinct ports per suite so a leftover listener from a killed run does not
  # collide with the next one.
  $a = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'driver.ps1'),
    '-Port', ($Port + $i), '-CdpPort', ($CdpPort + $i), '-Script', $f.FullName
  )
  if ($Headed) { $a += '-Headed' }

  Write-Host ("--- {0}" -f $f.Name)
  $p = Start-Process powershell -ArgumentList $a -RedirectStandardOutput $out `
       -RedirectStandardError $err -PassThru -NoNewWindow

  # WaitForExit() on a redirected process can hang past the child's own exit,
  # so poll the log for the RESULT line the driver always prints last.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $done = $false
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Milliseconds 500
    if ((Test-Path $out) -and (Select-String -Path $out -Pattern '^RESULT:' -Quiet)) { $done = $true; break }
    if ($p.HasExited -and $sw.Elapsed.TotalSeconds -gt 3) { $done = $true; break }
  }
  # Give the driver a moment to reach its own finally block before killing it —
  # it prints RESULT first and tears the browser down after.
  if ($done -and -not $p.HasExited) {
    $grace = [Diagnostics.Stopwatch]::StartNew()
    while (-not $p.HasExited -and $grace.Elapsed.TotalSeconds -lt 5) { Start-Sleep -Milliseconds 200 }
  }
  if (-not $p.HasExited) { try { $p.Kill() } catch {} }
  Clear-SplitpageEdge

  if (-not $done) {
    Write-Host "    TIMED OUT after ${TimeoutSec}s" -ForegroundColor Red
    $suiteFail++
    if (Test-Path $out) { Get-Content $out | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" } }
    continue
  }

  $lines = Get-Content $out
  foreach ($l in $lines) {
    # -cmatch, not -match: PowerShell's -match is case-insensitive, so the
    # page's own lowercase "error: ..." console noise was being reported as
    # a driver failure.
    if ($l -cmatch '^FAIL')  { Write-Host "    $l" -ForegroundColor Red }
    elseif ($l -cmatch '^ *(expected|actual):') { Write-Host "    $l" -ForegroundColor Red }
    elseif ($l -cmatch '^ERROR') { Write-Host "    $l" -ForegroundColor Red }
  }
  $result = ($lines | Where-Object { $_ -match '^RESULT:' } | Select-Object -Last 1)
  if ($result -match 'RESULT: (\d+)/(\d+)') {
    $totalChecks += [int]$Matches[2]
    $totalFail   += ([int]$Matches[2] - [int]$Matches[1])
  }
  if ($result -match 'FAILED') { $suiteFail++; Write-Host "    $result" -ForegroundColor Red }
  else { Write-Host "    $result" -ForegroundColor Green }
}

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
