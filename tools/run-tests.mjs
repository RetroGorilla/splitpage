import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, listRepoFiles } from "./source-scan.mjs";

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

function runGroup(entry, { repo, node, print, spawn }) {
  const { group, files } = entry;
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
  listOnly = false
} = {}) {
  const { groups: found, overlaps, orphans } = discover(files, groups);
  const chosen = found.filter((e) => sets.includes(e.group.set));
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
  if (failed) return 1;
  if (listOnly) return 0;

  const summary = [];
  for (const e of chosen) {
    if (e.files.length === 0) { summary.push(`${e.group.name}: no files`); continue; }
    const r = runGroup(e, { repo, node, print, spawn });
    summary.push(`${e.group.name}: ${r.executed} of ${e.files.length} files executed, ${r.ok ? "passed" : "FAILED"}`);
    if (!r.ok || r.executed !== e.files.length) failed = true;
  }
  print("\nrun-tests summary");
  for (const line of summary) print(`  ${line}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const named = args.filter((a) => a !== "--list");
  const unknown = named.filter((a) => !SETS.includes(a) && a !== "all");
  if (unknown.length) {
    console.error(`run-tests: unknown set ${unknown.join(", ")}; use ${SETS.join(", ")} or all`);
    process.exitCode = 2;
  } else {
    const sets = named.length === 0 || named.includes("all") ? SETS : named;
    process.exitCode = runTests({ sets, listOnly });
  }
}
