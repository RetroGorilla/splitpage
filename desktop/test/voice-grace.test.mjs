import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { parseHelperLine } = require(path.join(here, "..", "voice-helper.js"));

if (process.platform !== "win32") {
  console.log("SKIP - needs Windows PowerShell and System.Speech");
  process.exit(0);
}

const scenarios = {
  silentStart: [
    ["Problem", 0, "no-signal"], ["Tick", 250], ["Tick", 1000], ["Tick", 2000],
    ["Tick", 4750], ["Tick", 5000], ["Tick", 5250]
  ],
  mutedMic: [
    ["Problem", 0, "no-signal"], ["Level", 1000, 0], ["Level", 3000, 0], ["Tick", 4999],
    ["Tick", 5000], ["Level", 6000, 0], ["Level", 7000, 12], ["Level", 7100, 12]
  ],
  quietRoomWorkingMic: [
    ["Problem", 0, "no-signal"], ["Level", 1000, 1], ["Tick", 5000], ["Tick", 9000], ["Tick", 20000]
  ],
  laterNoSignal: [
    ["Level", 4000, 3], ["Problem", 6000, "no-signal"], ["Tick", 8750], ["Tick", 9000],
    ["Problem", 9500, "no-signal"], ["Heard", 10000], ["Heard", 10500]
  ],
  quietOnce: [
    ["Problem", 6000, "too-quiet"], ["Tick", 11000], ["Tick", 30000]
  ],
  quietKeepsOn: [
    ["Problem", 6000, "too-quiet"], ["Problem", 8000, "too-quiet"], ["Problem", 11000, "too-quiet"],
    ["Problem", 12000, "too-quiet"], ["Level", 12500, 40], ["Heard", 13000]
  ],
  quietThenWords: [
    ["Problem", 6000, "too-quiet"], ["Heard", 7000], ["Problem", 11500, "too-quiet"],
    ["Problem", 12500, "too-quiet"], ["Problem", 16500, "too-quiet"]
  ],
  quietInGrace: [
    ["Problem", 1000, "too-quiet"], ["Problem", 4000, "too-quiet"], ["Problem", 6000, "too-quiet"]
  ]
};

const consentScenarios = {
  allAllowed: { "hklm-all": "Allow", "hkcu-all": "Allow", "hkcu-desktop": "Allow" },
  neverSet: {},
  hklmDenied: { "hklm-all": "Deny", "hkcu-all": "Allow", "hkcu-desktop": "Allow" },
  hkcuAllDenied: { "hkcu-all": "Deny", "hkcu-desktop": "Allow" },
  hkcuDesktopDenied: { "hkcu-all": "Allow", "hkcu-desktop": "Deny" },
  deviceWideWinsOverDesktopAllow: { "hklm-all": "Deny", "hkcu-desktop": "Allow" }
};

const listen = fs.readFileSync(path.join(here, "..", "voice", "listen.ps1"), "utf8").replace(/\r\n/g, "\n");
const block = /-TypeDefinition @'\n([\s\S]*?)\n'@/.exec(listen);
if (!block) {
  console.log("FAIL - listen.ps1 has no Add-Type -TypeDefinition @'...'@ block");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-voice-grace-"));
const csFile = path.join(dir, "shim.cs");
const stepsFile = path.join(dir, "steps.json");
const consentFile = path.join(dir, "consent.json");
const psFile = path.join(dir, "run.ps1");
fs.writeFileSync(csFile, block[1]);
fs.writeFileSync(stepsFile, JSON.stringify(Object.keys(scenarios).map((k) => scenarios[k])));
fs.writeFileSync(consentFile, JSON.stringify(Object.keys(consentScenarios).map((k) => consentScenarios[k])));
fs.writeFileSync(psFile, [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  `Add-Type -ReferencedAssemblies System.Speech -TypeDefinition ([IO.File]::ReadAllText('${csFile}'))`,
  `$all = [IO.File]::ReadAllText('${stepsFile}') | ConvertFrom-Json`,
  "foreach ($steps in $all) {",
  "  $g = New-Object SplitpageVoiceGrace 0",
  "  $out = foreach ($s in $steps) {",
  "    $r = switch ($s[0]) {",
  "      'Problem' { $g.Problem([long]$s[1], [string]$s[2]) }",
  "      'Level'   { $g.Level([long]$s[1], [int]$s[2]) }",
  "      'Heard'   { $g.Heard([long]$s[1]) }",
  "      'Tick'    { $g.Tick([long]$s[1]) }",
  "    }",
  "    if ($null -eq $r) { '-' } else { $r }",
  "  }",
  "  [Console]::Out.WriteLine(($out -join ' '))",
  "}",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "[Console]::Out.WriteLine('device:' + [SplitpageVoiceDevice]::DefaultCaptureName())",
  `$consentAll = [IO.File]::ReadAllText('${consentFile}') | ConvertFrom-Json`,
  "foreach ($map in $consentAll) {",
  "  $values = @{}",
  "  foreach ($p in $map.PSObject.Properties) { $values[$p.Name] = $p.Value }",
  "  $reader = [Func[string,string]]{ param($key) if ($values.ContainsKey($key)) { $values[$key] } else { $null } }",
  "  $code = [SplitpageVoiceConsent]::Check($reader)",
  "  [Console]::Out.WriteLine('consent:' + $(if ($null -eq $code) { '-' } else { $code }))",
  "}"
].join("\r\n"));

const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const run = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psFile],
  { encoding: "utf8", windowsHide: true, timeout: 60000 });
