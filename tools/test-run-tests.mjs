import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { REPO, listRepoFiles } from "./source-scan.mjs";
import { discover, runTests, parseArgs, nodeVersionWarning, unsupportedNodeError, SETS } from "./run-tests.mjs";
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
}

{
  const found = discover(["src/test/a.test.mjs", "src/test/b.test.ts", "server/api.test.mjs"]);
  eq("a test file no group runs is an orphan", found.orphans, ["server/api.test.mjs", "src/test/b.test.ts"]);
}

{
  const found = discover(["src/test/a.test.mjs", "src/core/text/runs.ts", "tests/core/text/runs.test.ts"]);
  eq("tests under tests/ satisfy migrated source", groupRequired(found, "source"), false);
  eq("migrated source with no test anywhere requires the source group", groupRequired(discover(["src/test/a.test.mjs", "src/core/text/runs.ts"]), "source"), true);
}

{
  const found = discover(["src/test/a.test.mjs"]);
  eq("the source group may be empty before any migration", groupRequired(found, "source"), false);
  eq("the frontend group is always required", groupRequired(found, "frontend"), true);
}

console.log("\nevery migrated area has a test:\n");

{
  const untested = (files) => (discover(files).untested ?? null)?.map((u) => `${u.area} ${u.tests}`) ?? null;
  eq("today's tree has a test for every area", untested(listRepoFiles(REPO)), []);
  eq("a test under tests/ for one area does not cover another", untested(["src/core/text/runs.ts", "src/application/a.ts", "tests/application/a.test.ts"]), ["src/core/text tests/core/text/"]);
  eq("and the source group is then required", groupRequired(discover(["src/core/text/runs.ts", "src/application/a.ts", "tests/application/a.test.ts"]), "source"), true);
  eq("a test beside the source covers its area", untested(["src/core/text/runs.ts", "src/core/text/runs.test.ts"]), []);
  eq("each core folder is its own area", untested(["src/core/text/a.ts", "src/core/text/a.test.ts", "src/core/merge/b.ts"]), ["src/core/merge tests/core/merge/"]);
  eq("a test under tests/core/<folder> covers only that folder", untested(["src/core/text/a.ts", "src/core/merge/b.ts", "tests/core/text/x.test.ts"]), ["src/core/merge tests/core/merge/"]);
  eq("a test directly under tests/core covers no core folder", untested(["src/core/text/a.ts", "tests/core/x.test.ts"]), ["src/core/text tests/core/text/"]);
  eq("each feature folder is its own area", untested(["src/features/rows/v.ts", "src/features/menu/m.ts", "src/features/menu/m.test.ts", "tests/legacy/x.test.ts"]), ["src/features/rows tests/features/rows/"]);
  eq("one feature's tests do not cover another feature", untested(["src/features/rows/view.ts", "src/features/shortcuts/mount.ts", "tests/features/shortcuts/mount.test.ts"]), ["src/features/rows tests/features/rows/"]);
  eq("tests/features/<folder> covers that feature", untested(["src/features/rows/v.ts", "tests/features/rows/v.test.ts"]), []);
  eq("a test directly under tests/features covers no feature", untested(["src/features/rows/v.ts", "tests/features/rows.test.ts"]), ["src/features/rows tests/features/rows/"]);
  eq("declaration files alone do not make an area", untested(["src/core/text/types.d.ts", "src/contracts/api.d.mts"]), []);
  eq("a file directly in src/core is an area of its own", untested(["src/core/a.ts", "src/core/text/a.test.ts", "tests/core/text/b.test.ts"]), ["src/core tests/core/"]);
  eq("covered by a test beside it in src/core", untested(["src/core/a.ts", "src/core/a.test.ts"]), []);
  eq("or directly under tests/core", untested(["src/core/a.ts", "tests/core/a.test.ts"]), []);
  eq("and that root test covers no core folder", untested(["src/core/a.ts", "src/core/text/b.ts", "tests/core/a.test.ts"]), ["src/core/text tests/core/text/"]);
  eq("nested folders belong to their top-level area", untested(["src/bootstrap/start/a.ts", "src/contracts/x/c.mts", "src/adapters/idb/a.cts", "tests/contracts/c.test.ts"]), ["src/adapters tests/adapters/", "src/bootstrap tests/bootstrap/"]);
  eq("a test in the wrong tests/ folder does not count", untested(["src/legacy/a.ts", "tests/legacy-old/a.test.ts", "tests/application/a.test.ts"]), ["src/legacy tests/legacy/"]);
  eq("JavaScript and test files alone do not make an area", untested(["src/legacy/a.js", "src/core/text/a.test.ts"]), []);

  const files = ["src/test/a.test.mjs", "src/core/text/runs.ts", "src/core/text/runs.test.ts", "src/application/a.ts", "tests/core/x.test.ts"];
  const err = [];
  const code = runTests({ repo: REPO, sets: ["unit"], files, print: () => {}, printError: (l) => err.push(l), spawn: () => ({ status: 0 }) });
  eq("an untested area fails the run before anything runs", code, 1);
  check("and is named with the folder that would cover it", err.join("\n").includes("run-tests: src/application holds TypeScript source but has no test beside it or under tests/application/"), err.join("\n"));
  const focused = runTests({ repo: REPO, sets: ["unit"], files, only: ["src/test/a"], print: () => {}, printError: () => {}, spawn: () => ({ status: 0 }) });
  eq("an untested area still fails a focused run", focused, 1);
  eq("a run of the tools set alone does not check areas", runTests({ repo: REPO, sets: ["tools"], files: [...files, "tools/test-x.mjs"], print: () => {}, printError: () => {}, spawn: () => ({ status: 0 }) }), 0);
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

console.log("\nfocused runs (--only):\n");

eq("--only takes a value in either spelling, and several", parseArgs(["unit", "--only", "src/test/a", "--only=b.test"]), { sets: ["unit"], listOnly: false, only: ["src/test/a", "b.test"] });
eq("no set with --only means every set", parseArgs(["--only", "x"]).sets, SETS);
check("--only with no value is a usage error", Boolean(parseArgs(["--only"]).error) && Boolean(parseArgs(["--only", "--list"]).error));
check("an unknown flag is a usage error", Boolean(parseArgs(["--changed"]).error));

{
  const files = ["src/test/a.test.mjs", "src/test/b.test.mjs", "desktop/test/d.test.mjs", "tools/test-x.mjs", "tools/test-y.mjs"];
  const focusedRun = (only, sets = SETS, extra = {}) => {
    const out = [];
    const err = [];
    const calls = [];
    const code = runTests({ repo: REPO, sets, files, only, print: (l) => out.push(l), printError: (l) => err.push(l), spawn: (cmd, args) => { calls.push(args); return { status: 0 }; }, ...extra });
    return { code, out: out.join("\n"), err: err.join("\n"), calls };
  };

  const one = focusedRun(["src/test/b"]);
  eq("only the matching file runs", one.calls, [["--test", "src/test/b.test.mjs"]]);
  eq("and the run passes", one.code, 0);
  check("the whole discovery is still printed", one.out.includes("discovered frontend: 2 files") && one.out.includes("  tools/test-y.mjs"), one.out);
  check("the selected scope is printed", one.out.includes("focused run: --only src/test/b selects 1 of 5 discovered test files in unit, desktop, tools"), one.out);
  check("it says it is not the full gate", one.out.includes("this is NOT the full gate") && one.out.includes("FOCUSED: 1 of 5 discovered test files ran; this is not the full gate"), one.out);
  check("groups with nothing selected say so", one.out.includes("desktop: none selected (1 discovered)") && one.out.includes("frontend: 1 of 1 selected files executed (2 discovered), passed"), one.out);

  const windows = focusedRun(["tools\\test-"]);
  eq("a Windows path selects the same files", windows.calls, [["tools/test-x.mjs"], ["tools/test-y.mjs"]]);

  const several = focusedRun(["a.test", "d.test"]);
  eq("several --only values select their union", several.calls, [["--test", "src/test/a.test.mjs"], ["desktop/test/d.test.mjs"]]);

  const none = focusedRun(["no-such-test"]);
  eq("a filter that matches nothing is an error, not a pass", none.code, 2);
  check("and says so", none.err.includes("--only no-such-test matched no discovered test file"), none.err);
  eq("and runs nothing", none.calls, []);

  const wrongSet = focusedRun(["tools/test-x"], ["unit"]);
  eq("a filter outside the chosen set matches nothing", wrongSet.code, 2);

  const orphaned = runTests({ repo: REPO, sets: SETS, files: [...files, "server/api.test.mjs"], only: ["src/test/a"], print: () => {}, printError: () => {}, spawn: () => { throw new Error("must not run"); } });
  eq("an orphaned test still fails a focused run, before anything runs", orphaned, 1);

  const overlap = [{ name: "one", set: "unit", runner: "script", matches: (p) => p.startsWith("src/"), requiredWhen: () => true }, { name: "two", set: "unit", runner: "script", matches: (p) => p.endsWith(".mjs"), requiredWhen: () => true }];
  eq("an overlap still fails a focused run", runTests({ repo: REPO, sets: ["unit"], files: ["src/a.test.mjs"], groups: overlap, only: ["src/a"], print: () => {}, printError: () => {}, spawn: () => { throw new Error("must not run"); } }), 1);

  const emptyRequired = runTests({ repo: REPO, sets: ["unit"], files: ["src/core/text/runs.ts", "src/test/a.test.mjs"], only: ["src/test/a"], print: () => {}, printError: () => {}, spawn: () => ({ status: 0 }) });
  eq("an empty required group still fails a focused run", emptyRequired, 1);

  const failing = focusedRun(["src/test/a"], SETS, { spawn: () => ({ status: 1 }) });
  eq("a failing selected file fails the focused run", failing.code, 1);

  const listed = focusedRun(["tools/"], SETS, { listOnly: true });
  eq("--list with --only prints the selection and runs nothing", [listed.code, listed.calls.length, listed.out.includes("selects 2 of 5")], [0, 0, true]);
}

console.log("\na stray GOLDEN_UPDATE:\n");

{
  const run = (env, extra = {}) => {
    const err = [];
    const calls = [];
    const code = runTests({ repo: REPO, sets: ["unit"], files: ["src/test/a.test.mjs"], env, print: () => {}, printError: (l) => err.push(l), spawn: (cmd, args) => { calls.push(args); return { status: 0 }; }, ...extra });
    return { code, err: err.join("\n"), calls };
  };
  const stray = run({ GOLDEN_UPDATE: "all" });
  eq("GOLDEN_UPDATE in the environment refuses the run", stray.code, 2);
  eq("and runs nothing", stray.calls, []);
  check("and says how to regenerate fixtures on purpose", stray.err.includes("node src/test/golden-helpers.mjs --update"), stray.err);
  eq("an empty GOLDEN_UPDATE is refused too", run({ GOLDEN_UPDATE: "" }).code, 2);
  eq("a focused run is refused too", run({ GOLDEN_UPDATE: "richtext" }, { only: ["src/test/a"] }).code, 2);
  eq("so is --list", run({ GOLDEN_UPDATE: "richtext" }, { listOnly: true }).code, 2);
  eq("without it the same run goes ahead", run({}).code, 0);
  const cli = spawnSync(process.execPath, [join(REPO, "tools", "run-tests.mjs"), "unit", "--list"], { cwd: REPO, encoding: "utf8", env: { ...process.env, GOLDEN_UPDATE: "all" } });
  eq("npm test reads it from the real environment and exits 2", cli.status, 2);
  check("with the same advice", (cli.stderr ?? "").includes("node src/test/golden-helpers.mjs --update"), cli.stderr);
}

console.log("\nnodeVersionWarning():\n");

{
  const repo = mkdtempSync(join(tmpdir(), "splitpage-nvmrc-"));
  eq("no .nvmrc means no warning", nodeVersionWarning("v22.22.0", repo), null);
  writeFileSync(join(repo, ".nvmrc"), "22.22.2\n");
  eq("the pinned version is silent", nodeVersionWarning("v22.22.2", repo), null);
  const warning = nodeVersionWarning("v22.22.0", repo) ?? "";
  check("another version names both and nvm use", warning.includes("22.22.0") && warning.includes("22.22.2") && warning.includes("nvm use"), warning);
  rmSync(repo, { recursive: true, force: true });
}

console.log("\nunsupportedNodeError():\n");

{
  const repo = mkdtempSync(join(tmpdir(), "splitpage-engines-"));
  eq("no package.json means no error", unsupportedNodeError("v22.22.0", repo), null);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ engines: { node: "^22.22.2 || ^24.15.0 || >=26.0.0" } }));
  writeFileSync(join(repo, ".nvmrc"), "24.22.0\n");
  for (const v of ["v22.22.2", "v22.30.0", "v24.15.0", "v24.22.0", "v26.0.0", "v27.1.0"]) eq(`${v} is inside the range`, unsupportedNodeError(v, repo), null);
  for (const v of ["v22.22.0", "v22.21.9", "v23.5.0", "v24.14.1", "v25.9.0", "v20.19.0"]) {
    const error = unsupportedNodeError(v, repo) ?? "";
    check(`${v} is outside it, and the error names it, the range and the pinned version`, error.includes(v.slice(1)) && error.includes("^22.22.2 || ^24.15.0 || >=26.0.0") && error.includes("24.22.0"), error);
  }
  writeFileSync(join(repo, "package.json"), JSON.stringify({ engines: { node: "22.x || ^24.15.0" } }));
  eq("a range it cannot read is not refused", unsupportedNodeError("v22.22.0", repo), null);
  rmSync(repo, { recursive: true, force: true });
}

{
  const spawned = [];
  const errors = [];
  const run = (opts) => runTests({ repo: REPO, sets: ["unit"], files: ["src/test/a.test.mjs"], spawn: (...a) => { spawned.push(a); return { status: 0 }; }, print: () => {}, printError: (m) => errors.push(m), ...opts });
  eq("an unsupported Node lists the tests", run({ nodeError: "too old", listOnly: true }), 0);
  eq("but refuses to run them, with exit 2", run({ nodeError: "too old" }), 2);
  eq("before spawning any", spawned.length, 0);
  check("and prints why", errors.includes("too old"), JSON.stringify(errors));
  eq("a supported Node runs them", run({}), 0);
  eq("by spawning the group", spawned.length, 1);
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

if (typed.problem && process.platform === "win32" && !process.env.CI) {
  skipped.push(`typecheck() over a temporary repository — node_modules could not be linked into it (${typed.problem})`);
  console.log("  SKIP typecheck() — node_modules could not be linked into a temporary repository: " + typed.problem);
} else if (typed.problem) {
  check("node_modules can be linked into a temporary repository (a skip is allowed only on Windows outside CI)", false, typed.problem);
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
