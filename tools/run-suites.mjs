import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./main-module.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_DIR = join(REPO, ".claude", "skills", "run-splitpage-app");
const IS_WINDOWS = process.platform === "win32";
const LOG_LIMIT = 2 * 1024 * 1024;
const LINE_LIMIT = 4096;
const QUOTE_LIMIT = 200;
const PORT_STRIDE = 10;
const HTTP_BASE = 18100;
const CDP_BASE = 19300;
const PORT_MAX = 65535;
const TIMEOUT_MAX = 86400;
const FLAGS = ["lanes", "port-base", "timeout", "suites", "driver", "node"];
const FREEZE_ENV = "SPLITPAGE_FREEZE_CACHES";
const GUARD_ENV = "SPLITPAGE_DOCUMENT_GUARD";
const SUMMARY = /^RESULT: (0|-?[1-9]\d{0,8})\/(0|[1-9]\d{0,8}) checks passed(?: - ([1-9]\d{0,8}) FAILED)?$/;

export const DRAIN_MS = 2000;
export const KILL_GRACE_MS = 2000;

export const USAGE = `usage: node tools/run-suites.mjs [out-dir] [filter] [options]

  out-dir          where each suite's log and summary.txt go (default ../splitpage-runs/latest)
  filter           a regular expression over full suite filenames; put -- before one that starts with -

  --lanes N        suites run at once (default 6; env LANES)
  --port-base N    a multiple of 10 (default 0; env PORT_BASE). Lane n uses HTTP 18100+N+10n and
                   CDP 19300+N+10n and holds both ports + 1 for the whole run
  --timeout S      seconds per suite, 1 to 86400 (default 600; env SUITE_TIMEOUT)
  --suites DIR     the suite folder (env SPLITPAGE_SUITE_DIR)
  --driver FILE    the driver script (env SPLITPAGE_SUITE_DRIVER)
  --node FILE      the Node executable (env SPLITPAGE_SUITE_NODE)
  -h, --help       print this and exit 0

Env SPLITPAGE_FREEZE_CACHES=1 opens every suite's page with freeze-caches=1, so the app's caches
deep-freeze what they hand out and a write into one throws.
Env SPLITPAGE_DOCUMENT_GUARD=1 opens every suite's page with document-guard=1, so S.state is a
read-only view of the session's document and a write through it is refused and fails the suite.

Numbers are plain decimal digits. --option=value works too.
Exit status: 0 every suite PASS; 1 any other suite status; 2 a bad option, nothing matched,
a missing driver or suite folder, or a port collision; 3 the runner itself failed;
129, 130 or 143 after SIGHUP, SIGINT or SIGTERM.`;

export const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  BAD_RESULT: "BAD-RESULT",
  NO_RESULT: "NO-RESULT",
  TIMEOUT: "TIMEOUT",
  LEFTOVER: "LEFTOVER",
  LAUNCH_ERROR: "LAUNCH-ERROR",
  NOT_STARTED: "NOT-STARTED"
});

const NOT_STARTED_PREFIX = "NOT STARTED:";

export const EXIT = Object.freeze({ OK: 0, SUITES_FAILED: 1, CONFIG: 2, RUNNER_ERROR: 3, HANGUP: 129, INTERRUPTED: 130, TERMINATED: 143 });

export class ConfigError extends Error {}

function wholeNumber(name, raw, fallback, min, max) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be plain decimal digits, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be from ${min} to ${max}, got ${raw}`);
  return n;
}

const PORT_KINDS = ["http", "cdp", "httpReserve", "cdpReserve"];
const RESERVED = new Set(["httpReserve", "cdpReserve"]);
const PORT_LABEL = { http: "HTTP port", cdp: "CDP port", httpReserve: "HTTP reservation port", cdpReserve: "CDP reservation port" };

export function portPlan(portBase, lanes) {
  const highest = CDP_BASE + portBase + (lanes - 1) * PORT_STRIDE + 1;
  if (highest > PORT_MAX) {
    throw new ConfigError(`--port-base ${portBase} with ${lanes} lanes needs ports up to ${highest}; the highest port is ${PORT_MAX}`);
  }
  const owners = new Map();
  const plan = [];
  for (let lane = 0; lane < lanes; lane++) {
    const http = HTTP_BASE + portBase + lane * PORT_STRIDE;
    const cdp = CDP_BASE + portBase + lane * PORT_STRIDE;
    const entry = { lane, http, cdp, httpReserve: http + 1, cdpReserve: cdp + 1 };
    for (const kind of PORT_KINDS) {
      const label = `lane ${lane}'s ${PORT_LABEL[kind]}`;
      const other = owners.get(entry[kind]);
      if (other) throw new ConfigError(`port ${entry[kind]} would be both ${other} and ${label}; use fewer --lanes`);
      owners.set(entry[kind], label);
    }
    plan.push(entry);
  }
  return plan;
}

