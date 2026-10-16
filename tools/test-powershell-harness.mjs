import { spawn, spawnSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
    "$ResultToken = ''",
    "Case 4 0 $null",
    "Case 3 1 $null",
    "Case 2 5 $null",
    "Case 0 0 $null",
    "Case 6 0 (New-Object System.Exception 'boom')",
    "Case 0 0 $notStarted",
    "$ResultToken = 'abc123'",
    "Case 4 0 $null",
    "Case 3 1 $null",
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
  eq("with a run token the result line ends with it", [r[6]?.line, r[7]?.line], ["RESULT: 4/4 checks passed [run abc123]", "RESULT: 2/3 checks passed - 1 FAILED [run abc123]"]);
}

function imeHarness() {
  const file = join(work, "ime.ps1");
  writeFileSync(file, "﻿" + [
    importParts(join(SKILL, "driver.ps1"), ["Ime-Input", "Invoke-Line"], []),
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$script:Sent = @()",
    "$script:Out = @()",
    "function Send-Cdp($method, $params) { $script:Sent += ,@{ method = $method; params = $params }; return $null }",
    "function Out1($m) { $script:Out += [string]$m }",
    "function Case($line) {",
    "  $script:Sent = @(); $script:Out = @(); $err = $null",
    "  try { $null = Invoke-Line $line } catch { $err = $_.Exception.Message }",
    "  Emit @{ sent = @($script:Sent); out = @($script:Out); err = $err }",
    "}",
    "Case 'ime set か'",
    "Case 'ime set かな'",
    "Case 'ime commit かな'",
    "Case 'ime cancel'",
    "Case 'ime set  two words '",
    "Case 'ime commit'",
    "Case 'ime nonsense'",
    "Case 'ime'",
    "[Environment]::Exit(0)"
  ].join("\n"), "utf8");
  return file;
}

function imeChecks() {
  console.log("\ndriver.ps1's ime verb:\n");
  const r = powershell(imeHarness()).records.map((rec) => ({
    ...rec,
    sent: (rec.sent ?? []).map((s) => ({ method: s.method, params: Object.fromEntries(Object.entries(s.params ?? {}).sort(([a], [b]) => a.localeCompare(b))) }))
  }));
  const set = (text) => ({ method: "Input.imeSetComposition", params: { selectionEnd: text.length, selectionStart: text.length, text } });
  eq("ime set sends one imeSetComposition with the caret at the end of the marked text", r[0]?.sent, [set("か")]);
  eq("a longer composition is one more imeSetComposition, not an insert", r[1]?.sent, [set("かな")]);
  eq("ime commit sends the text through insertText", r[2]?.sent, [{ method: "Input.insertText", params: { text: "かな" } }]);
  eq("ime cancel sets an empty composition", r[3]?.sent, [set("")]);
  eq("the text after `set ` keeps its leading space; the script line's trailing space is trimmed", r[4]?.sent, [set(" two words")]);
  eq("ime commit with no text commits an empty string", r[5]?.sent, [{ method: "Input.insertText", params: { text: "" } }]);
  eq("each call says what it sent", [r[0]?.out, r[2]?.out, r[3]?.out], [["ime set 1 chars"], ["ime commit 2 chars"], ["ime cancel 0 chars"]]);
  eq("an unknown ime form throws and sends nothing", [r[6]?.err, r[6]?.sent, r[7]?.err, r[7]?.sent],
    ["ime needs: set <text> | commit <text> | cancel", [], "ime needs: set <text> | commit <text> | cancel", []]);
}

function freezeHarness() {
  const file = join(work, "freeze.ps1");
  writeFileSync(file, [
    importParts(join(SKILL, "driver.ps1"), ["Add-FreezeFlag", "Test-FrozenWrites"], []),
    importParts(join(SKILL, "run-tests.ps1"), ["Get-DriverArgs"], []),
    "function Out1($m) { $script:Out += [string]$m }",
    "function Writes($lines) { $script:Console = @($lines); $script:Checks = 0; $script:Failures = 0; $script:Out = @(); Test-FrozenWrites; Emit @{ checks = $script:Checks; failures = $script:Failures; out = @($script:Out) } }",
    "Writes @('log: fine', 'error: Cannot assign to read only property ''id'' of object')",
    "Writes @('log: fine', 'exception: TypeError: Cannot assign to read only property ''id'' of object ''#<Object>''', 'exception: TypeError: Cannot add property 3, object is not extensible', 'exception: ReferenceError: x is not defined')",
    "$here = 'C:\\skill'; $Port = 100; $CdpPort = 200; $Headed = $false",
    "$lane = [pscustomobject]@{ Index = 3; Tag = 'abc'; Token = 'tok'; File = [pscustomobject]@{ FullName = 'C:\\s\\x.txt' } }",
    "foreach ($u in @('http://localhost:1/index.html', 'http://localhost:1/index.html?wizard=1&teleprompter=1', 'http://localhost:1/index.html?teleprompter=1#script=ab&voice=1', 'http://localhost:1/index.html#review=abc', 'http://localhost:1/index.html?freeze-caches=0', 'http://localhost:1/index.html#a?b')) { Emit @{ url = (Add-FreezeFlag $u) } }",
    "$FreezeCaches = $false; Emit @{ args = @(Get-DriverArgs $lane) }",
    "$FreezeCaches = $true; Emit @{ args = @(Get-DriverArgs $lane) }",
    "[Environment]::Exit(0)"
  ].join("\n"));
  return file;
}

