import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO, listRepoFiles } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";

const TS_SOURCE = /\.(?:ts|mts|cts)$/;
const TEST_FILE = /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/;
const MIGRATED_ROOTS = ["src/core/", "src/application/", "src/contracts/", "src/adapters/", "src/features/", "src/bootstrap/", "src/legacy/"];

export const GROUPS = [
  {
    name: "frontend",
    set: "unit",
    runner: "node-test",
    matches: (p) => /^src\/test\/[^/]+\.test\.mjs$/.test(p),
    requiredWhen: () => true
  },
  {
    name: "source",
    set: "unit",
    runner: "node-test",
    matches: (p) => p.startsWith("src/") && !p.startsWith("src/test/") && TEST_FILE.test(p),
    requiredWhen: (files) => files.some((p) => MIGRATED_ROOTS.some((r) => p.startsWith(r)) && TS_SOURCE.test(p) && !TEST_FILE.test(p))
      && !files.some((p) => p.startsWith("tests/") && TEST_FILE.test(p))
  },
  {
    name: "tests",
    set: "unit",
    runner: "node-test",
    matches: (p) => p.startsWith("tests/") && TEST_FILE.test(p),
    requiredWhen: (files) => files.some((p) => p.startsWith("tests/") && TS_SOURCE.test(p))
  },
  {
    name: "desktop",
    set: "desktop",
    runner: "script",
    matches: (p) => /^desktop\/test\/[^/]+\.test\.mjs$/.test(p),
    requiredWhen: () => true
  },
  {
    name: "tools",
    set: "tools",
    runner: "script",
    matches: (p) => /^tools\/test-[^/]+\.mjs$/.test(p),
    requiredWhen: () => true
  }
];

export const SETS = ["unit", "desktop", "tools"];

export function discover(files, groups = GROUPS) {
  const claimed = new Map();
  const result = groups.map((g) => {
    const selected = files.filter((p) => g.matches(p)).sort();
    for (const p of selected) claimed.set(p, [...(claimed.get(p) ?? []), g.name]);
    return { group: g, files: selected, required: g.requiredWhen(files) };
  });
  const overlaps = [...claimed].filter(([, names]) => names.length > 1).map(([p, names]) => `${p} (${names.join(", ")})`);
  const orphans = files.filter((p) => TEST_FILE.test(p) && !claimed.has(p) && !/(^|\/)node_modules\//.test(p)).sort();
  return { groups: result, overlaps, orphans };
}

export function normalizePattern(pattern) {
  return pattern.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function selectFiles(files, only) {
  if (!only.length) return files;
  const patterns = only.map(normalizePattern);
  return files.filter((f) => patterns.some((p) => f.includes(p)));
}

function runGroup(entry, { repo, node, print, spawn }) {
  const { group } = entry;
  const files = entry.selected;
  if (group.runner === "node-test") {
    print(`\n[${group.name}] node --test ${files.length} files`);
    const r = spawn(node, ["--test", ...files], { cwd: repo, stdio: "inherit" });
    return { executed: files.length, ok: r.status === 0, status: r.status ?? r.signal ?? r.error?.message };
  }
  let executed = 0;
  let ok = true;
  for (const file of files) {
    print(`\n[${group.name}] node ${file}`);
    const r = spawn(node, [file], { cwd: repo, stdio: "inherit" });
    executed++;
    if (r.status !== 0) { ok = false; print(`[${group.name}] ${file} exited ${r.status ?? r.signal ?? r.error?.message}`); }
  }
  return { executed, ok, status: ok ? 0 : 1 };
}

export function runTests({
  repo = REPO,
  sets = SETS,
  files = listRepoFiles(repo).filter((p) => existsSync(join(repo, p))),
  groups = GROUPS,
  node = process.execPath,
  print = console.log,
  printError = console.error,
  spawn = spawnSync,
  listOnly = false,
  only = []
} = {}) {
  const { groups: found, overlaps, orphans } = discover(files, groups);
  const focused = only.length > 0;
  const chosen = found.filter((e) => sets.includes(e.group.set)).map((e) => ({ ...e, selected: selectFiles(e.files, only) }));
  let failed = false;

  for (const e of chosen) {
    print(`discovered ${e.group.name}: ${e.files.length} files${e.required ? "" : " (may be empty)"}`);
    for (const f of e.files) print(`  ${f}`);
  }
  for (const o of overlaps) { failed = true; printError(`run-tests: ${o} is claimed by more than one group`); }
  for (const o of orphans) { failed = true; printError(`run-tests: ${o} looks like a test but no group runs it`); }
  for (const e of chosen) {
    if (e.required && e.files.length === 0) { failed = true; printError(`run-tests: group ${e.group.name} found no test files`); }
  }

  const discovered = chosen.reduce((n, e) => n + e.files.length, 0);
  const picked = chosen.reduce((n, e) => n + e.selected.length, 0);
  const scope = only.map(normalizePattern).join(", ");
  if (focused) {
    print(`\nfocused run: --only ${scope} selects ${picked} of ${discovered} discovered test files in ${sets.join(", ")}`);
    for (const e of chosen) for (const f of e.selected) print(`  ${f}`);
    print("focused run: this is NOT the full gate; `npm run test:all`, which CI runs, executes every discovered file");
  }
  if (failed) return 1;
  if (focused && picked === 0) {
    printError(`run-tests: --only ${scope} matched no discovered test file in ${sets.join(", ")}`);
    return 2;
  }
  if (listOnly) return 0;

  const summary = [];
  for (const e of chosen) {
    const extra = focused ? ` (${e.files.length} discovered)` : "";
    if (e.files.length === 0) { summary.push(`${e.group.name}: no files`); continue; }
    if (e.selected.length === 0) { summary.push(`${e.group.name}: none selected${extra}`); continue; }
    const r = runGroup(e, { repo, node, print, spawn });
    summary.push(`${e.group.name}: ${r.executed} of ${e.selected.length} ${focused ? "selected " : ""}files executed${extra}, ${r.ok ? "passed" : "FAILED"}`);
    if (!r.ok || r.executed !== e.selected.length) failed = true;
  }
  print("\nrun-tests summary");
  for (const line of summary) print(`  ${line}`);
  if (focused) print(`  FOCUSED: ${picked} of ${discovered} discovered test files ran; this is not the full gate`);
  return failed ? 1 : 0;
}

export function parseArgs(args) {
  const only = [];
  const named = [];
  let listOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--list") listOnly = true;
    else if (a === "--only" || a.startsWith("--only=")) {
      const value = a === "--only" ? args[++i] : a.slice("--only=".length);
      if (!value || value.startsWith("--")) return { error: "--only needs a path or a substring of one" };
      only.push(value);
    } else if (a.startsWith("--")) return { error: `unknown flag ${a}; use --list or --only <path-or-substring>` };
    else named.push(a);
  }
  const unknown = named.filter((a) => !SETS.includes(a) && a !== "all");
  if (unknown.length) return { error: `unknown set ${unknown.join(", ")}; use ${SETS.join(", ")} or all` };
  const sets = named.length === 0 || named.includes("all") ? SETS : named;
  return { sets, listOnly, only };
}

if (isMain(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`run-tests: ${parsed.error}`);
    process.exitCode = 2;
  } else {
    process.exitCode = runTests(parsed);
  }
}
