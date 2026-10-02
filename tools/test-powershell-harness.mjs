import { spawn, spawnSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL = process.env.PS_HARNESS_SKILL_DIR ?? join(REPO, ".claude", "skills", "run-splitpage-app");
const WINDOWS = process.platform === "win32";

let passed = 0;
let skipped = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

if (!WINDOWS) {
  skipped++;
  console.log("  SKIP the PowerShell driver and runner checks — they need Windows PowerShell 5.1 and http.sys");
  console.log(`\n${passed} passed, ${failures.length} failed, ${skipped} skipped on ${process.platform}\n`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "splitpage-ps-harness-"));
const children = [];

function powershell(file, args = [], timeout = 150000) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], { encoding: "utf8", timeout, windowsHide: true });
  const records = (r.stdout ?? "").split(/\r?\n/).filter((l) => l.startsWith("JSON ")).map((l) => JSON.parse(l.slice(5)));
  return { status: r.status, records, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function importParts(scriptPath, functions, assignments) {
  const names = functions.map((n) => `'${n}'`).join(",");
  const vars = assignments.map((n) => `'${n}'`).join(",");
  return String.raw`
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}', [ref]$null, [ref]$null)
$parts = @()
$parts += $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [System.Management.Automation.Language.NamedBlockAst] -and $null -eq $x.Parent.Parent.Parent -and @(${vars}) -contains $x.Left.Extent.Text }, $true) | ForEach-Object { $_.Extent.Text }
$parts += $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @(${names}) -contains $x.Name }, $true) | ForEach-Object { $_.Extent.Text }
. ([scriptblock]::Create($parts -join "` + "`n" + String.raw`"))
function Emit($o) { [Console]::Out.WriteLine('JSON ' + ($o | ConvertTo-Json -Compress -Depth 6)) }
`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function answers(port) {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

async function foreignListener(port) {
  const file = join(work, `foreign-${port}.ps1`);
  writeFileSync(file, `$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:${port}/")
$l.Start()
while ($true) { $c = $l.GetContext(); $b = [Text.Encoding]::UTF8.GetBytes("foreign"); $c.Response.OutputStream.Write($b, 0, $b.Length); $c.Response.Close() }
`);
  const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { stdio: "ignore", windowsHide: true });
  children.push(child);
  const deadline = Date.now() + 30000;
  while (!(await answers(port))) {
    if (Date.now() > deadline) throw new Error(`the foreign listener on ${port} never came up`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return child;
}

function stop(child) {
  if (child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

function serverHarness(root, port, scenario) {
  const file = join(work, `server-${scenario}-${port}.ps1`);
  const lines = [
    importParts(join(SKILL, "driver.ps1"), ["Get-FreePort", "Stop-ServerAttempt", "Get-ServerFailure", "Start-ServerOnce", "Start-Server"], ["$ServerAttempts", "$script:ServerPs"]),
    "$script:Logs = @()",
    "function Log($m) { $script:Logs += [string]$m }",
    `$Root = '${root.replace(/'/g, "''")}'`,
    `$Port = ${port}`,
    `$first = $Port`
  ];
  if (scenario === "fake-probe") lines.push("function Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }");
  if (scenario === "exhaust") lines.push("function Get-FreePort { return $first }");
  lines.push(String.raw`
$thrown = $null
try { Start-Server } catch { $thrown = $_.Exception }
$body = $null
if (-not $thrown -and ${scenario === "fake-probe" ? "$false" : "$true"}) {
  try { $body = (Invoke-WebRequest "http://localhost:$Port/index.html" -UseBasicParsing -TimeoutSec 5).Content } catch { $body = 'ERROR ' + $_.Exception.Message }
}
$running = $false
if ($script:ServerPs) { $running = ($script:ServerPs.InvocationStateInfo.State -eq 'Running') }
Emit @{ first = $first; port = $Port; body = $body; message = $(if ($thrown) { $thrown.Message } else { $null }); notStarted = $(if ($thrown) { [bool]$thrown.Data['notStarted'] } else { $false }); logs = @($script:Logs); running = $running }
[Environment]::Exit(0)
`);
  writeFileSync(file, lines.join("\n"));
  return file;
}

function siteRoot(withIndex) {
  const root = mkdtempSync(join(work, "root-"));
  if (withIndex) writeFileSync(join(root, "index.html"), "ours");
  return root;
}

async function serverChecks() {
  console.log("\ndriver.ps1's static server start:\n");

  const free = await freePort();
  const alone = powershell(serverHarness(siteRoot(true), free, "clean"))?.records[0];
  eq("a free port comes up on that port on the first attempt", [alone?.port, alone?.logs?.length, alone?.body], [free, 1, "ours"]);
  check("it logs the server being up", /server up on http:\/\/localhost:\d+\//.test(alone?.logs?.[0] ?? ""), JSON.stringify(alone));

  const held = await freePort();
  const foreign = await foreignListener(held);
  try {
    const r = powershell(serverHarness(siteRoot(true), held, "foreign")).records[0];
    check("a port held by a foreign listener is retried on a different port", r && r.port !== held, JSON.stringify(r));
    eq("the server that comes up is ours, not the foreign one", r?.body, "ours");
    check("the first attempt's failure names the conflict", /attempt 1 of 3 failed: port \d+: .*(conflicts|existing registration)/s.test(r?.logs?.[0] ?? ""), r?.logs?.[0]);
    eq("one failed attempt, then the server up", [r?.logs?.length, r?.running], [2, true]);

    const fake = powershell(serverHarness(siteRoot(true), held, "fake-probe")).records[0];
    check("a probe that always answers 200 cannot make a foreign port pass for ours", fake && fake.port !== held, JSON.stringify(fake));
    eq("and the server is running on the fresh port", fake?.running, true);

    const dead = powershell(serverHarness(siteRoot(true), held, "exhaust")).records[0];
    eq("three failed attempts on the same port throw NOT STARTED material", [dead?.notStarted, dead?.logs?.length, dead?.running], [true, 3, false]);
    check("the message says three attempts and carries every reason", /did not come up after 3 attempts \(port \d+: .*; port \d+: .*; port \d+: .*\)/s.test(dead?.message ?? ""), dead?.message);
  } finally {
    stop(foreign);
  }

  const missing = powershell(serverHarness(siteRoot(false), await freePort(), "missing")).records[0];
  eq("a listener that answers HTTP 404 is not retried", [missing?.notStarted, missing?.logs?.length, missing?.port === missing?.first], [true, 1, true]);
  check("the reason says it was an HTTP 404 and points at index.html", /HTTP 404/.test(missing?.message ?? "") && /index\.html/.test(missing?.message ?? ""), missing?.message);
  check("it does not claim three attempts", !/after 3 attempts/.test(missing?.message ?? ""), missing?.message);
}

function resultHarness() {
  const file = join(work, "result.ps1");
  writeFileSync(file, [
    importParts(join(SKILL, "driver.ps1"), ["Report-Error", "Get-ResultLine"], []),
    "$script:Out = @()",
    "function Out1($m) { $script:Out += [string]$m }",
    "function Case($checks, $failures, $ex) {",
    "  $script:Checks = $checks; $script:Failures = $failures; $script:Out = @()",
    "  $stop = $null",
    "  if ($ex) { $stop = Report-Error $ex }",
    "  Emit @{ stop = $stop; checks = $script:Checks; failures = $script:Failures; out = @($script:Out); line = (Get-ResultLine) }",
    "}",
    "$notStarted = New-Object System.Exception 'static server did not come up after 3 attempts (x)'",
    "$notStarted.Data['notStarted'] = $true",
    "Case 4 0 $null",
    "Case 3 1 $null",
    "Case 2 5 $null",
    "Case 0 0 $null",
    "Case 6 0 (New-Object System.Exception 'boom')",
    "Case 0 0 $notStarted",
    "[Environment]::Exit(0)"
  ].join("\n"));
  return file;
}

function driverStateChecks() {
  console.log("\ndriver.ps1's error report and result line:\n");
  const r = powershell(resultHarness()).records;
  eq("all passing is n/n", r[0]?.line, "RESULT: 4/4 checks passed");
  eq("one failure in three is 2/3 with the failed count", r[1]?.line, "RESULT: 2/3 checks passed - 1 FAILED");
  eq("more failures than checks never goes negative", r[2]?.line, "RESULT: 0/5 checks passed - 5 FAILED");
  eq("nothing ran is 0/0", r[3]?.line, "RESULT: 0/0 checks passed");
  eq("an ordinary error counts a failure, prints ERROR and does not stop the script", [r[4]?.stop, r[4]?.checks, r[4]?.failures, r[4]?.out], [false, 6, 1, ["ERROR: boom"]]);
  eq("a NOT STARTED error counts one failed check, prints NOT STARTED and stops the script", [r[5]?.stop, r[5]?.checks, r[5]?.failures, r[5]?.out, r[5]?.line], [true, 1, 1, ["NOT STARTED: static server did not come up after 3 attempts (x)"], "RESULT: 0/1 checks passed - 1 FAILED"]);
}

function laneSpec(name, lines, timedOut = false) {
  return { name, lines, timedOut };
}

const LANES = [
  laneSpec("good.txt", ["PASS a", "", "RESULT: 5/5 checks passed"]),
  laneSpec("notstarted.txt", ["NOT STARTED: static server did not come up after 3 attempts (port 1: boom)", "", "RESULT: 0/1 checks passed - 1 FAILED"]),
  laneSpec("timeout.txt", null, true),
  laneSpec("noresult.txt", ["started and went quiet"]),
  laneSpec("negative.txt", ["ERROR: x", "", "RESULT: -30/52 checks passed - 82 FAILED"]),
  laneSpec("garbage.txt", ["RESULT: garbage"]),
  laneSpec("zero.txt", ["RESULT: 0/0 checks passed"]),
  laneSpec("toomany.txt", ["RESULT: 6/5 checks passed"]),
  laneSpec("failing.txt", ["FAIL y", "", "RESULT: 3/5 checks passed - 2 FAILED"]),
  laneSpec("incomplete.txt", ["RESULT: 3/5 checks passed"])
];

function runnerHarness(selected, verdictOnly) {
  const specFile = join(work, "lanes.json");
  writeFileSync(specFile, JSON.stringify(selected));
  const file = join(work, `runner-${Math.random().toString(16).slice(2, 8)}.ps1`);
  const logs = join(work, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(file, [
    importParts(join(SKILL, "run-tests.ps1"), ["Count-FailedSuite", "Report-Lane", "Write-Verdict"], []),
    "function Clear-SplitpageEdge($t) {}",
    "$TimeoutSec = 180",
    `$logs = '${logs.replace(/'/g, "''")}'`,
    "$totalChecks = 0; $totalFail = 0; $suiteFail = 0",
    "$notStarted = New-Object System.Collections.ArrayList",
    `$spec = Get-Content -Raw '${specFile.replace(/'/g, "''")}' | ConvertFrom-Json`,
    "function Lane($s) {",
    `  $o = Join-Path '${logs.replace(/'/g, "''")}' ($s.name + '.out.txt')`,
    "  if ($s.lines) { Set-Content $o @($s.lines) -Encoding ascii } else { Remove-Item $o -ErrorAction SilentlyContinue }",
    "  Report-Lane ([pscustomobject]@{ File = [pscustomobject]@{ Name = $s.name }; Tag = 'x'; Out = $o; TimedOut = [bool]$s.timedOut })",
    "}",
    verdictOnly
      ? "foreach ($s in $spec) { Lane $s }\n$code = Write-Verdict $spec.Count\nEmit @{ code = $code; checks = $totalChecks; fail = $totalFail; suiteFail = $suiteFail; notStarted = @($notStarted) }"
      : "foreach ($s in $spec) {\n  $totalChecks = 0; $totalFail = 0; $suiteFail = 0; $notStarted.Clear()\n  Lane $s\n  Emit @{ name = $s.name; checks = $totalChecks; fail = $totalFail; suiteFail = $suiteFail; notStarted = @($notStarted) }\n}",
    "[Environment]::Exit(0)"
  ].join("\n"));
  return file;
}

function runnerChecks() {
  console.log("\nrun-tests.ps1's Report-Lane and verdict:\n");

  const each = Object.fromEntries(powershell(runnerHarness(LANES, false)).records.map((r) => [r.name, r]));
  const expected = {
    "good.txt": [5, 0, 0],
    "notstarted.txt": [1, 1, 1],
    "timeout.txt": [1, 1, 1],
    "noresult.txt": [1, 1, 1],
    "negative.txt": [1, 1, 1],
    "garbage.txt": [1, 1, 1],
    "zero.txt": [1, 1, 1],
    "toomany.txt": [1, 1, 1],
    "failing.txt": [5, 2, 1],
    "incomplete.txt": [5, 2, 1]
  };
  for (const [name, want] of Object.entries(expected)) {
    const r = each[name];
    eq(`${name}: checks, failed checks and failed suites are ${JSON.stringify(want)}`, [r?.checks, r?.fail, r?.suiteFail], want);
  }
  eq("only the NOT STARTED suite is listed as never started", Object.entries(each).filter(([, r]) => r.notStarted?.length).map(([n]) => n), ["notstarted.txt"]);

  const mixed = powershell(runnerHarness(LANES, true));
  const m = mixed.records[0];
  eq("a mixed run adds every suite to the totals", [m?.checks, m?.fail, m?.suiteFail], [5 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 5 + 5, 0 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 2 + 2, 9]);
  eq("it exits 1", m?.code, 1);
  check("its last lines say FAILED, the failed-suite count and the unstarted suite", /FAILED - 11\/22 checks passed across 10 suite\(s\), 9 suite\(s\) failed/.test(mixed.out) && /1 suite\(s\) never started and count as failed: notstarted\.txt/.test(mixed.out), mixed.out.slice(-600));

  const clean = powershell(runnerHarness([LANES[0], laneSpec("also.txt", ["RESULT: 2/2 checks passed"])], true));
  eq("a run where every suite passes exits 0", clean.records[0]?.code, 0);
  check("and says ALL PASS with the totals", /ALL PASS - 7\/7 checks across 2 suite\(s\)/.test(clean.out), clean.out.slice(-300));

  const zero = powershell(runnerHarness([LANES[0], LANES[6]], true));
  eq("a suite that ran no checks fails the run", zero.records[0]?.code, 1);
}

try {
  await serverChecks();
  driverStateChecks();
  runnerChecks();
} catch (e) {
  check("the checks ran to the end", false, e instanceof Error ? e.stack : String(e));
} finally {
  for (const c of children) stop(c);
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed, ${skipped} skipped on ${process.platform}\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
