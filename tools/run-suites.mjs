import { spawn, spawnSync } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_DIR = join(REPO, ".claude", "skills", "run-splitpage-app");
const IS_WINDOWS = process.platform === "win32";
const LOG_LIMIT = 2 * 1024 * 1024;
const LINE_LIMIT = 4096;
const PORT_STRIDE = 10;
const SUMMARY = /^RESULT: (0|-?[1-9]\d{0,8})\/(0|[1-9]\d{0,8}) checks passed(?: - ([1-9]\d{0,8}) FAILED)?$/;

export const DRAIN_MS = 2000;
export const KILL_GRACE_MS = 2000;

export const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  BAD_RESULT: "BAD-RESULT",
  NO_RESULT: "NO-RESULT",
  TIMEOUT: "TIMEOUT",
  LEFTOVER: "LEFTOVER",
  LAUNCH_ERROR: "LAUNCH-ERROR"
});

export const EXIT = Object.freeze({ OK: 0, SUITES_FAILED: 1, CONFIG: 2, RUNNER_ERROR: 3, HANGUP: 129, INTERRUPTED: 130, TERMINATED: 143 });

export class ConfigError extends Error {}

function positiveInteger(name, raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

function nonNegativeInteger(name, raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

export function parseArgs(argv, env = {}) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new ConfigError(`--${key} needs a value`);
      flags[key] = value;
      i++;
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 2) throw new ConfigError(`unexpected argument ${JSON.stringify(positional[2])}`);
  let filter = null;
  if (positional[1] !== undefined) {
    try { filter = new RegExp(positional[1]); }
    catch (e) { throw new ConfigError(`bad suite filter ${JSON.stringify(positional[1])}: ${e.message}`); }
  }
  return {
    out: resolve(positional[0] || "../splitpage-runs/latest"),
    filter,
    lanes: positiveInteger("lanes", flags.lanes ?? env.LANES, 6),
    portBase: nonNegativeInteger("port-base", flags["port-base"] ?? env.PORT_BASE, 0),
    timeoutMs: positiveInteger("timeout", flags.timeout ?? env.SUITE_TIMEOUT, 600) * 1000,
    suiteDir: resolve(flags.suites ?? env.SPLITPAGE_SUITE_DIR ?? join(SKILL_DIR, "tests")),
    driver: resolve(flags.driver ?? env.SPLITPAGE_SUITE_DRIVER ?? join(SKILL_DIR, "driver.mjs")),
    node: flags.node ?? env.SPLITPAGE_SUITE_NODE ?? process.execPath
  };
}

export function discoverSuites(suiteDir, filter) {
  if (!existsSync(suiteDir)) throw new ConfigError(`suite directory not found: ${suiteDir}`);
  return readdirSync(suiteDir)
    .filter((f) => f.endsWith(".txt") && (!filter || filter.test(f)))
    .sort((a, b) => a.localeCompare(b));
}

export function driverCommand(config, file, lane) {
  const port = 18100 + config.portBase + lane * PORT_STRIDE;
  const cdp = 19300 + config.portBase + lane * PORT_STRIDE;
  return {
    cmd: config.node,
    args: [
      config.driver,
      "--port", String(port),
      "--cdp-port", String(cdp),
      "--script", join(config.suiteDir, file),
      "--shot-dir", join(config.out, "shots")
    ]
  };
}

export function createSummaryScanner() {
  let partial = "";
  let count = 0;
  let first = null;
  let last = null;
  let lastIsSummary = false;
  let done = null;
  const take = (raw) => {
    const line = (raw.endsWith("\r") ? raw.slice(0, -1) : raw).slice(0, LINE_LIMIT);
    if (line.trim() === "") return;
    if (!line.startsWith("RESULT:")) { lastIsSummary = false; return; }
    count++;
    if (first === null) first = line;
    last = line;
    lastIsSummary = true;
  };
  return {
    push(chunk) {
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf("\n", start);
        if (nl === -1) { partial = (partial + chunk.slice(start)).slice(0, LINE_LIMIT); return; }
        take(partial + chunk.slice(start, nl));
        partial = "";
        start = nl + 1;
      }
    },
    end() {
      if (done) return done;
      take(partial);
      partial = "";
      done = { count, first, last, lastIsSummary };
      return done;
    }
  };
}

export function scanSummary(text) {
  const scanner = createSummaryScanner();
  scanner.push(text);
  return scanner.end();
}

