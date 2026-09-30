import { spawn } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_DIR = join(REPO, ".claude", "skills", "run-splitpage-app");
const LOG_LIMIT = 2 * 1024 * 1024;
const LINE_LIMIT = 4096;
const PORT_STRIDE = 10;
const SUMMARY = /^RESULT: (0|-?[1-9]\d{0,8})\/(0|[1-9]\d{0,8}) checks passed(?: - ([1-9]\d{0,8}) FAILED)?$/;

export const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  BAD_RESULT: "BAD-RESULT",
  NO_RESULT: "NO-RESULT",
  TIMEOUT: "TIMEOUT",
  LAUNCH_ERROR: "LAUNCH-ERROR"
});

export const EXIT = Object.freeze({ OK: 0, SUITES_FAILED: 1, CONFIG: 2, INTERRUPTED: 130 });

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
    return { status: STATUS.TIMEOUT, result: `${limit}, ${seen}` };
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

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch {} }
}

function runOne(config, file, lane, live) {
  const { cmd, args } = driverCommand(config, file, lane);
  return new Promise((resolveRun) => {
    let log = "";
    let settled = false;
    const scanner = createSummaryScanner();
    const outcome = { code: null, signal: null, timedOut: false, launchError: null, limitSec: config.timeoutMs / 1000 };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveRun({ file, log, ...classify(outcome, scanner.end()) });
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: REPO, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      outcome.launchError = e.message;
      finish();
      return;
    }
    live.add(child);
    const timer = setTimeout(() => { outcome.timedOut = true; killTree(child); }, config.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { log = appendBounded(log, d); scanner.push(d); });
    child.stderr.on("data", (d) => { log = appendBounded(log, d); });
    child.on("error", (e) => {
      outcome.launchError = e.message;
      clearTimeout(timer);
      live.delete(child);
      setImmediate(finish);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      live.delete(child);
      outcome.code = code;
      outcome.signal = signal;
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

export async function runSuites(config, files, { print = console.log, live = new Set() } = {}) {
  if (files.length === 0) throw new ConfigError("no suites matched");
  mkdirSync(config.out, { recursive: true });
  const results = [];
  let next = 0;
  async function lane(i) {
    while (next < files.length) {
      const file = files[next++];
      const r = await runOne(config, file, i, live);
      writeFileSync(join(config.out, `${file}.log`), r.log);
      results.push(r);
      print(`${r.status} ${file} ${r.result}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.lanes, files.length) }, (_, i) => lane(i)));
  const lines = summarize(results);
  writeFileSync(join(config.out, "summary.txt"), lines.join("\n") + "\n");
  const failed = lines.filter((l) => !l.startsWith(STATUS.PASS + " "));
  print(failed.length ? failed.join("\n") : "ALL PASS");
  print(`${results.length} of ${files.length} suites ran, ${results.length - failed.length} passed`);
  return { results, exitCode: exitCodeFor(results) };
}

export async function main(argv, env) {
  const live = new Set();
  const stop = () => { for (const c of live) killTree(c); process.exit(EXIT.INTERRUPTED); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const config = parseArgs(argv, env);
    const files = discoverSuites(config.suiteDir, config.filter);
    console.log(`${files.length} suites in ${config.suiteDir}, ${config.lanes} lanes, logs in ${config.out}`);
    const { exitCode } = await runSuites(config, files, { live });
    return exitCode;
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`run-suites: ${e.message}`);
      return EXIT.CONFIG;
    }
    throw e;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