fs.rmSync(dir, { recursive: true, force: true });
if (run.status !== 0) {
  console.log("FAIL - compiling or driving SplitpageVoiceGrace\n" + (run.stderr || run.stdout || run.error));
  process.exit(1);
}
const lines = run.stdout.trim().split(/\r?\n/);
const got = {};
Object.keys(scenarios).forEach((k, i) => { got[k] = (lines[i] || "").split(" "); });
const deviceLine = lines[Object.keys(scenarios).length] || "";
const consentGot = {};
Object.keys(consentScenarios).forEach((k, i) => {
  consentGot[k] = (lines[Object.keys(scenarios).length + 1 + i] || "").replace(/^consent:/, "");
});

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("staying silent after starting shows nothing for the whole grace period", () => {
  assert.deepEqual(got.silentStart.slice(0, 5), ["-", "-", "-", "-", "-"]);
});

test("a mic that hears nothing still gets no-signal once the grace period is over, once", () => {
  assert.deepEqual(got.silentStart.slice(5), ["no-signal", "-"]);
  assert.deepEqual(got.mutedMic, ["-", "-", "-", "-", "no-signal", "-", "clear", "-"]);
});

test("any audio level above the floor means the mic works: no-signal never shown", () => {
  assert.deepEqual(got.quietRoomWorkingMic, ["-", "-", "-", "-", "-"]);
});

test("no-signal later on waits for five seconds without audio, and words clear it", () => {
  assert.deepEqual(got.laterNoSignal, ["-", "-", "-", "no-signal", "-", "clear", "-"]);
});

test("one quiet moment never flashes too-quiet", () => {
  assert.deepEqual(got.quietOnce, ["-", "-", "-"]);
});

test("too-quiet said again after the grace period is shown once; audio alone does not clear it, words do", () => {
  assert.deepEqual(got.quietKeepsOn, ["-", "-", "too-quiet", "-", "-", "clear"]);
});

test("words in between start the too-quiet wait again", () => {
  assert.deepEqual(got.quietThenWords, ["-", "-", "-", "-", "too-quiet"]);
});

test("too-quiet is never shown within the first five seconds", () => {
  assert.deepEqual(got.quietInGrace, ["-", "-", "too-quiet"]);
});

test("the helper passes clear through to the page", () => {
  assert.deepEqual(parseHelperLine('{"type":"warning","code":"clear"}'), { type: "warning", code: "clear" });
});

test("the default microphone's name is read without starting anything (#118)", () => {
  assert.ok(deviceLine.startsWith("device:"), deviceLine);
  const name = deviceLine.slice("device:".length);
  assert.equal(name, name.trim());
  console.log("       default microphone: " + (name || "(none)"));
});

test("nothing denied, or never set, is not blocked (#134)", () => {
  assert.equal(consentGot.allAllowed, "-");
  assert.equal(consentGot.neverSet, "-");
});

test("the device-wide switch off is blocked-all, however the per-user ones read", () => {
  assert.equal(consentGot.hklmDenied, "blocked-all");
  assert.equal(consentGot.deviceWideWinsOverDesktopAllow, "blocked-all");
});

test("this user's own microphone switch off is blocked-all", () => {
  assert.equal(consentGot.hkcuAllDenied, "blocked-all");
});

test("only \"let desktop apps\" off, with the rest allowed, is blocked-desktop", () => {
  assert.equal(consentGot.hkcuDesktopDenied, "blocked-desktop");
});

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log("ok   - " + c.name);
  } catch (err) {
    failures.push(c.name);
    console.log("FAIL - " + c.name + "\n       " + (err && err.stack || err));
  }
}
console.log("");
if (failures.length) {
  console.log(`FAILURES (${failures.length} of ${cases.length})`);
  process.exit(1);
}
console.log(`ALL PASS (${cases.length} cases)`);
