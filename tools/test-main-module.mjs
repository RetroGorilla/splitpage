import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { REPO } from "./source-scan.mjs";

let passed = 0;
const failures = [];
const skipped = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const work = mkdtempSync(join(tmpdir(), "splitpage-main-module-"));

const links = [];

function link(target, path) {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    links.push(path);
    return null;
  } catch (error) {
    return `${error.code ?? "error"}: ${error.message}`;
  }
}

const repo = join(work, "repo");
mkdirSync(join(repo, "tools"), { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: repo });
for (const name of readdirSync(join(REPO, "tools"))) {
  if (/\.(?:mjs|json)$/.test(name)) copyFileSync(join(REPO, "tools", name), join(repo, "tools", name));
}
const problem = link(join(REPO, "node_modules"), join(repo, "node_modules")) ?? link(join(repo, "tools"), join(repo, "linked"));

const node = (cwd, args) => {
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

const CASES = [
  ["artifact-files.mjs", ["--bogus"], (r) => r.code === 2 && r.err.includes("usage: node tools/artifact-files.mjs")],
  ["ci-changes.mjs", [], (r) => r.code === 0 && r.out.includes("ci-changes: code=true")],
  ["comment-gate.mjs", ["--bogus"], (r) => r.code === 2 && r.err.includes("comment-gate: unknown argument --bogus")],
  ["dep-report.mjs", ["--bogus"], (r) => r.code === 2 && r.err.includes("dep-report: unknown argument --bogus")],
  ["perf-record.mjs", [], (r) => r.code === 2 && r.err.includes("perf-record: index.html is not built")],
  ["run-suites.mjs", ["--bogus"], (r) => r.code !== 0 && r.err.includes("run-suites: unknown option --bogus")],
  ["run-tests.mjs", ["--bogus"], (r) => r.code === 2 && r.err.includes("run-tests: unknown flag --bogus")],
  ["typecheck.mjs", [], (r) => r.code === 1 && r.err.includes("typecheck: tsconfig.core.json is missing")]
];

if (problem && process.platform === "win32" && !process.env.CI) {
  skipped.push(`scripts run through a linked folder — the link could not be made (${problem})`);
  console.log("  SKIP scripts run through a linked folder — the link could not be made: " + problem);
} else if (problem) {
  check("a linked folder can be made (a skip is allowed only on Windows outside CI)", false, problem);
} else {
  console.log("\nisMain():\n");

  const helper = join(REPO, "tools", "main-module.mjs");
  if (!existsSync(helper)) {
    check("tools/main-module.mjs exists", false, helper);
  } else {
    const fixture = join(work, "fixture");
    mkdirSync(fixture);
    const url = JSON.stringify(pathToFileURL(helper).href);
    writeFileSync(join(fixture, "lib.mjs"), `import { isMain } from ${url};\nconsole.log("lib:" + isMain(import.meta.url));\n`);
    writeFileSync(join(fixture, "main.mjs"), `import { isMain } from ${url};\nimport "./lib.mjs";\nconsole.log("main:" + isMain(import.meta.url));\n`);
    const linkedFixture = join(work, "linked-fixture");
    const fixtureProblem = link(fixture, linkedFixture);
    eq("run directly, the entry is main and its import is not", node(work, [join(fixture, "main.mjs")]).out.split(/\r?\n/).filter(Boolean), ["lib:false", "main:true"]);
    if (fixtureProblem) check("the fixture can be linked", false, fixtureProblem);
    else eq("run through a linked folder, the same", node(work, [join(linkedFixture, "main.mjs")]).out.split(/\r?\n/).filter(Boolean), ["lib:false", "main:true"]);
    eq("a relative entry path through the link is main", node(work, [join("linked-fixture", "main.mjs")]).out.split(/\r?\n/).filter(Boolean), ["lib:false", "main:true"]);
  }

  console.log("\nevery tool runs when started through a linked folder:\n");

  for (const [script, args, ok] of CASES) {
    const direct = node(repo, [join("tools", script), ...args]);
    check(`${script} run directly`, ok(direct), `exit ${direct.code}, stdout ${JSON.stringify(direct.out.slice(0, 200))}, stderr ${JSON.stringify(direct.err.slice(0, 200))}`);
    const linked = node(repo, [join("linked", script), ...args]);
    check(`${script} run through a linked folder`, ok(linked), `exit ${linked.code}, stdout ${JSON.stringify(linked.out.slice(0, 200))}, stderr ${JSON.stringify(linked.err.slice(0, 200))}`);
  }

  console.log("\nthe shipped updater runs when started through a linked folder:\n");

  const app = join(work, "app");
  mkdirSync(app);
  copyFileSync(join(REPO, "update.mjs"), join(app, "update.mjs"));
  const appProblem = link(app, join(work, "linked-app"));
  const env = { ...process.env, SPLITPAGE_UPDATE_API: "invalid:" };
  const updater = (dir) => {
    const r = spawnSync(process.execPath, [join(dir, "update.mjs"), "--json"], { cwd: work, encoding: "utf8", env, timeout: 60000 });
    return { code: r.status, out: r.stdout ?? "" };
  };
  eq("update.mjs run directly reports the failed check", [updater("app").code, updater("app").out.includes('"ok":false')], [1, true]);
  if (appProblem) check("the app folder can be linked", false, appProblem);
  else eq("update.mjs run through a linked folder reports it too", [updater("linked-app").code, updater("linked-app").out.includes('"ok":false')], [1, true]);
}

for (const path of links) unlinkSync(path);
rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed, ${skipped.length} skipped\n`);
for (const s of skipped) console.log("  SKIP " + s);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
