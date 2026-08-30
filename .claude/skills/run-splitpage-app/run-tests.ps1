# Run the Splitpage test suites and report pass/fail.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1
#   ... -Only 02            run just the suite whose filename starts with 02
#   ... -Headed             watch it happen in a real Edge window
#
# Each suite gets its own driver process, its own server port and its own
# browser, so one wedged suite cannot take the others down with it.

[CmdletBinding()]
param(
  [string]$Only,
  [int]$Port = 8801,
  [int]$CdpPort = 9401,
  [int]$TimeoutSec = 180,
  [switch]$Headed
)

$ErrorActionPreference = 'Stop'
$here  = $PSScriptRoot
$tests = Join-Path $here 'tests'
$logs  = Join-Path $env:TEMP 'splitpage-testlogs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$files = Get-ChildItem -Path $tests -Filter '*.txt' | Sort-Object Name
if ($Only) { $files = $files | Where-Object { $_.Name -like "$Only*" } }
if (-not $files) { Write-Host "no test files matched"; exit 1 }

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
  if (-not $p.HasExited) { try { $p.Kill() } catch {} }

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