function freezeChecks() {
  console.log("\ncache freezing in driver.ps1 and run-tests.ps1:\n");
  const all = powershell(freezeHarness()).records;
  const [clean, thrown] = all.slice(0, 2);
  eq("Test-FrozenWrites passes one check when no page exception is a write into a frozen value", [clean?.checks, clean?.failures, clean?.out], [1, 0, ["PASS no write into a frozen cache value threw"]]);
  eq("and fails it, quoting each such exception and no other, when one is",
    [thrown?.checks, thrown?.failures, thrown?.out], [1, 1, [
      "FAIL a write into a frozen cache value threw",
      "     exception: TypeError: Cannot assign to read only property 'id' of object '#<Object>'",
      "     exception: TypeError: Cannot add property 3, object is not extensible"
    ]]);
  const r = all.slice(2);
  eq("Add-FreezeFlag puts freeze-caches=1 in the query, after any query the page has and before any fragment, and leaves a page that names it alone",
    r.slice(0, 6).map((x) => x.url), [
      "http://localhost:1/index.html?freeze-caches=1",
      "http://localhost:1/index.html?wizard=1&teleprompter=1&freeze-caches=1",
      "http://localhost:1/index.html?teleprompter=1&freeze-caches=1#script=ab&voice=1",
      "http://localhost:1/index.html?freeze-caches=1#review=abc",
      "http://localhost:1/index.html?freeze-caches=0",
      "http://localhost:1/index.html?freeze-caches=1#a?b"
    ]);
  const off = (r[6]?.args ?? []).flat(), on = (r[7]?.args ?? []).flat();
  eq("with freezing off, run-tests.ps1 starts driver.ps1 as before", [off.includes("-FreezeCaches"), off.slice(-2)], [false, ["-RunId", "abc"]]);
  eq("with it on, it adds -FreezeCaches once", [on.filter((a) => a === "-FreezeCaches").length, on.slice(0, -1)], [1, off]);
  eq("run-tests.ps1 hands the lane's token to driver.ps1", off.slice(off.indexOf("-ResultToken"), off.indexOf("-ResultToken") + 2), ["-ResultToken", "tok"]);
}

function laneSpec(name, lines, timedOut = false) {
  return { name, lines, timedOut };
}

const TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const done = (summary) => `RESULT: ${summary} [run ${TOKEN}]`;

const LANES = [
  laneSpec("good.txt", ["PASS a", "", done("5/5 checks passed")]),
  laneSpec("notstarted.txt", ["NOT STARTED: static server did not come up after 3 attempts (port 1: boom)", "", done("0/1 checks passed - 1 FAILED")]),
  laneSpec("timeout.txt", null, true),
  laneSpec("noresult.txt", ["started and went quiet"]),
  laneSpec("negative.txt", ["ERROR: x", "", done("-30/52 checks passed - 82 FAILED")]),
  laneSpec("garbage.txt", [done("garbage")]),
  laneSpec("zero.txt", [done("0/0 checks passed")]),
  laneSpec("toomany.txt", [done("6/5 checks passed")]),
  laneSpec("failing.txt", ["FAIL y", "", done("3/5 checks passed - 2 FAILED")]),
  laneSpec("incomplete.txt", [done("3/5 checks passed")])
];