export function parseArgs(argv, env = {}) {
  const end = argv.indexOf("--");
  const options = end === -1 ? argv : argv.slice(0, end);
  if (options.includes("-h") || options.includes("--help")) return { help: true };
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("-")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!a.startsWith("--") || !FLAGS.includes(key)) {
      throw new ConfigError(`unknown option ${eq === -1 ? a : a.slice(0, eq)}; the options are ${FLAGS.map((f) => "--" + f).join(", ")} (--help explains them)`);
    }
    if (Object.hasOwn(flags, key)) throw new ConfigError(`--${key} was given twice`);
    let value;
    if (eq === -1) {
      value = argv[i + 1];
      i++;
      if (value !== undefined && value.startsWith("--")) value = undefined;
    } else {
      value = a.slice(eq + 1);
    }
    if (value === undefined || value === "") throw new ConfigError(`--${key} needs a value`);
    flags[key] = value;
  }
  if (positional.length > 2) throw new ConfigError(`unexpected argument ${JSON.stringify(positional[2])}`);
  let filter = null;
  if (positional[1] !== undefined) {
    try { filter = new RegExp(positional[1]); }
    catch (e) { throw new ConfigError(`bad suite filter ${JSON.stringify(positional[1])}: ${e.message}`); }
  }
  const lanes = wholeNumber("--lanes (LANES)", flags.lanes ?? env.LANES, 6, 1, PORT_MAX);
  const portBase = wholeNumber("--port-base (PORT_BASE)", flags["port-base"] ?? env.PORT_BASE, 0, 0, PORT_MAX);
  if (portBase % PORT_STRIDE !== 0) {
    throw new ConfigError(`--port-base (PORT_BASE) must be a multiple of ${PORT_STRIDE}, got ${portBase}: each lane owns a block of ${PORT_STRIDE} ports`);
  }
  const timeoutSec = wholeNumber("--timeout (SUITE_TIMEOUT)", flags.timeout ?? env.SUITE_TIMEOUT, 600, 1, TIMEOUT_MAX);
  return {
    out: resolve(positional[0] || "../splitpage-runs/latest"),
    filter,
    lanes,
    portBase,
    timeoutMs: timeoutSec * 1000,
    suiteDir: resolve(flags.suites ?? env.SPLITPAGE_SUITE_DIR ?? join(SKILL_DIR, "tests")),
    driver: resolve(flags.driver ?? env.SPLITPAGE_SUITE_DRIVER ?? join(SKILL_DIR, "driver.mjs")),
    node: flags.node ?? env.SPLITPAGE_SUITE_NODE ?? process.execPath,
    freezeCaches: env[FREEZE_ENV] === "1",
    documentGuard: env[GUARD_ENV] === "1"
  };
}

export function discoverSuites(suiteDir, filter) {
  if (!existsSync(suiteDir)) throw new ConfigError(`suite directory not found: ${suiteDir}`);
  return readdirSync(suiteDir)
    .filter((f) => f.endsWith(".txt") && (!filter || filter.test(f)))
    .sort((a, b) => a.localeCompare(b));
}

export function driverCommand(config, file, lane) {
  const { http, cdp } = config.ports[lane];
  return {
    cmd: config.node,
    args: [
      config.driver,
      "--port", String(http),
      "--cdp-port", String(cdp),
      "--script", join(config.suiteDir, file),
      "--shot-dir", join(config.out, "shots"),
      ...(config.freezeCaches ? ["--freeze-caches"] : []),
      ...(config.documentGuard ? ["--document-guard"] : [])
    ]
  };
}

