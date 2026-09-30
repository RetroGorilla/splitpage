import { spawn } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_DIR = join(REPO, ".claude", "skills", "run-splitpage-app");
const LOG_LIMIT = 2 * 1024 * 1024;
const PORT_STRIDE = 10;

export const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  TIMEOUT: "TIMEOUT",
  LAUNCH_ERROR: "LAUNCH-ERROR",
  NO_RESULT: "NO-RESULT"
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

export function classify(outcome, log) {
  const matches = log.match(/RESULT:[^\n]*/g);
  const result = matches ? matches[matches.length - 1] : null;
  if (outcome.launchError) return { status: STATUS.LAUNCH_ERROR, result: outcome.launchError };
  if (outcome.timedOut) return { status: STATUS.TIMEOUT, result: result || "no RESULT line before timeout" };
  if (!result) return { status: STATUS.NO_RESULT, result: `exit ${outcome.code ?? outcome.signal}` };
  if (outcome.code === 0 && !/FAILED/.test(result)) return { status: STATUS.PASS, result };
  return { status: STATUS.FAIL, result: `${result} (exit ${outcome.code ?? outcome.signal})` };
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
    const outcome = { code: null, signal: null, timedOut: false, launchError: null };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveRun({ file, log, ...classify(outcome, log) });
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
    child.stdout.on("data", (d) => { log = appendBounded(log, String(d)); });
    child.stderr.on("data", (d) => { log = appendBounded(log, String(d)); });
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
  return results.every((r) => r.status === STATUS.PASS) ? EXIT.OK : EXIT.SUITES_FAILED;
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
