import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, listRepoFiles } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";

const TS_SOURCE = /\.(?:ts|mts|cts)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const TEST_FILE = /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/;
const AREAS = [
  { root: "core", perFolder: true },
  { root: "application", perFolder: false },
  { root: "contracts", perFolder: false },
  { root: "adapters", perFolder: false },
  { root: "features", perFolder: true },
  { root: "bootstrap", perFolder: false },
  { root: "legacy", perFolder: false }
];

function areaOf(path) {
  const spec = AREAS.find((a) => path.startsWith(`src/${a.root}/`));
  if (!spec) return null;
  const rest = path.slice(`src/${spec.root}/`.length).split("/");
  if (spec.perFolder && rest.length > 1) {
    return { area: `src/${spec.root}/${rest[0]}`, tests: `tests/${spec.root}/${rest[0]}/`, flat: false };
  }
  return { area: `src/${spec.root}`, tests: `tests/${spec.root}/`, flat: spec.perFolder };
}

function migratedAreas(files) {
  const areas = new Map();
  for (const p of files) {
    if (!TS_SOURCE.test(p) || DECLARATION.test(p) || TEST_FILE.test(p)) continue;
    const a = areaOf(p);
    if (a) areas.set(a.area, a);
  }
  return [...areas.values()].sort((x, y) => (x.area < y.area ? -1 : x.area > y.area ? 1 : 0));
}

const hasTestIn = (files, prefix, flat) => files.some((p) => p.startsWith(prefix) && TEST_FILE.test(p) && !(flat && p.slice(prefix.length).includes("/")));

export function untestedAreas(files) {
  return migratedAreas(files).filter((a) => !hasTestIn(files, a.area + "/", a.flat) && !hasTestIn(files, a.tests, a.flat));
}

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
    requiredWhen: (files) => migratedAreas(files).some((a) => !hasTestIn(files, a.tests, a.flat))
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
  return { groups: result, overlaps, orphans, untested: untestedAreas(files) };
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
  only = [],
  env = process.env,
  nodeError = null
} = {}) {
  if (env.GOLDEN_UPDATE !== undefined) {
    printError(`run-tests: GOLDEN_UPDATE is set (${JSON.stringify(env.GOLDEN_UPDATE)}), which would make the golden tests rewrite their fixtures instead of checking them.`);
    printError("run-tests: unset it; to regenerate fixtures on purpose run: node src/test/golden-helpers.mjs --update <name>[,<name>...] | all");
    return 2;
  }
  const { groups: found, overlaps, orphans, untested } = discover(files, groups);
  const focused = only.length > 0;
  const chosen = found.filter((e) => sets.includes(e.group.set)).map((e) => ({ ...e, selected: selectFiles(e.files, only) }));
  let failed = false;

  for (const e of chosen) {
    print(`discovered ${e.group.name}: ${e.files.length} files${e.required ? "" : " (may be empty)"}`);
    for (const f of e.files) print(`  ${f}`);
  }
  for (const o of overlaps) { failed = true; printError(`run-tests: ${o} is claimed by more than one group`); }
  for (const o of orphans) { failed = true; printError(`run-tests: ${o} looks like a test but no group runs it`); }
  if (sets.includes("unit")) {
    for (const u of untested) { failed = true; printError(`run-tests: ${u.area} holds TypeScript source but has no test beside it or ${u.flat ? "directly " : ""}under ${u.tests}`); }
  }
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
  if (nodeError) {
    printError(nodeError);
    return 2;
  }

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

function readNvmrc(repo) {
  const file = join(repo, ".nvmrc");
  return existsSync(file) ? readFileSync(file, "utf8").trim().replace(/^v/, "") || null : null;
}

export function nodeVersionWarning(version = process.version, repo = REPO) {
  const pinned = readNvmrc(repo);
  if (!pinned || version.replace(/^v/, "") === pinned) return null;
  return `run-tests: warning: running Node ${version.replace(/^v/, "")}, but .nvmrc pins ${pinned}; run \`nvm use\` first, some tests fail on other patch versions`;
}

const triple = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function satisfies(version, clause) {
  const m = /^(\^|>=)\s*(.+)$/.exec(clause.trim());
  const floor = m && triple(m[2]);
  if (!floor) return null;
  if (compare(version, floor) < 0) return false;
  return m[1] === ">=" || version[0] === floor[0];
}

export function unsupportedNodeError(version = process.version, repo = REPO) {
  const file = join(repo, "package.json");
  if (!existsSync(file)) return null;
  const range = JSON.parse(readFileSync(file, "utf8")).engines?.node;
  const v = triple(version);
  if (!range || !v) return null;
  const verdicts = range.split("||").map((c) => satisfies(v, c));
  if (verdicts.includes(null) || verdicts.includes(true)) return null;
  return `run-tests: Node ${version.replace(/^v/, "")} is outside package.json's engines (${range}), so tests fail for the runtime rather than the code (on 22.22.0, TextDecoder("latin1") breaks list-pdfs and pdf-script); install a supported Node, such as the ${readNvmrc(repo) ?? "pinned"} in .nvmrc, and run again`;
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
    const warning = nodeVersionWarning();
    if (warning) console.error(warning);
    process.exitCode = runTests({ ...parsed, nodeError: unsupportedNodeError() });
  }
}