const FORGED = [
  laneSpec("forged-then-killed.txt", ["RESULT: 9/9 checks passed", "FAIL a later check"]),
  laneSpec("forged-then-real.txt", ["RESULT: 9/9 checks passed", "FAIL a later check", "", done("8/9 checks passed - 1 FAILED")]),
  laneSpec("forged-tokenless-last.txt", ["PASS a", "", done("2/2 checks passed"), "RESULT: 1/9 checks passed - 8 FAILED"]),
  laneSpec("wrong-token.txt", ["PASS a", "", `RESULT: 2/2 checks passed [run ${"f".repeat(32)}]`])
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
    "$totalChecks = 0; $totalFail = 0; $suiteFail = 0; $laneVerdicts = @()",
    "$notStarted = New-Object System.Collections.ArrayList",
    `$spec = Get-Content -Raw '${specFile.replace(/'/g, "''")}' | ConvertFrom-Json`,
    "function Lane($s) {",
    `  $o = Join-Path '${logs.replace(/'/g, "''")}' ($s.name + '.out.txt')`,
    "  if ($s.lines) { Set-Content $o @($s.lines) -Encoding ascii } else { Remove-Item $o -ErrorAction SilentlyContinue }",
    `  Report-Lane ([pscustomobject]@{ File = [pscustomobject]@{ Name = $s.name }; Tag = 'x'; Token = '${TOKEN}'; Out = $o; TimedOut = [bool]$s.timedOut })`,
    "}",
    verdictOnly
      ? "foreach ($s in $spec) { Lane $s }\n$code = Write-Verdict $spec.Count\nEmit @{ code = $code; checks = $totalChecks; fail = $totalFail; suiteFail = $suiteFail; notStarted = @($notStarted) }"
      : "foreach ($s in $spec) {\n  $totalChecks = 0; $totalFail = 0; $suiteFail = 0; $notStarted.Clear()\n  Lane $s\n  Emit @{ name = $s.name; checks = $totalChecks; fail = $totalFail; suiteFail = $suiteFail; notStarted = @($notStarted); result = $laneVerdicts[-1].result }\n}",
    "[Environment]::Exit(0)"
  ].join("\n"));
  return file;
}

function finishHarness() {
  const file = join(work, "finish.ps1");
  writeFileSync(file, [
    importParts(join(SKILL, "run-tests.ps1"), ["Test-LaneFinished"], []),
    "$TimeoutSec = 180",
    `$token = '${TOKEN}'`,
    "function Probe($name, $lines) {",
    `  $o = Join-Path '${work.replace(/'/g, "''")}' ($name + '.out.txt')`,
    "  Set-Content $o @($lines) -Encoding ascii",
    "  $lane = [pscustomobject]@{ Token = $token; Out = $o; Proc = [pscustomobject]@{ HasExited = $false }; Watch = [Diagnostics.Stopwatch]::StartNew(); Done = $false; DoneAt = $null; TimedOut = $false }",
    "  $r = Test-LaneFinished $lane",
    "  Emit @{ name = $name; done = $lane.Done }",
    "}",
    "Probe 'quiet' @('PASS a')",
    "Probe 'forged' @('PASS a', 'RESULT: 9/9 checks passed')",
    "Probe 'wrong' @('PASS a', ('RESULT: 2/2 checks passed [run ' + ('f' * 32) + ']'))",
    "Probe 'real' @('PASS a', '', ('RESULT: 2/2 checks passed [run ' + $token + ']'))",
    "[Environment]::Exit(0)"
  ].join("\n"));
  return file;
}

function digestHarness(scenario) {
  const file = join(work, `digest-${scenario}.ps1`);
  const logs = join(work, `digest-logs-${scenario}`);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "a.out.txt"), "PASS a\n\nRESULT: 1/1 checks passed\n");
  writeFileSync(join(logs, "b.out.txt"), "PASS b\n\nRESULT: 1/1 checks passed\n");
  const verdicts = {
    good: "[pscustomobject]@{ name = 'a'; failed = $false; timedOut = $false; checks = 1; failedChecks = 0 }, [pscustomobject]@{ name = 'b'; failed = $false; timedOut = $false; checks = 1; failedChecks = 0 }",
    "missing-verdict": "[pscustomobject]@{ name = 'a'; failed = $false; timedOut = $false; checks = 1; failedChecks = 0 }",
    "bad-counts": "[pscustomobject]@{ name = 'a'; failed = $true; timedOut = $false; checks = 1; failedChecks = 5 }, [pscustomobject]@{ name = 'b'; failed = $false; timedOut = $false; checks = 1; failedChecks = 0 }"
  }[scenario];
  writeFileSync(file, [
    importParts(join(SKILL, "run-tests.ps1"), ["Write-Digest"], []),
    "$TimeoutSec = 180",
    `$here = '${SKILL.replace(/'/g, "''")}'`,
    `$logs = '${logs.replace(/'/g, "''")}'`,
    "$files = @([pscustomobject]@{ BaseName = 'a' }, [pscustomobject]@{ BaseName = 'b' })",
    `$laneVerdicts = @(${verdicts})`,
    "Write-Digest",
    "[Environment]::Exit(0)"
  ].join("\n"));
  return { file, logs };
}

