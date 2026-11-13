import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { REPO, listRepoFiles } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";
import { discover, selectFiles } from "./run-tests.mjs";

const DEFAULT_TIMEOUT_MS = 300000;

export function defaultConcurrency() {
  return Math.max(1, availableParallelism() - 1);
}

export function loadMutants(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.mutants;
  if (!Array.isArray(list) || list.length === 0) throw new Error("mutants file needs a non-empty array of mutants (or an object with a `mutants` array)");
  const tests = Array.isArray(data) ? [] : data.tests ?? [];
  const labels = new Set();
  return list.map((m, i) => {
    for (const key of ["file", "find", "replace", "label"]) {
      if (typeof m?.[key] !== "string") throw new Error(`mutant ${i + 1}: \`${key}\` must be a string`);
    }
    if (m.find === "") throw new Error(`mutant ${i + 1} (${m.label}): \`find\` must not be empty`);
    if (m.find === m.replace) throw new Error(`mutant ${i + 1} (${m.label}): \`find\` and \`replace\` are the same`);
    if (labels.has(m.label)) throw new Error(`mutant ${i + 1}: duplicate label ${m.label}`);
    labels.add(m.label);
    const own = m.tests ?? tests;
    if (!Array.isArray(own) || own.some((t) => typeof t !== "string")) throw new Error(`mutant ${i + 1} (${m.label}): \`tests\` must be an array of strings`);
    return { label: m.label, file: m.file, find: m.find, replace: m.replace, tests: own };
  });
}

export function applyEdit(source, find, replace) {
  const first = source.indexOf(find);
  if (first === -1) return { error: "find string not present" };
  if (source.indexOf(find, first + find.length) !== -1) return { error: "find string occurs more than once" };
  return { text: source.slice(0, first) + replace + source.slice(first + find.length) };
}

export function summarize(results) {
  const count = (status) => results.filter((r) => r.status === status).length;
  const caught = count("caught"), survived = count("survived"), inconclusive = count("inconclusive"), errors = count("error");
  const notes = [inconclusive ? `${inconclusive} inconclusive` : "", errors ? `${errors} could not run` : ""].filter(Boolean);
  const line = `Mutants caught: ${caught}/${results.length}` + (notes.length ? ` (${notes.join(", ")})` : "");
  return { caught, survived, inconclusive, errors, line };
}

export function exitCode(summary, failOnSurvivor) {
  if (summary.errors > 0) return 2;
  return failOnSurvivor && summary.survived + summary.inconclusive > 0 ? 1 : 0;
}

export function unitTestFiles(files) {
  return discover(files).groups.filter((entry) => entry.group.set === "unit").flatMap((entry) => entry.files).sort();
}

export function resolveTests(unitFiles, filters) {
  if (!filters.length) return { files: unitFiles, unmatched: [] };
  const unmatched = filters.filter((filter) => selectFiles(unitFiles, [filter]).length === 0);
  return { files: selectFiles(unitFiles, filters), unmatched };
}

export function verdict(run, events, selected) {
  if (run.error) return { status: "error", detail: `could not start the test run: ${run.error}` };
  const chosen = new Set(selected);
  const counted = events.filter((e) => !e.skip && !e.todo);
  const fails = counted.filter((e) => e.type === "fail");
  const asserted = fails.filter((e) => e.assertion && e.failureType === "testCodeFailure" && !e.fileLevel && chosen.has(e.file));
  if (asserted.length) {
    const more = asserted.length > 1 ? ` and ${asserted.length - 1} more` : "";
    return { status: "caught", detail: `assertion failed in ${JSON.stringify(asserted[0].name)}${more}${run.timedOut ? ", then the run timed out" : ""}` };
  }
  if (run.timedOut) return { status: "inconclusive", detail: "timeout" };
  const failure = fails.find((e) => e.failureType !== "subtestsFailed" && e.failureType !== "cancelledByParent") ?? fails[0];
  if (failure) {
    if (failure.fileLevel) return { status: "inconclusive", detail: `${failure.file} failed outside its tests (load, syntax or exit)` };
    if (!chosen.has(failure.file)) return { status: "inconclusive", detail: `test ${JSON.stringify(failure.name)} in ${failure.file}, which was not chosen, failed` };
    if (failure.failureType === "testTimeoutFailure") return { status: "inconclusive", detail: `test ${JSON.stringify(failure.name)} timed out` };
    if (failure.failureType === "hookFailed") return { status: "inconclusive", detail: `a hook of ${JSON.stringify(failure.name)} failed: ${failure.cause ?? "no cause"}` };
    return { status: "inconclusive", detail: `test ${JSON.stringify(failure.name)} failed without an assertion: ${failure.cause ?? failure.failureType}` };
  }
  if (run.code !== 0) return { status: "inconclusive", detail: `test process exited ${run.code} with no failed test` };
  if (!counted.some((e) => e.type === "pass" && !e.fileLevel && chosen.has(e.file))) return { status: "inconclusive", detail: "no chosen test ran" };
  return { status: "survived", detail: "" };
}

