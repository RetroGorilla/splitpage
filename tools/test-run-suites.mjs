import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER = join(REPO, "tools", "run-suites.mjs");
const { classify, STATUS, EXIT, parseArgs, ConfigError } = await import(pathToFileURL(RUNNER).href);

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

const work = mkdtempSync(join(tmpdir(), "splitpage-run-suites-"));
const suites = join(work, "suites");
mkdirSync(suites);
for (const name of ["pass", "fail", "silent", "lying", "hang"]) writeFileSync(join(suites, `${name}.txt`), "");

const fakeDriver = join(work, "fake-driver.mjs");
writeFileSync(fakeDriver, `
import { spawn } from "node:child_process";
import { basename } from "node:path";
const script = process.argv[process.argv.indexOf("--script") + 1];
const kind = basename(script, ".txt");
if (kind === "pass") { console.log("RESULT: 3/3 checks passed"); process.exit(0); }
if (kind === "fail") { console.log("RESULT: 2/3 checks passed - 1 FAILED"); process.exit(1); }
if (kind === "silent") { console.log("started but never summarised"); process.exit(0); }
if (kind === "lying") { console.log("RESULT: 3/3 checks passed"); process.exit(1); }
if (kind === "hang") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  console.log("GRANDCHILD " + grandchild.pid);
  setInterval(() => {}, 1000);
}
`);

function run(args, extraEnv = {}) {
  const out = join(work, "out-" + Math.random().toString(16).slice(2, 8));
  const r = spawnSync(process.execPath, [RUNNER, out, ...args, "--suites", suites, "--driver", fakeDriver], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 60000
  });
  const summary = existsSync(join(out, "summary.txt")) ? readFileSync(join(out, "summary.txt"), "utf8").trim().split("\n") : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary, out };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

console.log("\nclassify():\n");

eq("exit 0 with a passing RESULT is PASS", classify({ code: 0 }, "x\nRESULT: 3/3 checks passed\n").status, STATUS.PASS);
eq("exit 1 with FAILED in RESULT is FAIL", classify({ code: 1 }, "RESULT: 2/3 checks passed - 1 FAILED").status, STATUS.FAIL);
eq("exit 0 with FAILED in RESULT is still FAIL", classify({ code: 0 }, "RESULT: 2/3 checks passed - 1 FAILED").status, STATUS.FAIL);
eq("exit 1 with a passing RESULT is FAIL", classify({ code: 1 }, "RESULT: 3/3 checks passed").status, STATUS.FAIL);
eq("no RESULT line is NO-RESULT", classify({ code: 0 }, "nothing here").status, STATUS.NO_RESULT);
eq("timeout wins over a partial log", classify({ code: null, signal: "SIGKILL", timedOut: true }, "").status, STATUS.TIMEOUT);
eq("launch error wins over everything", classify({ launchError: "ENOENT", timedOut: true }, "RESULT: 1/1 checks passed").status, STATUS.LAUNCH_ERROR);
eq("the last RESULT line is the one reported", classify({ code: 0 }, "RESULT: 1/1 checks passed\nRESULT: 2/2 checks passed").result, "RESULT: 2/2 checks passed");

console.log("\nparseArgs():\n");

check("lanes below one is a config error", (() => { try { parseArgs(["o", "--lanes", "0"]); return false; } catch (e) { return e instanceof ConfigError; } })(), null);
check("non-numeric port base is a config error", (() => { try { parseArgs(["o"], { PORT_BASE: "x" }); return false; } catch (e) { return e instanceof ConfigError; } })(), null);
check("an invalid regex is a config error", (() => { try { parseArgs(["o", "["]); return false; } catch (e) { return e instanceof ConfigError; } })(), null);
check("a flag without a value is a config error", (() => { try { parseArgs(["o", "--lanes"]); return false; } catch (e) { return e instanceof ConfigError; } })(), null);
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
  const r = run(["^(pass|fail|silent|lying)"]);
  eq("one failing suite makes the process exit 1", r.status, EXIT.SUITES_FAILED);
  const byFile = Object.fromEntries((r.summary || []).map((l) => [l.split(" ")[1], l.split(" ")[0]]));
  eq("fail.txt is FAIL", byFile["fail.txt"], STATUS.FAIL);
  eq("pass.txt is PASS", byFile["pass.txt"], STATUS.PASS);
  eq("silent.txt is NO-RESULT", byFile["silent.txt"], STATUS.NO_RESULT);
  eq("lying.txt is FAIL despite its RESULT line", byFile["lying.txt"], STATUS.FAIL);
  check("stdout does not say ALL PASS", !r.stdout.includes("ALL PASS"), r.stdout);
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
}

{
  const r = run(["^hang", "--timeout", "1"]);
  eq("a hung suite exits 1", r.status, EXIT.SUITES_FAILED);
  eq("a hung suite is TIMEOUT", r.summary?.[0]?.split(" ")[0], STATUS.TIMEOUT);
  const log = readFileSync(join(r.out, "hang.txt.log"), "utf8");
  const pid = Number((log.match(/GRANDCHILD (\d+)/) || [])[1]);
  check("the fake driver reported its grandchild", pid > 0, log);
  if (pid > 0) {
    const deadline = Date.now() + 5000;
    while (pidAlive(pid) && Date.now() < deadline) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},200)"]);
    check("the grandchild was killed with its parent", !pidAlive(pid), `pid ${pid} still alive`);
    if (pidAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}

{
  const r = run(["^pass", "--node", join(work, "no-such-node")]);
  eq("an unlaunchable driver exits 1", r.status, EXIT.SUITES_FAILED);
  eq("an unlaunchable driver is LAUNCH-ERROR", r.summary?.[0]?.split(" ")[0], STATUS.LAUNCH_ERROR);
}

{
  const r = run(["^(pass|fail)", "--lanes", "1"]);
  eq("a single lane runs every suite", r.summary?.length, 2);
}

rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
