import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER = join(REPO, "tools", "run-suites.mjs");
const { classify, STATUS, EXIT, parseArgs, ConfigError } = await import(pathToFileURL(RUNNER).href);

const BAD_RESULT = "BAD-RESULT";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function configError(argv, env) {
  try { parseArgs(argv, env); return false; }
  catch (e) { return e instanceof ConfigError; }
}

const work = mkdtempSync(join(tmpdir(), "splitpage-run-suites-"));
const suites = join(work, "suites");
mkdirSync(suites);
const KINDS = [
  "pass", "crlf", "split", "fail", "errored", "silent", "stderr", "lying",
  "zero", "garbage", "partial", "negative", "contradictory", "overwritten", "twice", "trailing",
  "hang"
];
for (const name of KINDS) writeFileSync(join(suites, `${name}.txt`), "");

const fakeDriver = join(work, "fake-driver.mjs");
writeFileSync(fakeDriver, `
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const kind = basename(arg("--script"), ".txt");
const state = process.env.FAKE_DRIVER_STATE;
appendFileSync(join(state, "spawned.log"), kind + " " + arg("--port") + " " + arg("--cdp-port") + "\\n");
const say = (text) => process.stdout.write(text + "\\n");
const record = (extra) => writeFileSync(join(state, kind + ".json"), JSON.stringify({ driver: process.pid, ...extra }));
const idle = ["-e", "setInterval(() => {}, 1000)"];
const forever = () => setInterval(() => {}, 1000);
const done = (lines, code) => { for (const line of lines) say(line); process.exit(code); };
switch (kind) {
  case "pass": done(["RESULT: 3/3 checks passed"], 0); break;
  case "crlf": process.stdout.write("PASS a\\r\\n\\r\\nRESULT: 4/4 checks passed\\r\\n"); process.exit(0); break;
  case "split": process.stdout.write("RESU"); setTimeout(() => done(["LT: 2/2 checks passed"], 0), 200); break;
  case "fail": done(["RESULT: 2/3 checks passed - 1 FAILED"], 1); break;
  case "errored": done(["ERROR: boom", "", "RESULT: -1/0 checks passed - 1 FAILED"], 1); break;
  case "silent": done(["started but never summarised"], 0); break;
  case "stderr": process.stderr.write("RESULT: 3/3 checks passed\\n"); process.exit(0); break;
  case "lying": done(["RESULT: 3/3 checks passed"], 1); break;
  case "zero": done(["RESULT: 0/0 checks passed"], 0); break;
  case "garbage": done(["RESULT: garbage"], 0); break;
  case "partial": done(["RESULT: 1/3 checks passed"], 0); break;
  case "negative": done(["RESULT: -1/3 checks passed"], 0); break;
  case "contradictory": done(["RESULT: 2/3 checks passed - 2 FAILED"], 1); break;
  case "overwritten": done(["RESULT: 3/3 checks passed - 1 FAILED", "RESULT: fine"], 0); break;
  case "twice": done(["RESULT: 1/1 checks passed", "RESULT: 2/2 checks passed"], 0); break;
  case "trailing": done(["RESULT: 3/3 checks passed", "late output"], 0); break;
  case "hang": {
    const grandchild = spawn(process.execPath, idle, { stdio: "ignore" });
    record({ grandchild: grandchild.pid });
    forever();
    break;
  }
  default: done(["RESULT: unknown fake kind " + kind], 1);
}
`);

function newState() {
  const state = join(work, "state-" + Math.random().toString(16).slice(2, 10));
  mkdirSync(state);
  return state;
}