export function judgeSummary(scanned) {
  const { count, first, last, lastIsSummary } = scanned;
  if (count === 0) return { kind: "missing" };
  if (count > 1) return { kind: "bad", reason: `duplicate: ${count} RESULT lines, first ${JSON.stringify(first)}, last ${JSON.stringify(last)}` };
  const line = last;
  const quoted = JSON.stringify(line);
  if (!lastIsSummary) return { kind: "bad", reason: `trailing output: ${quoted} is not the last line`, line };
  const m = SUMMARY.exec(line);
  if (!m) return { kind: "bad", reason: `malformed: ${quoted}`, line };
  const passed = Number(m[1]);
  const total = Number(m[2]);
  if (m[3] !== undefined) {
    if (Number(m[3]) !== total - passed) return { kind: "bad", reason: `contradictory: ${quoted}`, line };
    return { kind: "failing", line };
  }
  if (total === 0) return { kind: "bad", reason: `zero checks: ${quoted}`, line };
  if (passed < 0) return { kind: "bad", reason: `negative: ${quoted}`, line };
  if (passed < total) return { kind: "bad", reason: `incomplete: ${quoted}`, line };
  if (passed > total) return { kind: "bad", reason: `contradictory: ${quoted}`, line };
  return { kind: "passing", line };
}

function describeExit(outcome) {
  if (outcome.code !== null && outcome.code !== undefined) return `exit ${outcome.code}`;
  if (outcome.signal) return `signal ${outcome.signal}`;
  return "no exit status";
}

export function classify(outcome, stdout) {
  const scanned = typeof stdout === "string" ? scanSummary(stdout) : stdout;
  if (outcome.launchError) return { status: STATUS.LAUNCH_ERROR, result: outcome.launchError };
  const verdict = judgeSummary(scanned);
  const seen = verdict.line ? `last summary ${JSON.stringify(verdict.line)}` : "no RESULT line";
  if (outcome.timedOut) {
    const limit = outcome.limitSec ? `no exit within ${outcome.limitSec}s` : "no exit within the suite timeout";
    const forced = outcome.forced ? ", output still open after the kill" : "";
    return { status: STATUS.TIMEOUT, result: `${limit}, ${seen}${forced}` };
  }
  if (outcome.heldOpen) {
    return { status: STATUS.LEFTOVER, result: `${describeExit(outcome)}, but a process it started held its output open ${DRAIN_MS / 1000}s later, ${seen}` };
  }
  const exit = describeExit(outcome);
  if (verdict.kind === "missing") return { status: STATUS.NO_RESULT, result: `no RESULT line (${exit})` };
  if (verdict.kind === "bad") return { status: STATUS.BAD_RESULT, result: `${verdict.reason} (${exit})` };
  if (verdict.kind === "passing" && outcome.code === 0 && !outcome.signal) return { status: STATUS.PASS, result: verdict.line };
  return { status: STATUS.FAIL, result: `${verdict.line} (${exit})` };
}

function appendBounded(current, chunk) {
  const next = current + chunk;
  if (next.length <= LOG_LIMIT) return next;
  return "[log truncated]\n" + next.slice(next.length - LOG_LIMIT);
}

function signalTree(child) {
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 1) return;
  const alive = child.exitCode === null && child.signalCode === null;
  if (IS_WINDOWS) {
    if (alive) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 15000 });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch {
    if (alive) { try { child.kill("SIGKILL"); } catch {} }
  }
}