function bindPort(port) {
  return new Promise((resolveBind) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (e) => resolveBind({ server: null, code: e.code ?? e.message }));
    server.listen(port, "127.0.0.1", () => resolveBind({ server, code: null }));
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function claimPorts(plan) {
  const held = [];
  const busy = [];
  for (const entry of plan) {
    for (const kind of PORT_KINDS) {
      const { server, code } = await bindPort(entry[kind]);
      if (!server) { busy.push(`${entry[kind]} (lane ${entry.lane}'s ${PORT_LABEL[kind]}, ${code})`); continue; }
      if (RESERVED.has(kind)) held.push(server);
      else await closeServer(server);
    }
  }
  const release = () => Promise.all(held.splice(0).map(closeServer));
  if (busy.length) {
    await release();
    throw new ConfigError(`port collision: cannot bind ${busy.join(", ")}; the port is in use by another run-suites or something else, or reserved. Nothing was started. Pick a --port-base at least 10 x lanes away from any other run's`);
  }
  return { release };
}

export function createSummaryScanner() {
  let partial = "";
  let count = 0;
  let first = null;
  let last = null;
  let lastIsSummary = false;
  let notStarted = null;
  let done = null;
  const take = (raw) => {
    const line = (raw.endsWith("\r") ? raw.slice(0, -1) : raw).slice(0, LINE_LIMIT);
    if (line.trim() === "") return;
    if (notStarted === null && line.startsWith(NOT_STARTED_PREFIX)) notStarted = line.slice(NOT_STARTED_PREFIX.length).trim();
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
      done = { count, first, last, lastIsSummary, notStarted };
      return done;
    }
  };
}

export function scanSummary(text) {
  const scanner = createSummaryScanner();
  scanner.push(text);
  return scanner.end();
}

function quote(line) {
  return JSON.stringify(line.length > QUOTE_LIMIT ? line.slice(0, QUOTE_LIMIT) + "..." : line);
}

export function judgeSummary(scanned) {
  const { count, first, last, lastIsSummary } = scanned;
  if (count === 0) return { kind: "missing" };
  if (count > 1) return { kind: "bad", reason: `duplicate: ${count} RESULT lines, first ${quote(first)}, last ${quote(last)}` };
  const line = last;
  if (!lastIsSummary) return { kind: "bad", reason: `trailing output: ${quote(line)} is not the last line`, line };
  const m = SUMMARY.exec(line);
  if (!m) return { kind: "bad", reason: `malformed: ${quote(line)}`, line };
  const passed = Number(m[1]);
  const total = Number(m[2]);
  if (m[3] !== undefined) {
    if (Number(m[3]) !== total - passed) return { kind: "bad", reason: `contradictory: ${quote(line)}`, line };
    return { kind: "failing", line };
  }
  if (total === 0) return { kind: "bad", reason: `zero checks: ${quote(line)}`, line };
  if (passed < 0) return { kind: "bad", reason: `negative: ${quote(line)}`, line };
  if (passed < total) return { kind: "bad", reason: `incomplete: ${quote(line)}`, line };
  if (passed > total) return { kind: "bad", reason: `contradictory: ${quote(line)}`, line };
  return { kind: "passing", line };
}

function describeExit(outcome) {
  if (outcome.code !== null && outcome.code !== undefined) return `exit ${outcome.code}`;
  if (outcome.signal) return `signal ${outcome.signal}`;
  return "no exit status";
}

function describeSeen(scanned) {
  if (scanned.count === 0) return "no RESULT line";
  if (scanned.count > 1) return `${scanned.count} RESULT lines`;
  return `RESULT line ${quote(scanned.last)}`;
}

