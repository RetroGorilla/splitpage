import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { REPO, listRepoFiles } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";

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
  const caught = results.filter((r) => r.status === "caught").length;
  const survived = results.filter((r) => r.status === "survived").length;
  const errors = results.filter((r) => r.status === "error").length;
  const line = `Mutants caught: ${caught}/${results.length}` + (errors ? ` (${errors} could not run)` : "");
  return { caught, survived, errors, line };
}

export function formatTable(results) {
  const rows = results.map((r) => [r.label, r.detail ? `${r.status} (${r.detail})` : r.status, `${(r.ms / 1000).toFixed(1)}s`]);
  const header = ["label", "result", "duration"];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const fmt = (cells) => cells.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd();
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

const CHILD = `
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [, scratch, filesJson, onlyJson] = process.argv;
const { runTests } = await import(pathToFileURL(scratch + "/tools/run-tests.mjs").href);
const quiet = () => {};
process.exitCode = runTests({
  repo: scratch,
  files: JSON.parse(filesJson),
  sets: ["unit"],
  only: JSON.parse(onlyJson),
  print: quiet,
  printError: quiet,
  spawn: (cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: "ignore" })
});
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

function childEnv() {
  const env = { ...process.env };
  delete env.GOLDEN_UPDATE;
  return env;
}

function runChild(scratch, files, only, timeoutMs, node) {
  return new Promise((resolveRun) => {
    const child = spawn(node, ["--input-type=module", "-e", CHILD, scratch, JSON.stringify(files), JSON.stringify(only)], { cwd: scratch, stdio: "ignore", env: childEnv(), detached: process.platform !== "win32" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolveRun({ code: -1, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, timedOut }); });
  });
}

export async function runMutant(mutant, { repo, files, parent, timeoutMs, node, keep }) {
  const started = Date.now();
  const done = (status, detail, extra = {}) => ({ label: mutant.label, status, detail, ms: Date.now() - started, ...extra });
  let scratch;
  try {
    const original = confinedPath(repo, mutant.file);
    if (!original) return done("error", `${mutant.file} is outside the repository or under node_modules`);
    if (!existsSync(original)) return done("error", `${mutant.file} not found`);
    const edit = applyEdit(readFileSync(original, "utf8"), mutant.find, mutant.replace);
    if (edit.error) return done("error", edit.error);
    scratch = makeScratch(repo, parent, files);
    writeFileSync(join(scratch, mutant.file), edit.text);
    const run = await runChild(scratch, files, mutant.tests, timeoutMs, node);
    if (run.timedOut) return done("caught", "timeout");
    if (run.code === 0) return done("survived", "");
    if (run.code === 1) return done("caught", "");
    return done("error", `test run exited ${run.code}`);
  } catch (e) {
    return done("error", e.message);
  } finally {
    if (scratch && !keep) rmSync(scratch, { recursive: true, force: true });
  }
}

export async function baselinePasses({ repo, files, parent, timeoutMs, node, tests }) {
  const scratch = makeScratch(repo, parent, files);
  try {
    const run = await runChild(scratch, files, tests, timeoutMs, node);
    return run.code === 0 && !run.timedOut;
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

export function parseArgs(args) {
  const opts = { file: null, concurrency: defaultConcurrency(), timeoutMs: DEFAULT_TIMEOUT_MS, keep: false, baseline: true };
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
    } else if (a === "--keep") opts.keep = true;
    else if (a === "--no-baseline") opts.baseline = false;
    else if (a.startsWith("--")) return { error: `unknown flag ${a}; use --concurrency, --timeout, --keep or --no-baseline` };
    else if (opts.file) return { error: "only one mutants file is accepted" };
    else opts.file = a;
  }
  if (!opts.file) return { error: "usage: node tools/mutants.mjs <mutants.json> [--concurrency N] [--timeout SECONDS] [--keep] [--no-baseline]" };
  return opts;
}

export async function main(args, { repo = REPO, print = console.log, printError = console.error, node = process.execPath } = {}) {
  const opts = parseArgs(args);
  if (opts.error) { printError(`mutants: ${opts.error}`); return 2; }
  let mutants;
  try {
    mutants = loadMutants(readFileSync(resolve(opts.file), "utf8"));
  } catch (e) {
    printError(`mutants: ${e.message}`);
    return 2;
  }
  const files = listRepoFiles(repo).filter((p) => existsSync(join(repo, p)));
  const parent = mkdtempSync(join(tmpdir(), "splitpage-mutants-"));
  const base = { repo, files, parent, timeoutMs: opts.timeoutMs, node, keep: opts.keep };
  try {
    if (opts.baseline) {
      const scope = [...new Set(mutants.flatMap((m) => m.tests))];
      const ok = await baselinePasses({ ...base, tests: scope });
      if (!ok) { printError("mutants: the unmutated copy fails its tests, so every mutant would count as caught; fix that first (or pass --no-baseline)"); return 2; }
    }
    print(`running ${mutants.length} mutants, ${Math.min(opts.concurrency, mutants.length)} at a time`);
    const results = await runAll(mutants, { ...base, concurrency: opts.concurrency, onResult: (r) => print(`  ${r.label}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`) });
    print("");
    print(formatTable(results));
    const s = summarize(results);
    print("");
    print(s.line);
    for (const r of results.filter((x) => x.status === "survived")) print(`survived: ${r.label} (record why it was accepted, or add a test)`);
    for (const r of results.filter((x) => x.status === "error")) print(`error: ${r.label}: ${r.detail}`);
    return s.errors > 0 ? 2 : 0;
  } finally {
    if (!opts.keep) rmSync(parent, { recursive: true, force: true });
    else print(`scratch copies kept under ${parent}`);
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
