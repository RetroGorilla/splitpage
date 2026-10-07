import { spawn, spawnSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { frozenWrites, withFreezeFlag } from "../.claude/skills/run-splitpage-app/freeze-flag.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER = join(REPO, "tools", "run-suites.mjs");
const DRIVER = join(REPO, ".claude", "skills", "run-splitpage-app", "driver.mjs");
const WRAPPER = join(REPO, ".claude", "handoff", "direction-b", "run-all-suites.mjs");
const { classify, STATUS, EXIT, parseArgs, portPlan, driverCommand, ConfigError } = await import(pathToFileURL(RUNNER).href);

const POSIX = process.platform !== "win32";
const BAD_RESULT = "BAD-RESULT";
const LEFTOVER = "LEFTOVER";
const RUNNER_ERROR = 3;

let passed = 0;
let skipped = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function skip(name, why) {
  skipped++;
  console.log(`  SKIP ${name} — ${why}`);
}

function configError(fn) {
  try { fn(); return false; }
  catch (e) { return e instanceof ConfigError; }
}

function argsError(argv, env) {
  return configError(() => parseArgs(argv, env));
}

function parsed(argv, env) {
  try { return parseArgs(argv, env); }
  catch (e) { return { error: e.message }; }
}

const work = mkdtempSync(join(tmpdir(), "splitpage-run-suites-"));
const suites = join(work, "suites");
mkdirSync(suites);
const KINDS = [
  "pass", "crlf", "split", "fail", "errored", "silent", "stderr", "lying",
  "zero", "garbage", "partial", "negative", "contradictory", "overwritten", "twice", "trailing", "long",
  "hang", "dupehang", "held", "orphan", "escaped", "afterhang", "nostart"
];
for (const name of KINDS) writeFileSync(join(suites, `${name}.txt`), "");

const fakeDriver = join(work, "fake-driver.mjs");
writeFileSync(fakeDriver, `
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync, existsSync } from "node:fs";
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
const waitForFile = (name, then) => {
  const started = Date.now();
  const poll = setInterval(() => {
    if (existsSync(join(state, name)) || Date.now() - started > 20000) { clearInterval(poll); then(); }
  }, 50);
};
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
  case "long": done(["RESULT: " + "x".repeat(5000)], 0); break;
  case "hang": {
    const grandchild = spawn(process.execPath, idle, { stdio: "ignore" });
    record({ grandchild: grandchild.pid });
    forever();
    break;
  }
  case "dupehang": say("RESULT: 1/1 checks passed"); say("RESULT: 2/2 checks passed"); forever(); break;
  case "held": waitForFile("release", () => done(["RESULT: 1/1 checks passed"], 0)); break;
  case "orphan": {
    const grandchild = spawn(process.execPath, idle, { stdio: ["ignore", "inherit", "inherit"] });
    record({ grandchild: grandchild.pid });
    done(["RESULT: 1/1 checks passed"], 0);
    break;
  }
  case "escaped": {
    const grandchild = spawn(process.execPath, idle, { stdio: ["ignore", "inherit", "inherit"], detached: true });
    record({ grandchild: grandchild.pid });
    forever();
    break;
  }
  case "afterhang": waitForFile("hang.json", () => done(["RESULT: 1/1 checks passed"], 0)); break;
  case "nostart": done(["NOT STARTED: static server did not come up after 3 attempts (port 1: EADDRINUSE; a fresh port: EADDRINUSE; a fresh port: EADDRINUSE)", "", "RESULT: 0/1 checks passed - 1 FAILED"], 1); break;
  default: done(["RESULT: unknown fake kind " + kind], 1);
}
`);

const states = [];
const reaped = new Set();
const runners = [];

const FIRST_FREE_BASE_TENS = 100;
const LAST_BASE_TENS = 1299;

function randomPortBase() {
  return 10 * (FIRST_FREE_BASE_TENS + Math.floor(Math.random() * (LAST_BASE_TENS - FIRST_FREE_BASE_TENS + 1)));
}

function newState() {
  const state = join(work, "state-" + Math.random().toString(16).slice(2, 10));
  mkdirSync(state);
  states.push(state);
  return state;
}

function readSummary(out) {
  const path = join(out, "summary.txt");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

function readLog(out, file) {
  const path = join(out, `${file}.log`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
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

function readRecord(path) {
  try { return { path, ...JSON.parse(readFileSync(path, "utf8")) }; }
  catch { return null; }
}

function recorded(state, kind) {
  return readRecord(join(state, `${kind}.json`));
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
  if (!info) return;
  reaped.add(info.path);
  for (const pid of [info.grandchild, info.driver]) {
    if (pidAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}

function cleanup() {
  for (const child of runners) {
    if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch {} }
  }
  for (const state of states) {
    let names = [];
    try { names = readdirSync(state); } catch {}
    for (const name of names) {
      const path = join(state, name);
      if (name.endsWith(".json") && !reaped.has(path)) reap(readRecord(path));
    }
  }
  rmSync(work, { recursive: true, force: true });
}

function runOnce(args, { portBase, timeout, runner, out, driver = fakeDriver, suiteDir = suites }) {
  const dir = out ?? join(work, "out-" + Math.random().toString(16).slice(2, 10));
  const state = newState();
  const argv = [runner, dir, ...args, "--suites", suiteDir, "--driver", driver, "--port-base", String(portBase)];
  const started = Date.now();
  const r = spawnSync(process.execPath, argv, {
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

function run(args, { portBase, timeout = 60000, runner = RUNNER, ...rest } = {}) {
  if (portBase !== undefined) return runOnce(args, { portBase, timeout, runner, ...rest });
  let r;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = runOnce(args, { portBase: randomPortBase(), timeout, runner, ...rest });
    if (!(r.status === EXIT.CONFIG && /port collision/.test(r.stderr))) break;
    console.log(`  note: random port block was busy, retrying (${r.stderr.trim()})`);
  }
  return r;
}

function start(args, { portBase, runner = RUNNER }) {
  const dir = join(work, "out-" + Math.random().toString(16).slice(2, 10));
  const state = newState();
  const child = spawn(process.execPath, [runner, dir, ...args, "--suites", suites, "--driver", fakeDriver, "--port-base", String(portBase)], {
    cwd: REPO,
    env: { ...process.env, FAKE_DRIVER_STATE: state },
    stdio: ["ignore", "pipe", "pipe"]
  });
  runners.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const closed = new Promise((resolveClose) => child.on("close", (code, signal) => resolveClose({ code, signal, stdout, stderr })));
  return { child, closed, state, out: dir };
}

function within(promise, ms) {
  let timer;
  const expired = new Promise((resolveExpired) => { timer = setTimeout(() => resolveExpired(null), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

function hold(port) {
  return new Promise((resolveHold, rejectHold) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", rejectHold);
    server.listen(port, "127.0.0.1", () => resolveHold(server));
  });
}

function blockPorts(portBase, lanes = 1) {
  const ports = [];
  for (let lane = 0; lane < lanes; lane++) {
    const http = 18100 + portBase + 10 * lane;
    const cdp = 19300 + portBase + 10 * lane;
    ports.push(http, http + 1, cdp, cdp + 1);
  }
  return ports;
}

async function freePortBase(offsets = [0]) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const portBase = randomPortBase();
    const ports = [...new Set(offsets.flatMap((offset) => blockPorts(portBase + offset)))];
    const held = [];
    for (const port of ports) {
      try { held.push(await hold(port)); }
      catch { break; }
    }
    await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
    if (held.length === ports.length) return portBase;
  }
  throw new Error("no free port block found");
}

async function holdInBlock(first) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const portBase = randomPortBase();
    try { return { portBase, port: first + portBase, server: await hold(first + portBase) }; }
    catch {}
  }
  throw new Error(`no free port near ${first} to occupy`);
}

function idleClient(port) {
  return new Promise((resolveClient) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.once("connect", () => resolveClient(socket));
    socket.once("close", () => resolveClient(socket));
  });
}

function unitChecks() {
  console.log("\nclassify():\n");

  const long = "RESULT: " + "x".repeat(5000);
  const dup = "RESULT: 1/1 checks passed\nRESULT: 2/2 checks passed";
  eq("exit 0 with a passing RESULT is PASS", classify({ code: 0 }, "x\nRESULT: 3/3 checks passed\n").status, STATUS.PASS);
  eq("exit 1 with FAILED in RESULT is FAIL", classify({ code: 1 }, "RESULT: 2/3 checks passed - 1 FAILED").status, STATUS.FAIL);
  eq("exit 0 with FAILED in RESULT is still FAIL", classify({ code: 0 }, "RESULT: 2/3 checks passed - 1 FAILED").status, STATUS.FAIL);
  eq("exit 1 with a passing RESULT is FAIL", classify({ code: 1 }, "RESULT: 3/3 checks passed").status, STATUS.FAIL);
  eq("no RESULT line is NO-RESULT", classify({ code: 0 }, "nothing here").status, STATUS.NO_RESULT);
  eq("timeout wins over a partial log", classify({ code: null, signal: "SIGKILL", timedOut: true }, "").status, STATUS.TIMEOUT);
  eq("launch error wins over everything", classify({ launchError: "ENOENT", timedOut: true }, "RESULT: 1/1 checks passed").status, STATUS.LAUNCH_ERROR);
  eq("two RESULT lines are BAD-RESULT, not the last one", classify({ code: 0 }, dup).status, BAD_RESULT);
  eq("0/0 is BAD-RESULT", classify({ code: 0 }, "RESULT: 0/0 checks passed").status, BAD_RESULT);
  eq("a count with a leading zero is BAD-RESULT", classify({ code: 0 }, "RESULT: 03/3 checks passed").status, BAD_RESULT);
  eq("a FAILED clause of zero is BAD-RESULT", classify({ code: 0 }, "RESULT: 3/3 checks passed - 0 FAILED").status, BAD_RESULT);
  eq("more passed than ran is BAD-RESULT", classify({ code: 0 }, "RESULT: 4/3 checks passed").status, BAD_RESULT);
  eq("a RESULT line that is not at the start of a line is not a summary", classify({ code: 0 }, "echo RESULT: 3/3 checks passed").status, STATUS.NO_RESULT);
  eq("the driver's error-before-any-check summary is FAIL", classify({ code: 1 }, "RESULT: -1/0 checks passed - 1 FAILED").status, STATUS.FAIL);
  const unstarted = classify({ code: 1 }, "NOT STARTED: static server did not come up after 3 attempts (port 9: EADDRINUSE)\n\nRESULT: 0/1 checks passed - 1 FAILED");
  eq("a suite that never started is NOT-STARTED, not FAIL", unstarted.status, STATUS.NOT_STARTED);
  check("a NOT-STARTED suite carries the driver's reason", unstarted.result.startsWith("static server did not come up after 3 attempts (port 9: EADDRINUSE)"), unstarted.result);
  eq("a NOT-STARTED suite is NOT-STARTED even with no RESULT line", classify({ code: 1 }, "NOT STARTED: boom").status, STATUS.NOT_STARTED);
  eq("a timeout still wins over NOT STARTED", classify({ code: null, signal: "SIGKILL", timedOut: true }, "NOT STARTED: boom").status, STATUS.TIMEOUT);
  eq("a NOT STARTED text that is not at the start of a line is ignored", classify({ code: 0 }, "echo NOT STARTED: boom\nRESULT: 3/3 checks passed").status, STATUS.PASS);
  eq("a passing summary killed by a signal is FAIL", classify({ code: null, signal: "SIGKILL" }, "RESULT: 3/3 checks passed").status, STATUS.FAIL);
  eq("output held open after exit is LEFTOVER", classify({ code: 0, heldOpen: true }, "RESULT: 3/3 checks passed").status, LEFTOVER);
  const timedOut = classify({ code: null, signal: "SIGKILL", timedOut: true, limitSec: 1 }, dup).result;
  check("a TIMEOUT after two RESULT lines says so", timedOut.includes("2 RESULT lines") && !timedOut.includes("no RESULT line"), timedOut);
  const held = classify({ code: 0, heldOpen: true }, dup).result;
  check("a LEFTOVER after two RESULT lines says so", held.includes("2 RESULT lines") && !held.includes("no RESULT line"), held);
  const malformed = classify({ code: 0 }, long).result;
  check("a 5000-character malformed line is quoted in at most about 200 characters", malformed.startsWith("malformed") && malformed.length < 260, `${malformed.length} characters`);
  const doubled = classify({ code: 0 }, `${long}\n${long}`).result;
  check("two 5000-character RESULT lines are quoted in at most about 200 characters each", doubled.startsWith("duplicate") && doubled.length < 520, `${doubled.length} characters`);

  console.log("\nparseArgs() and portPlan():\n");

  check("lanes below one is a config error", argsError(["o", "--lanes", "0"]), null);
  check("non-numeric port base is a config error", argsError(["o"], { PORT_BASE: "x" }), null);
  check("an invalid regex is a config error", argsError(["o", "["]), null);
  check("a flag without a value is a config error", argsError(["o", "--lanes"]), null);
  eq("env LANES is read when no flag is given", parsed(["o"], { LANES: "3" }).lanes, 3);
  eq("--lanes wins over env", parsed(["o", "--lanes", "2"], { LANES: "3" }).lanes, 2);
  check("an unknown flag is a config error", argsError(["o", "--laness", "1"]), null);
  check("a single-dash option is a config error", argsError(["o", "-x"]), null);
  check("a flag given twice is a config error", argsError(["o", "--lanes", "1", "--lanes", "2"]), null);
  eq("--flag=value is accepted", parsed(["o", "--lanes=2"]).lanes, 2);
  eq("-- ends the options", parsed(["o", "--", "-core"]).filter?.source, "-core");
  eq("--help asks for the usage", parsed(["o", "--laness", "--help"]).help, true);
  eq("-h asks for the usage", parsed(["-h"]).help, true);
  eq("-h after -- is a filter, not a request for help", parsed(["o", "--", "-h"]).filter?.source, "-h");
  check("a padded lane count is a config error", argsError(["o"], { LANES: " 2" }), null);
  check("a fractional lane count is a config error", argsError(["o", "--lanes", "1.5"]), null);
  check("600.0 is a config error", argsError(["o", "--timeout", "600.0"]), null);
  check("1e1 is a config error", argsError(["o", "--timeout", "1e1"]), null);
  check("a hexadecimal timeout is a config error", argsError(["o", "--timeout", "0x10"]), null);
  check("a timeout beyond one day is a config error", argsError(["o", "--timeout", "86401"]), null);
  check("a port base past the port range is a config error", argsError(["o", "--port-base", "999999999"]), null);
  check("port base 5009 is a config error", argsError(["o", "--port-base", "5009"]), null);
  check("port base 5001 is a config error", argsError(["o", "--port-base", "5001"]), null);
  check("PORT_BASE 5009 is a config error", argsError(["o"], { PORT_BASE: "5009" }), null);
  eq("port base 5000 is accepted", parsed(["o", "--port-base", "5000"]).portBase, 5000);
  check("a port base is not rejected for lanes a run will not use", !argsError(["o", "--port-base", "46230"]), null);
  check("port base 46230 fits one lane", !configError(() => portPlan(46230, 1)), null);
  check("port base 46230 does not fit two lanes", configError(() => portPlan(46230, 2)), null);
  check("121 lanes whose HTTP and CDP ports overlap are a config error", configError(() => portPlan(0, 121)), null);
  check("120 lanes do not overlap", !configError(() => portPlan(0, 120)), null);
  const plan = portPlan(5000, 2);
  eq("lane 1 reserves HTTP + 1", plan[1]?.httpReserve, 23111);
  eq("lane 1 reserves CDP + 1", plan[1]?.cdpReserve, 24311);

  console.log("\ncache freezing:\n");

  eq("caches are not frozen by default", parsed(["o"], {}).freezeCaches, false);
  eq("SPLITPAGE_FREEZE_CACHES=1 freezes them", parsed(["o"], { SPLITPAGE_FREEZE_CACHES: "1" }).freezeCaches, true);
  eq("any other value does not", [parsed(["o"], { SPLITPAGE_FREEZE_CACHES: "0" }).freezeCaches, parsed(["o"], { SPLITPAGE_FREEZE_CACHES: "true" }).freezeCaches].join(), "false,false");
  const command = (env) => {
    const config = parsed(["o"], env);
    return driverCommand({ ...config, ports: portPlan(0, 1) }, "x.txt", 0).args;
  };
  eq("with freezing on, the driver gets --freeze-caches once", command({ SPLITPAGE_FREEZE_CACHES: "1" }).filter((a) => a === "--freeze-caches").length, 1);
  eq("with it off, the driver's arguments are as before", command({}).includes("--freeze-caches"), false);
  eq("the flag goes into the query", withFreezeFlag("http://localhost:1/index.html"), "http://localhost:1/index.html?freeze-caches=1");
  eq("after a query the page already has", withFreezeFlag("http://localhost:1/index.html?wizard=1&teleprompter=1"), "http://localhost:1/index.html?wizard=1&teleprompter=1&freeze-caches=1");
  eq("and before the fragment", withFreezeFlag("http://localhost:1/index.html?teleprompter=1#script=ab&voice=1"), "http://localhost:1/index.html?teleprompter=1&freeze-caches=1#script=ab&voice=1");
  eq("a fragment with no query", withFreezeFlag("http://localhost:1/index.html#review=abc"), "http://localhost:1/index.html?freeze-caches=1#review=abc");
  eq("a page that names the flag itself is left as it is", withFreezeFlag("http://localhost:1/index.html?freeze-caches=0"), "http://localhost:1/index.html?freeze-caches=0");
  eq("a question mark inside the fragment is not a query", withFreezeFlag("http://localhost:1/index.html#a?b"), "http://localhost:1/index.html?freeze-caches=1#a?b");
  eq("only page exceptions that write into a frozen value are frozen writes", JSON.stringify(frozenWrites([
    "log: fine",
    "error: Cannot assign to read only property 'id' of object",
    "exception: TypeError: Cannot assign to read only property 'id' of object '#<Object>'",
    "exception: TypeError: Cannot add property 3, object is not extensible",
    "exception: TypeError: Cannot delete property 'x' of #<Object>",
    "exception: ReferenceError: x is not defined"
  ])), JSON.stringify([
    "exception: TypeError: Cannot assign to read only property 'id' of object '#<Object>'",
    "exception: TypeError: Cannot add property 3, object is not extensible",
    "exception: TypeError: Cannot delete property 'x' of #<Object>"
  ]));
}

async function processChecks() {
  console.log("\nrun-suites.mjs as a process:\n");

  {
    const r = run(["^pass"]);
    eq("all passing suites exit 0", r.status, EXIT.OK);
    eq("summary lists the passing suite", r.summary?.[0], "PASS pass.txt RESULT: 3/3 checks passed");
    check("a per-suite log is written", existsSync(join(r.out, "pass.txt.log")), null);
    check("stdout reports ALL PASS", r.stdout.includes("ALL PASS"), r.stdout);
  }

  for (const flag of ["--help", "-h"]) {
    const r = run([flag]);
    eq(`${flag} exits 0`, r.status, EXIT.OK);
    check(`${flag} prints the usage`, r.stdout.includes("usage:") && r.stdout.includes("--port-base"), r.stdout);
    eq(`${flag} spawns nothing`, spawnedKinds(r.state).length, 0);
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
      "long.txt": [BAD_RESULT, "malformed"],
      "partial.txt": [BAD_RESULT, "incomplete"],
      "negative.txt": [BAD_RESULT, "negative"],
      "contradictory.txt": [BAD_RESULT, "contradictory"],
      "overwritten.txt": [BAD_RESULT, "duplicate"],
      "twice.txt": [BAD_RESULT, "duplicate"],
      "trailing.txt": [BAD_RESULT, "trailing output"],
      "stderr.txt": [STATUS.NO_RESULT, "no RESULT line"],
      "errored.txt": [STATUS.FAIL, "RESULT: -1/0 checks passed - 1 FAILED"]
    };
    const r = run(["^(zero|garbage|long|partial|negative|contradictory|overwritten|twice|trailing|stderr|errored)\\.txt$"]);
    eq("invalid summaries make the process exit 1", r.status, EXIT.SUITES_FAILED);
    eq("every invalid-summary suite is in summary.txt", r.summary?.length, Object.keys(expected).length);
    const files = byFile(r.summary);
    for (const [file, [status, reason]] of Object.entries(expected)) {
      eq(`${file} is ${status}`, files[file]?.status, status);
      check(`${file} says ${JSON.stringify(reason)}`, (files[file]?.result ?? "").startsWith(reason), files[file]?.result);
    }
    check("long.txt's summary line stays short", (files["long.txt"]?.result ?? "").length < 260, `${files["long.txt"]?.result?.length} characters`);
    check("no invalid summary is reported as passing", !r.stdout.includes("ALL PASS") && !(r.summary || []).some((l) => l.startsWith("PASS ")), r.stdout);
    check("each invalid-summary suite still has its log", Object.keys(expected).every((f) => existsSync(join(r.out, `${f}.log`))), null);
  }

  {
    const r = run(["^(pass|nostart)\\.txt$", "--lanes", "2"]);
    eq("a suite that never started makes the process exit 1", r.status, EXIT.SUITES_FAILED);
    eq("the unstarted suite stays in summary.txt", r.summary?.length, 2);
    const files = byFile(r.summary);
    eq("nostart.txt is NOT-STARTED", files["nostart.txt"]?.status, STATUS.NOT_STARTED);
    check("nostart.txt says why", (files["nostart.txt"]?.result ?? "").startsWith("static server did not come up after 3 attempts"), files["nostart.txt"]?.result);
    eq("pass.txt is still PASS", files["pass.txt"]?.status, STATUS.PASS);
    check("stdout counts both suites as having run", r.stdout.includes("2 of 2 suites ran, 1 passed"), r.stdout);
    check("stdout names the suite that never started", /1 of those never started and count as failed: nostart\.txt/.test(r.stdout), r.stdout);
    check("stdout does not say ALL PASS", !r.stdout.includes("ALL PASS"), r.stdout);
  }

  {
    const script = join(work, "open-only.txt");
    writeFileSync(script, "open\nexpect 1\nexpect 2\n");
    const missing = join(work, "no-such-browser");
    const driverRun = (port, extra = []) => spawnSync(process.execPath, [
      DRIVER, "--script", script, "--port", String(port), "--cdp-port", String(port + 1200),
      "--shot-dir", join(work, "shots"), "--chrome", missing, ...extra
    ], { cwd: REPO, encoding: "utf8", timeout: 30000 });
    const { port, server } = await holdInBlock(18100);
    try {
      const busy = driverRun(port);
      const upOn = /server up on http:\/\/localhost:(\d+)\//.exec(busy.stderr);
      check("a busy port is retried on a fresh one", upOn !== null && Number(upOn[1]) !== port, busy.stderr);
      check("the retry's own failure is the browser, not the server", /ERROR: --chrome not found/.test(busy.stdout) && !/NOT STARTED/.test(busy.stdout), busy.stdout);
      check("the failed first attempt is logged", /static server attempt 1 of 3 failed: port \d+: EADDRINUSE/.test(busy.stderr), busy.stderr);
    } finally {
      server.close();
    }
    const never = driverRun(18100, ["--bind", "203.0.113.1"]);
    check("a server that cannot start names the attempts", /NOT STARTED: static server did not come up after 3 attempts \(port 18100: \w+; a fresh port: \w+; a fresh port: \w+\)/.test(never.stdout), never.stdout);
    check("it is counted as one failed check", /RESULT: 0\/1 checks passed - 1 FAILED/.test(never.stdout), never.stdout);
    check("it stops instead of failing every later check", !/RESULT: 0\/3/.test(never.stdout) && !/FAIL expect/.test(never.stdout), never.stdout);
    eq("it exits 1", never.status, 1);
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
    const r = run(["^pass", "--lanes", "200"]);
    eq("200 lanes are fine when one suite uses one of them", r.status, EXIT.OK);
  }

  {
    const r = run(["^pass", "--laness", "1"]);
    eq("an unknown flag exits 2", r.status, EXIT.CONFIG);
    check("an unknown flag is named", r.stderr.includes("--laness"), r.stderr);
    eq("an unknown flag spawns nothing", spawnedKinds(r.state).length, 0);
    eq("an unknown flag writes no summary", r.summary, null);
  }

  for (const portBase of [999999999, 5009, 5001]) {
    const r = run(["^pass"], { portBase });
    eq(`port base ${portBase} exits 2`, r.status, EXIT.CONFIG);
    if (portBase !== 999999999) check(`port base ${portBase} says it must be a multiple of 10`, /multiple of 10/.test(r.stderr), r.stderr);
    eq(`port base ${portBase} spawns nothing`, spawnedKinds(r.state).length, 0);
    eq(`port base ${portBase} writes no summary`, r.summary, null);
  }

  for (const [first, name] of [[18100, "HTTP"], [19300, "CDP"], [18101, "HTTP reservation"], [19301, "CDP reservation"]]) {
    const { portBase, port, server } = await holdInBlock(first);
    try {
      const r = run(["^pass", "--lanes", "1"], { portBase });
      eq(`a busy ${name} port exits 2`, r.status, EXIT.CONFIG);
      check(`a busy ${name} port is named as a collision`, r.stderr.includes(String(port)) && /port collision/.test(r.stderr), r.stderr);
      eq(`a busy ${name} port spawns nothing`, spawnedKinds(r.state).length, 0);
    } finally {
      server.close();
    }
  }

  {
    const portBase = await freePortBase([0, 10, 1200]);
    const first = start(["^held", "--lanes", "1", "--timeout", "60"], { portBase });
    const clients = [];
    try {
      const running = await waitFor(() => spawnedKinds(first.state).length > 0, 10000);
      check("the first invocation started its suite", running, null);
      const same = run(["^pass", "--lanes", "1"], { portBase });
      eq("a second invocation on the same ports exits 2", same.status, EXIT.CONFIG);
      check("the second invocation names the collision", /port collision/.test(same.stderr), same.stderr);
      eq("the second invocation spawns nothing", spawnedKinds(same.state).length, 0);
      const shifted = run(["^pass", "--lanes", "1"], { portBase: portBase + 1200 });
      eq("an invocation whose HTTP ports are the first one's CDP ports exits 2", shifted.status, EXIT.CONFIG);
      check("that collision is found on the shared reservation port", shifted.stderr.includes(String(19301 + portBase)), shifted.stderr);
      eq("that invocation spawns nothing", spawnedKinds(shifted.state).length, 0);
      const adjacent = run(["^pass", "--lanes", "1"], { portBase: portBase + 10 });
      eq("an invocation on the next block of 10 runs alongside", adjacent.status, EXIT.OK);
      clients.push(await idleClient(18101 + portBase), await idleClient(19301 + portBase));
      writeFileSync(join(first.state, "release"), "");
      const done = await within(first.closed, 20000);
      check("idle clients on the reservation ports do not keep the runner alive", done !== null, first.child.pid);
      eq("the first invocation still passes", done?.code, EXIT.OK);
    } finally {
      for (const c of clients) c.destroy();
    }
  }

  {
    const r = run(["^hang", "--timeout", "1"]);
    const info = recorded(r.state, "hang");
    eq("a hung suite exits 1", r.status, EXIT.SUITES_FAILED);
    eq("a hung suite is TIMEOUT", r.summary?.[0]?.split(" ")[0], STATUS.TIMEOUT);
    check("a hung suite settles within its bound", r.elapsed < 12000, `${r.elapsed}ms`);
    check("a hung suite keeps its log", existsSync(join(r.out, "hang.txt.log")), null);
    check("the fake driver reported its grandchild", info?.grandchild > 0, JSON.stringify(info));
    check("the grandchild was killed with its parent", waitDead(info?.grandchild), `pid ${info?.grandchild} still alive`);
    check("the hung driver was killed", waitDead(info?.driver), `pid ${info?.driver} still alive`);
    reap(info);
  }

  {
    const r = run(["^dupehang", "--timeout", "1"]);
    const line = r.summary?.[0] ?? "";
    eq("a hung suite that printed two RESULT lines is TIMEOUT", line.split(" ")[0], STATUS.TIMEOUT);
    check("its TIMEOUT says 2 RESULT lines", line.includes("2 RESULT lines") && !line.includes("no RESULT line"), line);
  }

  for (const timeout of ["1", "60"]) {
    const r = run(["^orphan", "--timeout", timeout], { timeout: 30000 });
    const info = recorded(r.state, "orphan");
    check(`--timeout ${timeout}: a driver that exits leaving a grandchild settles`, r.signal === null && r.status !== null, `runner killed after ${r.elapsed}ms`);
    check(`--timeout ${timeout}: a driver that exits leaving a grandchild settles within 15s`, r.elapsed < 15000, `${r.elapsed}ms`);
    check(`--timeout ${timeout}: the orphaning driver reported its grandchild`, info?.grandchild > 0, JSON.stringify(info));
    if (POSIX) {
      eq(`--timeout ${timeout}: a held-open suite exits 1`, r.status, EXIT.SUITES_FAILED);
      eq(`--timeout ${timeout}: a held-open suite is LEFTOVER`, r.summary?.[0]?.split(" ")[0], LEFTOVER);
      check(`--timeout ${timeout}: its log says the process group was killed`, readLog(r.out, "orphan.txt").includes("killing what is left of its process group"), readLog(r.out, "orphan.txt"));
      check(`--timeout ${timeout}: the grandchild left in the process group is gone`, waitDead(info?.grandchild), `pid ${info?.grandchild} still alive`);
    } else {
      skip(`--timeout ${timeout}: a held-open suite is LEFTOVER and its grandchild is killed`, "win32 has no process groups and libuv ends a Node driver's children when it exits, so nothing is left holding the pipes; this runs on the Linux CI");
    }
    reap(info);
  }

  {
    const r = run(["^escaped", "--timeout", "1"], { timeout: 30000 });
    const info = recorded(r.state, "escaped");
    check("a descendant outside the process group cannot hold the runner open", r.signal === null && r.status !== null, `runner killed after ${r.elapsed}ms`);
    eq("a suite whose output outlives the kill is TIMEOUT", r.summary?.[0]?.split(" ")[0], STATUS.TIMEOUT);
    check("a suite whose output outlives the kill settles within 12s", r.elapsed < 12000, `${r.elapsed}ms`);
    check("the escaping driver reported its grandchild", info?.driver > 0 && info?.grandchild > 0, JSON.stringify(info));
    check("the escaped driver itself was killed", waitDead(info?.driver), `pid ${info?.driver} still alive`);
    reap(info);
  }

  {
    const out = join(work, "out-" + Math.random().toString(16).slice(2, 10));
    mkdirSync(join(out, "afterhang.txt.log"), { recursive: true });
    const r = run(["^(afterhang|hang)\\.txt$", "--lanes", "2", "--timeout", "60"], { out, timeout: 30000 });
    const info = recorded(r.state, "hang");
    eq("a log that cannot be written stops the run with exit 3", r.status, RUNNER_ERROR);
    check("the write failure is reported", /afterhang\.txt\.log/.test(r.stderr), r.stderr);
    check("the run stops well before the other suite's timeout", r.elapsed < 15000, `${r.elapsed}ms`);
    check("no summary claims a result after the failure", !existsSync(join(out, "summary.txt")), null);
    check("the other lane's driver had started", info?.driver > 0 && info?.grandchild > 0, JSON.stringify(info));
    check("the other lane's driver is killed", waitDead(info?.driver), `pid ${info?.driver} still alive`);
    check("the other lane's grandchild is killed", waitDead(info?.grandchild), `pid ${info?.grandchild} still alive`);
    reap(info);
  }

  for (const [signal, code, runner, who] of [["SIGINT", 130, RUNNER, "the runner"], ["SIGTERM", 143, RUNNER, "the runner"], ["SIGTERM", 143, WRAPPER, "the compatibility wrapper"]]) {
    const name = `${signal} to ${who}`;
    if (!POSIX) {
      skip(`${name} stops the run and kills its drivers`, "win32 cannot deliver a catchable SIGINT/SIGTERM to a child process, so this runs on the Linux CI");
      continue;
    }
    const running = start(["^hang", "--timeout", "60"], { runner, portBase: await freePortBase() });
    const ready = await waitFor(() => recorded(running.state, "hang") !== null, 10000);
    const info = recorded(running.state, "hang");
    check(`${name}: the hung suite started`, ready && info?.driver > 0 && info?.grandchild > 0, JSON.stringify(info));
    const sent = Date.now();
    running.child.kill(signal);
    const done = await within(running.closed, 15000);
    check(`${name}: exits promptly`, done !== null, `${Date.now() - sent}ms`);
    eq(`${name}: exits ${code}`, done?.code, code);
    check(`${name}: the driver is killed`, waitDead(info?.driver), `pid ${info?.driver} still alive`);
    check(`${name}: the driver's grandchild is killed`, waitDead(info?.grandchild), `pid ${info?.grandchild} still alive`);
    reap(info);
  }

  {
    const r = run(["^pass", "--node", join(work, "no-such-node")]);
    eq("an unlaunchable driver exits 1", r.status, EXIT.SUITES_FAILED);
    eq("an unlaunchable driver is LAUNCH-ERROR", r.summary?.[0]?.split(" ")[0], STATUS.LAUNCH_ERROR);
  }

  {
    const r = run(["^pass"], { driver: join(work, "no-such-driver.mjs") });
    eq("a missing driver exits 2", r.status, EXIT.CONFIG);
    check("a missing driver is named", r.stderr.includes("driver not found"), r.stderr);
    const s = run(["^pass"], { suiteDir: join(work, "no-such-suites") });
    eq("a missing suite folder exits 2", s.status, EXIT.CONFIG);
    check("a missing suite folder is named", s.stderr.includes("suite directory not found"), s.stderr);
  }

  {
    const r = run(["^(pass|fail)\\.txt$", "--lanes", "1"]);
    eq("a single lane runs every suite", r.summary?.length, 2);
  }

  {
    const ok = run(["^pass"], { runner: WRAPPER });
    eq("the compatibility wrapper passes a passing run through", ok.status, EXIT.OK);
    eq("the compatibility wrapper writes the same summary", ok.summary?.[0], "PASS pass.txt RESULT: 3/3 checks passed");
    const bad = run(["^pass", "--lanes", "0"], { runner: WRAPPER });
    eq("the compatibility wrapper passes a config error through", bad.status, EXIT.CONFIG);
  }
}

try {
  unitChecks();
  await processChecks();
} catch (e) {
  check("the checks ran to the end", false, e instanceof Error ? e.stack : String(e));
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failures.length} failed, ${skipped} skipped on ${process.platform}\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