export function classify(outcome, stdout) {
  const scanned = typeof stdout === "string" ? scanSummary(stdout) : stdout;
  if (outcome.launchError) return { status: STATUS.LAUNCH_ERROR, result: outcome.launchError };
  if (outcome.timedOut) {
    const limit = outcome.limitSec ? `no exit within ${outcome.limitSec}s` : "no exit within the suite timeout";
    const forced = outcome.forced ? ", output still open after the kill" : "";
    return { status: STATUS.TIMEOUT, result: `${limit}, ${describeSeen(scanned)}${forced}` };
  }
  if (outcome.heldOpen) {
    return { status: STATUS.LEFTOVER, result: `${describeExit(outcome)}, but a process it started held its output open ${DRAIN_MS / 1000}s later, ${describeSeen(scanned)}` };
  }
  const exit = describeExit(outcome);
  if (scanned.notStarted !== null && scanned.notStarted !== undefined) {
    return { status: STATUS.NOT_STARTED, result: `${scanned.notStarted.length > QUOTE_LIMIT * 2 ? scanned.notStarted.slice(0, QUOTE_LIMIT * 2) + "..." : scanned.notStarted} (${exit})` };
  }
  const verdict = judgeSummary(scanned);
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

const KILL_TREE_NOTE = IS_WINDOWS ? "killing its process tree with taskkill" : "killing its process group";
const LEFTOVER_NOTE = IS_WINDOWS
  ? "Windows cannot trace its tree once it has exited, so nothing was killed"
  : "killing what is left of its process group";

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
      stop: () => { if (!settled) { note(`stopped by the runner; ${KILL_TREE_NOTE}`); killThenForce(); } }
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
      note(`no exit within ${outcome.limitSec}s; ${KILL_TREE_NOTE}`);
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
        note(`exited, but its output was still open ${DRAIN_MS / 1000}s later; ${LEFTOVER_NOTE}`);
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
  if (!existsSync(config.driver)) throw new ConfigError(`driver not found: ${config.driver}`);
  const laneCount = Math.min(config.lanes, files.length);
  const ports = portPlan(config.portBase, laneCount);
  const claim = await claimPorts(ports);
  const lanesConfig = { ...config, ports };
  try {
    print(`${files.length} suites in ${config.suiteDir}, ${laneCount} lanes on HTTP ${ports[0]?.http}+ and CDP ${ports[0]?.cdp}+, logs in ${config.out}`);
    if (config.freezeCaches) print(`cache freezing on (${FREEZE_ENV}=1): every suite opens the app with freeze-caches=1`);
    if (config.documentGuard) print(`document guard on (${GUARD_ENV}=1): every suite opens the app with document-guard=1`);
    mkdirSync(config.out, { recursive: true });
    const results = [];
    let next = 0;
    let failure = null;
    async function lane(i) {
      while (failure === null && next < files.length) {
        const file = files[next++];
        const r = await runOne(lanesConfig, file, i, owned);
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
    const unstarted = results.filter((r) => r.status === STATUS.NOT_STARTED).map((r) => r.file).sort((a, b) => a.localeCompare(b));
    if (unstarted.length) print(`${unstarted.length} of those never started and count as failed: ${unstarted.join(", ")}`);
    return { results, exitCode: exitCodeFor(results) };
  } finally {
    await claim.release();
  }
}

const OWNED = new Set();
let processHooked = false;

function signalAll() {
  for (const entry of OWNED) entry.signal();
}

function internalError(e) {
  return `run-suites: stopped by an internal error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`;
}

function hookProcess() {
  if (processHooked) return;
  processHooked = true;
  process.on("SIGINT", () => process.exit(EXIT.INTERRUPTED));
  process.on("SIGTERM", () => process.exit(EXIT.TERMINATED));
  process.on("SIGHUP", () => process.exit(EXIT.HANGUP));
  process.on("uncaughtException", (e) => { console.error(internalError(e)); process.exit(EXIT.RUNNER_ERROR); });
  process.on("exit", signalAll);
}

export async function main(argv, env) {
  hookProcess();
  try {
    const config = parseArgs(argv, env);
    if (config.help) { console.log(USAGE); return EXIT.OK; }
    const files = discoverSuites(config.suiteDir, config.filter);
    const { exitCode } = await runSuites(config, files, { owned: OWNED });
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

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