function readSummary(out) {
  const path = join(out, "summary.txt");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

function byFile(summary) {
  const map = {};
  for (const line of summary || []) {
    const [status, file, ...rest] = line.split(" ");
    map[file] = { status, result: rest.join(" ") };
  }
  return map;
}

function spawnedKinds(state) {
  const path = join(state, "spawned.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

function recorded(state, kind) {
  const path = join(state, `${kind}.json`);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function pidAlive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitDead(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(100);
  return !pidAlive(pid);
}

function reap(info) {
  for (const pid of [info?.grandchild, info?.driver]) {
    if (pidAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}

function run(args, { timeout = 60000 } = {}) {
  const dir = join(work, "out-" + Math.random().toString(16).slice(2, 10));
  const state = newState();
  const started = Date.now();
  const r = spawnSync(process.execPath, [RUNNER, dir, ...args, "--suites", suites, "--driver", fakeDriver], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, FAKE_DRIVER_STATE: state },
    timeout
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    elapsed: Date.now() - started,
    summary: readSummary(dir),
    out: dir,
    state
  };
}

console.log("\nclassify():\n");

eq("exit 0 with a passing RESULT is PASS", classify({ code: 0 }, "x\nRESULT: 3/3 checks passed\n").status, STATUS.PASS);
eq("exit 1 with FAILED in RESULT is FAIL", classify({ code: 1 }, "RESULT: 2/3 checks passed - 1 FAILED").status, STATUS.FAIL);
eq("exit 0 with FAILED in RESULT is still FAIL", classify({ code: 0 }, "RESULT: 2/3 checks passed - 1 FAILED").status, STATUS.FAIL);
eq("exit 1 with a passing RESULT is FAIL", classify({ code: 1 }, "RESULT: 3/3 checks passed").status, STATUS.FAIL);
eq("no RESULT line is NO-RESULT", classify({ code: 0 }, "nothing here").status, STATUS.NO_RESULT);
eq("timeout wins over a partial log", classify({ code: null, signal: "SIGKILL", timedOut: true }, "").status, STATUS.TIMEOUT);
eq("launch error wins over everything", classify({ launchError: "ENOENT", timedOut: true }, "RESULT: 1/1 checks passed").status, STATUS.LAUNCH_ERROR);
eq("two RESULT lines are BAD-RESULT, not the last one", classify({ code: 0 }, "RESULT: 1/1 checks passed\nRESULT: 2/2 checks passed").status, BAD_RESULT);
eq("0/0 is BAD-RESULT", classify({ code: 0 }, "RESULT: 0/0 checks passed").status, BAD_RESULT);
eq("a count with a leading zero is BAD-RESULT", classify({ code: 0 }, "RESULT: 03/3 checks passed").status, BAD_RESULT);
eq("a FAILED clause of zero is BAD-RESULT", classify({ code: 0 }, "RESULT: 3/3 checks passed - 0 FAILED").status, BAD_RESULT);
eq("more passed than ran is BAD-RESULT", classify({ code: 0 }, "RESULT: 4/3 checks passed").status, BAD_RESULT);
eq("a RESULT line that is not at the start of a line is not a summary", classify({ code: 0 }, "echo RESULT: 3/3 checks passed").status, STATUS.NO_RESULT);
eq("the driver's error-before-any-check summary is FAIL", classify({ code: 1 }, "RESULT: -1/0 checks passed - 1 FAILED").status, STATUS.FAIL);
eq("a passing summary killed by a signal is FAIL", classify({ code: null, signal: "SIGKILL" }, "RESULT: 3/3 checks passed").status, STATUS.FAIL);

console.log("\nparseArgs():\n");

check("lanes below one is a config error", configError(["o", "--lanes", "0"]), null);
check("non-numeric port base is a config error", configError(["o"], { PORT_BASE: "x" }), null);
check("an invalid regex is a config error", configError(["o", "["]), null);
check("a flag without a value is a config error", configError(["o", "--lanes"]), null);
eq("env LANES is read when no flag is given", parseArgs(["o"], { LANES: "3" }).lanes, 3);
eq("--lanes wins over env", parseArgs(["o", "--lanes", "2"], { LANES: "3" }).lanes, 2);

console.log("\nrun-suites.mjs as a process:\n");

{
  const r = run(["^pass"]);
  eq("all passing suites exit 0", r.status, EXIT.OK);
  eq("summary lists the passing suite", r.summary?.[0], "PASS pass.txt RESULT: 3/3 checks passed");
  check("a per-suite log is written", existsSync(join(r.out, "pass.txt.log")), null);
  check("stdout reports ALL PASS", r.stdout.includes("ALL PASS"), r.stdout);
}

{
  const r = run(["^(pass|crlf|split)\\.txt$", "--lanes", "3"]);
  eq("CRLF output and a summary split across writes still pass", r.status, EXIT.OK);
  const files = byFile(r.summary);
  eq("crlf.txt is PASS", files["crlf.txt"]?.status, STATUS.PASS);
  eq("split.txt is PASS", files["split.txt"]?.status, STATUS.PASS);
}

{
  const r = run(["^(pass|fail|silent|lying)\\.txt$"]);
  eq("one failing suite makes the process exit 1", r.status, EXIT.SUITES_FAILED);
  const files = byFile(r.summary);
  eq("fail.txt is FAIL", files["fail.txt"]?.status, STATUS.FAIL);
  eq("pass.txt is PASS", files["pass.txt"]?.status, STATUS.PASS);
  eq("silent.txt is NO-RESULT", files["silent.txt"]?.status, STATUS.NO_RESULT);
  eq("lying.txt is FAIL despite its RESULT line", files["lying.txt"]?.status, STATUS.FAIL);
  check("lying.txt names the exit status", /\(exit 1\)$/.test(files["lying.txt"]?.result ?? ""), files["lying.txt"]?.result);
  check("stdout does not say ALL PASS", !r.stdout.includes("ALL PASS"), r.stdout);
}

{
  const expected = {
    "zero.txt": [BAD_RESULT, "zero checks"],
    "garbage.txt": [BAD_RESULT, "malformed"],
    "partial.txt": [BAD_RESULT, "incomplete"],
    "negative.txt": [BAD_RESULT, "negative"],
    "contradictory.txt": [BAD_RESULT, "contradictory"],
    "overwritten.txt": [BAD_RESULT, "duplicate"],
    "twice.txt": [BAD_RESULT, "duplicate"],
    "trailing.txt": [BAD_RESULT, "trailing output"],
    "stderr.txt": [STATUS.NO_RESULT, "no RESULT line"],
    "errored.txt": [STATUS.FAIL, "RESULT: -1/0 checks passed - 1 FAILED"]
  };
  const r = run(["^(zero|garbage|partial|negative|contradictory|overwritten|twice|trailing|stderr|errored)\\.txt$"]);
  eq("invalid summaries make the process exit 1", r.status, EXIT.SUITES_FAILED);
  eq("every invalid-summary suite is in summary.txt", r.summary?.length, Object.keys(expected).length);
  const files = byFile(r.summary);
  for (const [file, [status, reason]] of Object.entries(expected)) {
    eq(`${file} is ${status}`, files[file]?.status, status);
    check(`${file} says ${JSON.stringify(reason)}`, (files[file]?.result ?? "").startsWith(reason), files[file]?.result);
  }
  check("no invalid summary is reported as passing", !r.stdout.includes("ALL PASS") && !(r.summary || []).some((l) => l.startsWith("PASS ")), r.stdout);
  check("each invalid-summary suite still has its log", Object.keys(expected).every((f) => existsSync(join(r.out, `${f}.log`))), null);
}

{
  const r = run(["^nothing-matches"]);
  eq("zero matching suites exit 2", r.status, EXIT.CONFIG);
  check("zero suites does not say ALL PASS", !r.stdout.includes("ALL PASS"), r.stdout);
  check("zero suites names the problem", r.stderr.includes("no suites matched"), r.stderr);
}

{
  const r = run(["^pass", "--lanes", "0"]);
  eq("invalid lane count exits 2", r.status, EXIT.CONFIG);
  eq("invalid lane count spawns nothing", spawnedKinds(r.state).length, 0);
}

{
  const r = run(["^hang", "--timeout", "1"]);
  eq("a hung suite exits 1", r.status, EXIT.SUITES_FAILED);
  eq("a hung suite is TIMEOUT", r.summary?.[0]?.split(" ")[0], STATUS.TIMEOUT);
  check("a hung suite settles within its bound", r.elapsed < 12000, `${r.elapsed}ms`);
  const log = existsSync(join(r.out, "hang.txt.log")) ? readFileSync(join(r.out, "hang.txt.log"), "utf8") : "";
  check("a hung suite keeps its log", existsSync(join(r.out, "hang.txt.log")), log);
  const info = recorded(r.state, "hang");
  check("the fake driver reported its grandchild", info?.grandchild > 0, JSON.stringify(info));
  if (info?.grandchild > 0) {
    check("the grandchild was killed with its parent", waitDead(info.grandchild), `pid ${info.grandchild} still alive`);
    check("the hung driver was killed", waitDead(info.driver), `pid ${info.driver} still alive`);
  }
  reap(info);
}

{
  const r = run(["^pass", "--node", join(work, "no-such-node")]);
  eq("an unlaunchable driver exits 1", r.status, EXIT.SUITES_FAILED);
  eq("an unlaunchable driver is LAUNCH-ERROR", r.summary?.[0]?.split(" ")[0], STATUS.LAUNCH_ERROR);
}

{
  const r = run(["^(pass|fail)\\.txt$", "--lanes", "1"]);
  eq("a single lane runs every suite", r.summary?.length, 2);
}

rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed on ${process.platform}\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