function runOne(config, file, lane, owned) {
  const { cmd, args } = driverCommand(config, file, lane);
  return new Promise((resolveRun) => {
    let log = "";
    let child = null;
    let settled = false;
    const scanner = createSummaryScanner();
    const timers = { suite: null, drain: null, grace: null };
    const outcome = { code: null, signal: null, timedOut: false, heldOpen: false, forced: false, launchError: null, limitSec: config.timeoutMs / 1000 };
    const note = (message) => { log = appendBounded(log, `[run-suites] ${message}\n`); };

    const finish = () => {
      if (settled) return;
      settled = true;
      for (const t of Object.values(timers)) if (t) clearTimeout(t);
      if (child) signalTree(child);
      owned.delete(entry);
      resolveRun({ file, log, ...classify(outcome, scanner.end()) });
    };
    const force = () => {
      outcome.forced = true;
      note(`output still open ${KILL_GRACE_MS / 1000}s after the kill; closing it`);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      finish();
    };
    const killThenForce = () => {
      if (child) signalTree(child);
      if (!timers.grace) timers.grace = setTimeout(force, KILL_GRACE_MS);
    };
    const entry = {
      signal: () => { if (child) signalTree(child); },
      stop: () => { if (!settled) { note("stopped by the runner"); killThenForce(); } }
    };

    try {
      child = spawn(cmd, args, {
        cwd: REPO,
        detached: !IS_WINDOWS,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      outcome.launchError = e.message;
      finish();
      return;
    }
    owned.add(entry);

    timers.suite = setTimeout(() => {
      timers.suite = null;
      outcome.timedOut = true;
      note(`no exit within ${outcome.limitSec}s; killing its process tree`);
      killThenForce();
    }, config.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { log = appendBounded(log, d); scanner.push(d); });
    child.stderr.on("data", (d) => { log = appendBounded(log, d); });
    child.stdout.on("error", (e) => note(`stdout: ${e.message}`));
    child.stderr.on("error", (e) => note(`stderr: ${e.message}`));
    child.on("error", (e) => {
      if (child.pid === undefined) { outcome.launchError = e.message; setImmediate(finish); }
      else note(e.message);
    });
    child.on("exit", (code, signal) => {
      outcome.code = code;
      outcome.signal = signal;
      if (settled || outcome.timedOut || timers.grace) return;
      if (timers.suite) { clearTimeout(timers.suite); timers.suite = null; }
      timers.drain = setTimeout(() => {
        timers.drain = null;
        outcome.heldOpen = true;
        note(`exited, but its output was still open ${DRAIN_MS / 1000}s later; killing what is left of its process tree`);
        killThenForce();
      }, DRAIN_MS);
    });
    child.on("close", (code, signal) => {
      if (outcome.code === null && outcome.signal === null) { outcome.code = code; outcome.signal = signal; }
      finish();
    });
  });
}

export function summarize(results) {
  return [...results]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((r) => `${r.status} ${r.file} ${r.result}`);
}

export function exitCodeFor(results) {
  return results.length > 0 && results.every((r) => r.status === STATUS.PASS) ? EXIT.OK : EXIT.SUITES_FAILED;
}

export async function runSuites(config, files, { print = console.log, owned = new Set() } = {}) {
  if (files.length === 0) throw new ConfigError("no suites matched");
  const laneCount = Math.min(config.lanes, files.length);
  mkdirSync(config.out, { recursive: true });
  const results = [];
  let next = 0;
  let failure = null;
  async function lane(i) {
    while (failure === null && next < files.length) {
      const file = files[next++];
      const r = await runOne(config, file, i, owned);
      if (failure !== null) return;
      writeFileSync(join(config.out, `${file}.log`), r.log);
      results.push(r);
      print(`${r.status} ${file} ${r.result}`);
    }
  }
  const stopAll = (e) => {
    if (failure === null) failure = e;
    for (const entry of owned) entry.stop();
  };
  await Promise.all(Array.from({ length: laneCount }, (_, i) => lane(i).catch(stopAll)));
  if (failure !== null) throw failure;
  const lines = summarize(results);
  writeFileSync(join(config.out, "summary.txt"), lines.join("\n") + "\n");
  const failed = lines.filter((l) => !l.startsWith(STATUS.PASS + " "));
  print(failed.length ? failed.join("\n") : "ALL PASS");
  print(`${results.length} of ${files.length} suites ran, ${results.length - failed.length} passed`);
  return { results, exitCode: exitCodeFor(results) };
}

function internalError(e) {
  return `run-suites: stopped by an internal error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`;
}

export async function main(argv, env) {
  const owned = new Set();
  const signalAll = () => { for (const entry of owned) entry.signal(); };
  process.on("SIGINT", () => process.exit(EXIT.INTERRUPTED));
  process.on("SIGTERM", () => process.exit(EXIT.TERMINATED));
  process.on("SIGHUP", () => process.exit(EXIT.HANGUP));
  process.on("uncaughtException", (e) => { console.error(internalError(e)); process.exit(EXIT.RUNNER_ERROR); });
  process.on("exit", signalAll);
  try {
    const config = parseArgs(argv, env);
    const files = discoverSuites(config.suiteDir, config.filter);
    console.log(`${files.length} suites in ${config.suiteDir}, ${config.lanes} lanes, logs in ${config.out}`);
    const { exitCode } = await runSuites(config, files, { owned });
    return exitCode;
  } catch (e) {
    signalAll();
    if (e instanceof ConfigError) {
      console.error(`run-suites: ${e.message}`);
      return EXIT.CONFIG;
    }
    console.error(internalError(e));
    return EXIT.RUNNER_ERROR;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
