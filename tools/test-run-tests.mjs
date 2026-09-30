import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { REPO } from "./source-scan.mjs";
import { discover, runTests } from "./run-tests.mjs";
import { typecheck, CONFIGS } from "./typecheck.mjs";

let passed = 0;
const failures = [];
const skipped = [];
const links = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const groupFiles = (found, name) => found.groups.find((g) => g.group.name === name).files;
const groupRequired = (found, name) => found.groups.find((g) => g.group.name === name).required;

console.log("\ndiscover():\n");

{
  const found = discover([
    "src/test/a.test.mjs",
    "src/core/text/runs.ts",
    "src/core/text/runs.test.ts",
    "src/features/rows/view.test.mts",
    "tests/application/session.test.ts",
    "desktop/test/drafts.test.mjs",
    "desktop/test/smoke.mjs",
    "tools/test-x.mjs"
  ]);
  eq("frontend tests are found", groupFiles(found, "frontend"), ["src/test/a.test.mjs"]);
  eq("colocated TypeScript tests are found", groupFiles(found, "source"), ["src/core/text/runs.test.ts", "src/features/rows/view.test.mts"]);
  eq("tests/ is found", groupFiles(found, "tests"), ["tests/application/session.test.ts"]);
  eq("desktop scripts that are not tests are left alone", groupFiles(found, "desktop"), ["desktop/test/drafts.test.mjs"]);
  eq("nothing is orphaned", found.orphans, []);
  eq("migrated TypeScript source makes the source group required", groupRequired(found, "source"), true);
}

{
  const found = discover(["src/test/a.test.mjs", "src/test/b.test.ts", "server/api.test.mjs"]);
  eq("a test file no group runs is an orphan", found.orphans, ["server/api.test.mjs", "src/test/b.test.ts"]);
}

{
  const found = discover(["src/test/a.test.mjs"]);
  eq("the source group may be empty before any migration", groupRequired(found, "source"), false);
  eq("the frontend group is always required", groupRequired(found, "frontend"), true);
}

const work = mkdtempSync(join(tmpdir(), "splitpage-run-tests-"));

function repoWith(files) {
  const repo = mkdtempSync(join(work, "repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

function runIn(repo, extra = {}) {
  const out = [];
  const err = [];
  const code = runTests({ repo, sets: ["unit"], print: (l) => out.push(l), printError: (l) => err.push(l), spawn: (cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: "pipe", encoding: "utf8" }), ...extra });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const passingFrontend = 'import { test } from "node:test";\ntest("frontend", () => {});\n';

console.log("\nthe discovery probe (a real run):\n");

{
  const repo = repoWith({
    "src/test/a.test.mjs": passingFrontend,
    "src/core/text/runs.ts": "export function double(n: number): number { return n * 2; }\n"
  });
  const empty = runIn(repo);
  eq("migrated source with no tests fails", empty.code, 1);
  check("and names the empty group", empty.err.includes("group source found no test files"), empty.err);

  const testPath = join(repo, "src/core/text/runs.test.ts");
  writeFileSync(testPath, [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { double } from "./runs.ts";',
    'test("double", () => { assert.equal(double(2), 5); });',
    ""
  ].join("\n"));
  const failing = runIn(repo);
  eq("a failing TypeScript test fails the run", failing.code, 1);
  check("the TypeScript test was discovered", failing.out.includes("src/core/text/runs.test.ts"), failing.out);
  check("the summary reports the failure", failing.out.includes("source: 1 of 1 files executed, FAILED"), failing.out);

  writeFileSync(testPath, [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { double } from "./runs.ts";',
    'test("double", () => { assert.equal(double(2), 4); });',
    ""
  ].join("\n"));
  const fixed = runIn(repo);
  eq("the same test passing makes the run pass", fixed.code, 0);
  check("the summary reports it executed", fixed.out.includes("source: 1 of 1 files executed, passed"), fixed.out);

  writeFileSync(join(repo, "src/test/omitted.test.ts"), passingFrontend);
  const orphan = runIn(repo);
  eq("a TypeScript test where no group looks fails", orphan.code, 1);
  check("and is named", orphan.err.includes("src/test/omitted.test.ts looks like a test but no group runs it"), orphan.err);
}

console.log("\ntypecheck():\n");

function linkNodeModules(repo) {
  const link = join(repo, "node_modules");
  try {
    symlinkSync(join(REPO, "node_modules"), link, process.platform === "win32" ? "junction" : "dir");
    links.push(link);
    return null;
  } catch (error) {
    return `${error.code ?? "error"}: ${error.message}`;
  }
}

function typedRepo(files) {
  const repo = repoWith({ "package.json": '{ "type": "module" }\n', ...files });
  for (const name of ["tsconfig.base.json", ...CONFIGS]) copyFileSync(join(REPO, name), join(repo, name));
  const problem = linkNodeModules(repo);
  return problem ? { problem } : { repo };
}

function checkTypes(repo) {
  const out = [];
  const err = [];
  const code = typecheck({ repo, print: (l) => out.push(l), printError: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const typed = typedRepo({
  "src/core/text/runs.ts": "export function double(n: number): number { return n * 2; }\n",
  "src/core/text/runs.test.ts": 'import { test } from "node:test";\nimport { double } from "./runs.ts";\ntest("d", () => { double(1); });\n'
});

if (typed.problem) {
  skipped.push(`typecheck() over a temporary repository — node_modules could not be linked into it (${typed.problem})`);
  console.log("  SKIP typecheck() — node_modules could not be linked into a temporary repository: " + typed.problem);
} else {
  const { repo } = typed;
  const clean = checkTypes(repo);
  eq("clean core and test files pass", clean.code, 0);
  check("each config reports its own files", clean.out.includes("tsconfig.core.json: 1 files") && clean.out.includes("tsconfig.test.json: 1 files"), clean.out);

  writeFileSync(join(repo, "src/core/text/dom.ts"), "export const w = document.title;\n");
  const dom = checkTypes(repo);
  eq("core cannot see DOM declarations", dom.code, 1);
  check("the error names document", dom.err.includes("Cannot find name 'document'"), dom.err);
  rmSync(join(repo, "src/core/text/dom.ts"));

  writeFileSync(join(repo, "src/core/text/opt.ts"), "export interface O { a?: string }\nexport const o: O = { a: undefined };\n");
  eq("exactOptionalPropertyTypes is on", checkTypes(repo).code, 1);
  rmSync(join(repo, "src/core/text/opt.ts"));

  writeFileSync(join(repo, "src/core/text/ns.ts"), "export namespace N { export const a = 1; }\n");
  eq("non-erasable syntax is rejected", checkTypes(repo).code, 1);
  rmSync(join(repo, "src/core/text/ns.ts"));

  mkdirSync(join(repo, "server"), { recursive: true });
  writeFileSync(join(repo, "server/stray.ts"), "export const s = 1;\n");
  const stray = checkTypes(repo);
  eq("a TypeScript file outside every config fails", stray.code, 1);
  check("and is named", stray.err.includes("server/stray.ts is not in any of"), stray.err);
}

for (const link of links) unlinkSync(link);
rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed, ${skipped.length} skipped\n`);
for (const s of skipped) console.log("  SKIP " + s);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