export function readEvents(text) {
  return text.split("\n").flatMap((line) => {
    try { return line ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

export function formatTable(results) {
  const rows = results.map((r) => [r.label, r.detail ? `${r.status} (${r.detail})` : r.status, `${(r.ms / 1000).toFixed(1)}s`]);
  const header = ["label", "result", "duration"];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const fmt = (cells) => cells.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd();
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

const CHILD = `
import { run } from "node:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, relative, resolve } from "node:path";
const [, , filesPath, eventsPath] = process.argv;
const files = JSON.parse(readFileSync(filesPath, "utf8"));
writeFileSync(eventsPath, "");
let failed = false, next = 0;
const marked = (flag) => flag !== undefined && flag !== false;
const record = (event) => {
  const data = event.data, error = data.details?.error, cause = error?.cause;
  const file = data.file ? relative(process.cwd(), data.file).replace(/\\\\/g, "/") : null;
  const named = cause instanceof Error, name = String(data.name);
  if (event.type === "test:fail" && !marked(data.todo)) failed = true;
  appendFileSync(eventsPath, JSON.stringify({
    type: event.type === "test:fail" ? "fail" : "pass", name: data.name, nesting: data.nesting, file,
    skip: marked(data.skip), todo: marked(data.todo),
    failureType: error?.failureType ?? null, assertion: cause !== null && typeof cause === "object" && cause.code === "ERR_ASSERTION",
    fileLevel: !named && data.nesting === 0 && file !== null && (name === basename(file) || name.replace(/\\\\/g, "/") === file || resolve(name) === resolve(file)),
    cause: named ? cause.name + ": " + String(cause.message).split("\\n")[0].slice(0, 200) : cause === undefined ? null : String(cause).slice(0, 200)
  }) + "\\n");
};
const lane = async () => {
  while (next < files.length) {
    const file = files[next++];
    for await (const event of run({ files: [file] })) if (event.type === "test:fail" || event.type === "test:pass") record(event);
  }
};
await Promise.all(Array.from({ length: Math.min(Math.max(2, availableParallelism() - 1), files.length) }, lane));
process.exitCode = failed ? 1 : 0;
`;

export function confinedPath(root, file) {
  const base = resolve(root);
  const target = resolve(base, file);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || resolve(rel) === rel) return null;
  if (rel.split(sep).includes("node_modules")) return null;
  return target;
}

export function makeScratch(repo, parent, files) {
  const dir = mkdtempSync(join(parent, "mutant-"));
  const root = resolve(repo);
  for (const f of files) {
    const to = join(dir, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(root, f), to);
  }
  const modules = join(root, "node_modules");
  if (existsSync(modules)) symlinkSync(modules, join(dir, "node_modules"), "junction");
  return dir;
}

export function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

const running = new Set();

export function killRunning() {
  for (const child of running) killTree(child);
  running.clear();
}

function childEnv() {
  const env = { ...process.env };
  delete env.GOLDEN_UPDATE;
  return env;
}

export function runChild(scratch, testFiles, timeoutMs, node) {
  return new Promise((resolveRun) => {
    let child;
    const eventsPath = join(dirname(scratch), `${basename(scratch)}-events.jsonl`);
    const finish = (result) => {
      let text = "";
      try { text = readFileSync(eventsPath, "utf8"); } catch {}
      rmSync(eventsPath, { force: true });
      resolveRun({ ...result, events: readEvents(text) });
    };
    try {
      const filesPath = join(dirname(scratch), `${basename(scratch)}-files.json`);
      const childPath = join(dirname(scratch), `${basename(scratch)}-child.mjs`);
      writeFileSync(filesPath, JSON.stringify(testFiles));
      // why: node:test's run() passes the parent's execArgv to every test process, so the child is a file, not -e.
      writeFileSync(childPath, CHILD);
      child = spawn(node, [childPath, filesPath, eventsPath], { cwd: scratch, stdio: "ignore", env: childEnv(), detached: process.platform !== "win32" });
    } catch (e) {
      finish({ code: -1, timedOut: false, error: e.message });
      return;
    }
    running.add(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on("error", (e) => { running.delete(child); clearTimeout(timer); finish({ code: -1, timedOut, error: e.message }); });
    child.on("close", (code) => { running.delete(child); clearTimeout(timer); finish({ code, timedOut }); });
  });
}

export async function runMutant(mutant, { repo, files, parent, timeoutMs, node, keep }) {
  const started = Date.now();
  const done = (status, detail) => ({ label: mutant.label, status, detail, ms: Date.now() - started });
  let scratch;
  try {
    const original = confinedPath(repo, mutant.file);
    if (!original) return done("error", `${mutant.file} is outside the repository or under node_modules`);
    if (!existsSync(original)) return done("error", `${mutant.file} not found`);
    const edit = applyEdit(readFileSync(original, "utf8"), mutant.find, mutant.replace);
    if (edit.error) return done("error", edit.error);
    scratch = makeScratch(repo, parent, files);
    writeFileSync(join(scratch, mutant.file), edit.text);
    const run = await runChild(scratch, mutant.testFiles, timeoutMs, node);
    const result = verdict(run, run.events, mutant.testFiles);
    return done(result.status, result.detail);
  } catch (e) {
    return done("error", e.message);
  } finally {
    if (scratch && !keep) rmSync(scratch, { recursive: true, force: true });
  }
}

export async function baseline({ repo, files, parent, timeoutMs, node, testFiles }) {
  const scratch = makeScratch(repo, parent, files);
  const started = Date.now();
  try {
    const run = await runChild(scratch, testFiles, timeoutMs, node);
    const result = verdict(run, run.events, testFiles);
    const failures = run.events.filter((e) => e.type === "fail" && !e.todo && e.failureType !== "subtestsFailed")
      .map((e) => `${e.file ?? "?"}: ${e.fileLevel ? "failed outside its tests" : JSON.stringify(e.name)}${e.cause ? ` (${e.cause})` : ""}`);
    return { ok: result.status === "survived", detail: result.detail, failures, ms: Date.now() - started };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function runAll(mutants, options) {
  const results = new Array(mutants.length);
  let next = 0;
  const lane = async () => {
    while (next < mutants.length) {
      const i = next++;
      results[i] = await runMutant(mutants[i], options);
      options.onResult?.(results[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, mutants.length) }, lane));
  return results;
}

export function shardOf(mutants, shard) {
  return shard ? mutants.filter((_, i) => i % shard.count === shard.index - 1) : mutants;
}

export function loadMutantFiles(entries) {
  const mutants = entries.flatMap(({ name, text }) => {
    try {
      return loadMutants(text).map((m) => (entries.length > 1 ? { ...m, label: `${name}: ${m.label}` } : m));
    } catch (e) {
      throw new Error(entries.length > 1 ? `${name}: ${e.message}` : e.message, { cause: e });
    }
  });
  const seen = new Set();
  for (const m of mutants) {
    if (seen.has(m.label)) throw new Error(`duplicate label ${m.label}`);
    seen.add(m.label);
  }
  return mutants;
}

export function parseArgs(args) {
  const opts = { files: [], concurrency: defaultConcurrency(), timeoutMs: DEFAULT_TIMEOUT_MS, baselineTimeoutMs: null, keep: false, baseline: true, failOnSurvivor: false, shard: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (name) => {
      const v = a.startsWith(`${name}=`) ? a.slice(name.length + 1) : args[++i];
      return v === undefined || v.startsWith("--") ? null : v;
    };
    if (a === "--concurrency" || a.startsWith("--concurrency=")) {
      const n = Number(value("--concurrency"));
      if (!Number.isInteger(n) || n < 1) return { error: "--concurrency needs a whole number of at least 1" };
      opts.concurrency = n;
    } else if (a === "--timeout" || a.startsWith("--timeout=")) {
      const n = Number(value("--timeout"));
      if (!Number.isFinite(n) || n <= 0) return { error: "--timeout needs a number of seconds above 0" };
      opts.timeoutMs = n * 1000;
    } else if (a === "--baseline-timeout" || a.startsWith("--baseline-timeout=")) {
      const n = Number(value("--baseline-timeout"));
      if (!Number.isFinite(n) || n <= 0) return { error: "--baseline-timeout needs a number of seconds above 0" };
      opts.baselineTimeoutMs = n * 1000;
    } else if (a === "--shard" || a.startsWith("--shard=")) {
      const m = /^(\d+)\/(\d+)$/.exec(value("--shard") ?? "");
      const index = m ? Number(m[1]) : 0, count = m ? Number(m[2]) : 0;
      if (!m || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || index < 1 || index > count) {
        return { error: "--shard needs K/N with whole numbers 1 <= K <= N" };
      }
      opts.shard = { index, count };
    } else if (a === "--keep") opts.keep = true;
    else if (a === "--no-baseline") opts.baseline = false;
    else if (a === "--fail-on-survivor") opts.failOnSurvivor = true;
    else if (a.startsWith("--")) return { error: `unknown flag ${a}; use --concurrency, --timeout, --baseline-timeout, --shard, --keep, --no-baseline or --fail-on-survivor` };
    else opts.files.push(a);
  }
  if (!opts.files.length) {
    return { error: "usage: node tools/mutants.mjs <mutants.json>... [--concurrency N] [--timeout SECONDS] [--baseline-timeout SECONDS] [--shard K/N] [--keep] [--no-baseline] [--fail-on-survivor]" };
  }
  opts.baselineTimeoutMs ??= opts.timeoutMs;
  return opts;
}

export async function main(args, { repo = REPO, print = console.log, printError = console.error, node = process.execPath } = {}) {
  const opts = parseArgs(args);
  if (opts.error) { printError(`mutants: ${opts.error}`); return 2; }
  let mutants;
  try {
    mutants = shardOf(loadMutantFiles(opts.files.map((file) => ({ name: basename(file), text: readFileSync(resolve(file), "utf8") }))), opts.shard);
  } catch (e) {
    printError(`mutants: ${e.message}`);
    return 2;
  }
  if (!mutants.length) { print("no mutants in this shard"); return 0; }
  const files = listRepoFiles(repo).filter((p) => existsSync(join(repo, p)));
  const unitFiles = unitTestFiles(files);
  const unmatched = [];
  mutants = mutants.map((m) => {
    const tests = resolveTests(unitFiles, m.tests);
    for (const filter of tests.unmatched) unmatched.push(`${m.label}: test filter ${JSON.stringify(filter)} matches no unit test file`);
    return { ...m, testFiles: tests.files };
  });
  if (unmatched.length) {
    for (const line of unmatched) printError(`mutants: ${line}`);
    return 2;
  }
  const parent = mkdtempSync(join(tmpdir(), "splitpage-mutants-"));
  const interrupt = (signal, code) => () => {
    killRunning();
    if (!opts.keep) {
      try { rmSync(parent, { recursive: true, force: true }); } catch {}
    }
    printError(`mutants: interrupted by ${signal}`);
    process.exit(code);
  };
  const onInt = interrupt("SIGINT", 130);
  const onTerm = interrupt("SIGTERM", 143);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const base = { repo, files, parent, timeoutMs: opts.timeoutMs, node, keep: opts.keep };
  try {
    if (opts.baseline) {
      // why: a mutant without a filter runs every unit test, so the baseline must cover them all as well.
      const scope = mutants.some((m) => !m.tests.length) ? unitFiles : [...new Set(mutants.flatMap((m) => m.testFiles))].sort();
      let result;
      try {
        result = await baseline({ ...base, timeoutMs: opts.baselineTimeoutMs, testFiles: scope });
      } catch (e) {
        printError(`mutants: ${e.message}`);
        return 2;
      }
      print(`baseline: ${scope.length} test files, ${result.ok ? "passed" : "FAILED"} in ${(result.ms / 1000).toFixed(1)}s`);
      if (!result.ok) {
        printError(`mutants: the unmutated copy does not pass its tests (${result.detail}), so no verdict would mean anything; fix that first (or pass --no-baseline)`);
        for (const line of result.failures) printError(`  ${line}`);
        return 2;
      }
    }
    print(`running ${mutants.length} mutants, ${Math.min(opts.concurrency, mutants.length)} at a time`);
    const results = await runAll(mutants, { ...base, concurrency: opts.concurrency, onResult: (r) => print(`  ${r.label}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`) });
    print("");
    print(formatTable(results));
    const s = summarize(results);
    print("");
    print(s.line);
    for (const r of results.filter((x) => x.status === "survived")) print(`survived: ${r.label} (record why it was accepted, or add a test)`);
    for (const r of results.filter((x) => x.status === "inconclusive")) print(`inconclusive: ${r.label}: ${r.detail} (no assertion failed in a named test)`);
    for (const r of results.filter((x) => x.status === "error")) print(`error: ${r.label}: ${r.detail}`);
    return exitCode(s, opts.failOnSurvivor);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    if (!opts.keep) rmSync(parent, { recursive: true, force: true });
    else print(`scratch copies kept under ${parent}`);
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