function digestChecks() {
  console.log("\nrun-tests.ps1's Write-Digest:\n");
  const lastLine = (out) => out.split(/\r?\n/).filter((l) => l.trim() !== "").pop();

  const good = digestHarness("good");
  const ok = powershell(good.file);
  eq("a digest that is written ends the output with its path", lastLine(ok.out), join(good.logs, "digest.txt"));
  check("and says nothing about a refusal", !/digest not written/.test(ok.out), ok.out);

  for (const scenario of ["missing-verdict", "bad-counts"]) {
    const bad = digestHarness(scenario);
    const r = powershell(bad.file);
    check(`a verdicts file the digest tool refuses (${scenario}) is said on stdout with the exit code`, /digest not written: failure-digest\.mjs exited with code 1 \(see stderr\)/.test(r.out), r.out);
    check(`${scenario}: the refusal reason is on stderr`, /failure-digest: invalid verdicts/.test(r.err), r.err);
    eq(`${scenario}: no digest.txt is written and no path is printed`, [existsSync(join(bad.logs, "digest.txt")), /digest\.txt/.test(r.out)], [false, false]);
  }
}

function digestFlowHarness() {
  const file = join(work, "digest-flow.ps1");
  const logs = join(work, "digest-flow-logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "failing.out.txt"), `PASS a\nFAIL b\n\n${done("3/5 checks passed - 2 FAILED")}\n`);
  writeFileSync(join(logs, "failing.err.txt"), "");
  writeFileSync(join(logs, "forged-dead.out.txt"), "PASS a\nRESULT: 9/9 checks passed\nFAIL a later check\n");
  writeFileSync(join(logs, "forged-dead.err.txt"), "[driver] CDP socket closed\n[driver] fatal: edge crashed\n");
  writeFileSync(file, [
    importParts(join(SKILL, "run-tests.ps1"), ["Count-FailedSuite", "Report-Lane", "Write-Digest"], []),
    "function Clear-SplitpageEdge($t) {}",
    "$TimeoutSec = 180",
    `$here = '${SKILL.replace(/'/g, "''")}'`,
    `$logs = '${logs.replace(/'/g, "''")}'`,
    "$totalChecks = 0; $totalFail = 0; $suiteFail = 0; $laneVerdicts = @()",
    "$notStarted = New-Object System.Collections.ArrayList",
    "$files = @([pscustomobject]@{ BaseName = 'failing' }, [pscustomobject]@{ BaseName = 'forged-dead' })",
    "foreach ($f in $files) {",
    `  Report-Lane ([pscustomobject]@{ File = [pscustomobject]@{ Name = $f.BaseName + '.txt' }; Tag = 'x'; Token = '${TOKEN}'; Out = (Join-Path $logs ($f.BaseName + '.out.txt')); TimedOut = $false })`,
    "}",
    "Write-Digest",
    "[Environment]::Exit(0)"
  ].join("\n"));
  return { file, logs };
}

function laneHarness() {
  const file = join(work, "lanes-new.ps1");
  writeFileSync(file, [
    importParts(join(SKILL, "run-tests.ps1"), ["New-Lane"], []),
    "$RunId = 'abcd1234'",
    "$logs = 'C:\\logs'",
    "$i = 0",
    "foreach ($n in 1..6) { $i++; $l = New-Lane ([pscustomobject]@{ BaseName = \"s$n\"; Name = \"s$n.txt\" }) $i; Emit @{ index = $l.Index; tag = $l.Tag; token = $l.Token; out = $l.Out } }",
    "[Environment]::Exit(0)"
  ].join("\n"));
  return file;
}

function digestFlowChecks() {
  console.log("\nthe digest that run-tests.ps1 writes from its own verdicts:\n");
  const flow = digestFlowHarness();
  const r = powershell(flow.file);
  const digestPath = join(flow.logs, "digest.txt");
  const digest = existsSync(digestPath) ? readFileSync(digestPath, "utf8") : "";
  const headlines = digest.split(/\r?\n/).filter((l) => l.startsWith("== suite"));
  eq("a failing suite's digest headline has no run token", headlines[0], "== suite failing: RESULT: 3/5 checks passed - 2 FAILED");
  check("the token is nowhere in the digest", digest !== "" && !digest.includes(TOKEN) && !digest.includes("[run "), digest + r.out + r.err);
  check("a driver that died after a RESULT line the page printed has no forged headline", headlines[1] !== undefined && !headlines[1].includes("9/9"), headlines[1]);
  check("and the digest shows its stderr tail with the crash reason", digest.includes("  e [driver] fatal: edge crashed"), digest);

  const lanes = powershell(laneHarness()).records;
  check("every lane gets a 32-hex token", lanes.length === 6 && lanes.every((l) => /^[0-9a-f]{32}$/.test(l.token ?? "")), JSON.stringify(lanes.map((l) => l.token)));
  eq("and no two lanes share a token", new Set(lanes.map((l) => l.token)).size, lanes.length);
  eq("a lane's tag carries the run id and its number, and its log sits in the log directory", [lanes[2]?.tag, lanes[2]?.out], ["abcd1234s03", "C:\\logs\\s3.out.txt"]);
}

function runnerChecks() {
  console.log("\nrun-tests.ps1's Report-Lane and verdict:\n");

  const forgedRuns = Object.fromEntries(powershell(runnerHarness(FORGED, false)).records.map((r) => [r.name, r]));
  const forgedWant = {
    "forged-then-killed.txt": [1, 1, 1],
    "forged-then-real.txt": [9, 1, 1],
    "forged-tokenless-last.txt": [2, 0, 0],
    "wrong-token.txt": [1, 1, 1]
  };
  const forgedWhy = {
    "forged-then-killed.txt": "a RESULT line the page printed is not the driver's verdict, so a driver that never reported fails",
    "forged-then-real.txt": "the driver's own line wins over an earlier RESULT line the page printed",
    "forged-tokenless-last.txt": "a RESULT line without the run's token is ignored even when it is last",
    "wrong-token.txt": "a RESULT line carrying another run's token is not this run's verdict"
  };
  for (const [name, want] of Object.entries(forgedWant)) {
    const r = forgedRuns[name];
    eq(`${name}: ${forgedWhy[name]} ([checks, failed checks, failed suites] ${JSON.stringify(want)})`, [r?.checks, r?.fail, r?.suiteFail], want);
  }

  eq("each verdict carries the driver's own result line without the token, and null when the driver left none",
    Object.fromEntries(Object.keys(forgedWant).map((n) => [n, forgedRuns[n] && "result" in forgedRuns[n] ? forgedRuns[n].result : "(missing)"])), {
      "forged-then-killed.txt": null,
      "forged-then-real.txt": "RESULT: 8/9 checks passed - 1 FAILED",
      "forged-tokenless-last.txt": "RESULT: 2/2 checks passed",
      "wrong-token.txt": null
    });

  const finished = Object.fromEntries(powershell(finishHarness()).records.map((r) => [r.name, r.done]));
  eq("a lane is finished when the driver's tokened RESULT line appears, and not for a forged, another run's or no RESULT line", [finished.quiet, finished.forged, finished.wrong, finished.real], [false, false, false, true]);

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

  const clean = powershell(runnerHarness([LANES[0], laneSpec("also.txt", [done("2/2 checks passed")])], true));
  eq("a run where every suite passes exits 0", clean.records[0]?.code, 0);
  check("and says ALL PASS with the totals", /ALL PASS - 7\/7 checks across 2 suite\(s\)/.test(clean.out), clean.out.slice(-300));
  check("and shows each suite's result line without the token", /RESULT: 2\/2 checks passed\s*$/m.test(clean.out) && !clean.out.includes("[run"), clean.out.slice(-300));

  const zero = powershell(runnerHarness([LANES[0], LANES[6]], true));
  eq("a suite that ran no checks fails the run", zero.records[0]?.code, 1);

  const staleTemp = join(work, "stale-temp");
  const staleLogs = join(staleTemp, "splitpage-testlogs");
  mkdirSync(staleLogs, { recursive: true });
  writeFileSync(join(staleLogs, "digest.txt"), "ALL PASS - 9/9 checks across 1 suite(s)\n");
  writeFileSync(join(staleLogs, "verdicts.json"), "{}");
  const aborted = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(SKILL, "run-tests.ps1"), "-Only", "zzz"], {
    encoding: "utf8", timeout: 60000, windowsHide: true, env: { ...process.env, TEMP: staleTemp, TMP: staleTemp }
  });
  eq("a run that aborts before any suite exits 1", aborted.status, 1);
  eq("and leaves no digest.txt or verdicts.json from an earlier run", [existsSync(join(staleLogs, "digest.txt")), existsSync(join(staleLogs, "verdicts.json"))], [false, false]);
  check("and prints no digest path", !/digest\.txt/.test(aborted.stdout ?? ""), aborted.stdout);
}

try {
  await serverChecks();
  driverStateChecks();
  imeChecks();
  freezeChecks();
  runnerChecks();
  digestChecks();
  digestFlowChecks();
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
