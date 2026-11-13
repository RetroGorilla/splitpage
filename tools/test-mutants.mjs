import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdit, confinedPath, exitCode, formatTable, killTree, loadMutantFiles, loadMutants, main, makeScratch, parseArgs, resolveTests, runChild, runMutant, shardOf, summarize, verdict } from "./mutants.mjs";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " â€” " + detail : ""));
  console.log("  FAIL " + name + (detail ? " â€” " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

const good = { label: "a", file: "src/x.ts", find: "1", replace: "2" };

eq("applyEdit replaces one occurrence", applyEdit("a1b", "1", "2").text, "a2b");
eq("applyEdit refuses a missing find", applyEdit("ab", "1", "2").error, "find string not present");
eq("applyEdit refuses an ambiguous find", applyEdit("a1b1", "1", "2").error, "find string occurs more than once");

const renamedTargets = {
  "application-pure": ["scene-length-changes-derive-dropped", "scene-status-changes-derive-dropped", "scene-status-grace-default"],
  "formats-text": ["csv-broll-lists-skip-unassigned", "csv-total-needs-scenes", "csv-total-text", "proj-scene-no-scenes",
    "proj-breakdown-scene-number", "proj-breakdown-orphan-scenes", "proj-table-first-index", "proj-table-first-fallback",
    "proj-table-scenes-separator", "proj-print-groups-input", "proj-breakdown-mentions", "csv-tag-cell-separator",
    "csv-broll-cell-separator", "proj-scene-number", "proj-shots-untitled", "proj-location-row-number"]
};
for (const [manifest, labels] of Object.entries(renamedTargets)) {
  const mutants = loadMutants(readFileSync(join("tools", "mutants", `${manifest}.json`), "utf8"));
  for (const label of labels) {
    const mutant = mutants.find((item) => item.label === label);
    check(`${label} still applies to its source`, !!mutant && !applyEdit(readFileSync(mutant.file, "utf8"), mutant.find, mutant.replace).error);
  }
}

eq("loadMutants takes a bare array", loadMutants(JSON.stringify([good]))[0].tests.length, 0);
eq("loadMutants takes shared tests", loadMutants(JSON.stringify({ tests: ["t"], mutants: [good] }))[0].tests[0], "t");
eq("a mutant's own tests win", loadMutants(JSON.stringify({ tests: ["t"], mutants: [{ ...good, tests: ["u"] }] }))[0].tests[0], "u");
check("loadMutants refuses an empty list", throws(() => loadMutants("[]")));
check("loadMutants refuses a missing field", throws(() => loadMutants(JSON.stringify([{ ...good, replace: undefined }]))));
check("loadMutants refuses a no-op edit", throws(() => loadMutants(JSON.stringify([{ ...good, replace: "1" }]))));
check("loadMutants refuses an empty find", throws(() => loadMutants(JSON.stringify([{ ...good, find: "" }]))));
check("loadMutants refuses duplicate labels", throws(() => loadMutants(JSON.stringify([good, good]))));

const results = [
  { label: "one", status: "caught", detail: "", ms: 1500 },
  { label: "two", status: "survived", detail: "", ms: 900 },
  { label: "three", status: "inconclusive", detail: "timeout", ms: 12000 },
  { label: "four", status: "error", detail: "find string not present", ms: 5 },
  { label: "five", status: "caught", detail: "assertion failed in \"x\"", ms: 700 }
];
const s = summarize(results);
eq("summarize counts caught", s.caught, 2);
eq("summarize counts survivors", s.survived, 1);
eq("summarize counts inconclusive", s.inconclusive, 1);
eq("summarize line", s.line, "Mutants caught: 2/5 (1 inconclusive, 1 could not run)");
check("table lists every label", results.every((r) => formatTable(results).includes(r.label)));
check("table shows the timeout detail", formatTable(results).includes("inconclusive (timeout)"));
eq("an inconclusive mutant exits 1 with the flag", exitCode({ caught: 1, survived: 0, inconclusive: 1, errors: 0 }, true), 1);
eq("an inconclusive mutant exits 0 without the flag", exitCode({ caught: 1, survived: 0, inconclusive: 1, errors: 0 }, false), 0);
const units = ["tests/a.test.ts", "tests/b.test.ts", "src/core/x.test.ts"];
eq("no filter selects every unit test", resolveTests(units, []).files.join(), units.join());
eq("a filter that matches nothing is reported", resolveTests(units, ["tests/a.test.ts", "tests/missing.test.ts"]).unmatched.join(), "tests/missing.test.ts");
eq("matching filters select their files", resolveTests(units, ["tests/b.test.ts", "core/x"]).files.join(), "tests/b.test.ts,src/core/x.test.ts");

eq("parseArgs default has a file requirement", typeof parseArgs([]).error, "string");
eq("parseArgs reads concurrency", parseArgs(["m.json", "--concurrency", "2"]).concurrency, 2);
eq("parseArgs reads concurrency=", parseArgs(["m.json", "--concurrency=3"]).concurrency, 3);
eq("parseArgs reads timeout seconds", parseArgs(["m.json", "--timeout", "10"]).timeoutMs, 10000);
eq("parseArgs refuses zero concurrency", typeof parseArgs(["m.json", "--concurrency", "0"]).error, "string");
eq("parseArgs refuses unknown flags", typeof parseArgs(["m.json", "--nope"]).error, "string");
check("default concurrency is at least 1", parseArgs(["m.json"]).concurrency >= 1);
eq("parseArgs takes several files in order", parseArgs(["a.json", "b.json", "--concurrency", "2"]).files.join(), "a.json,b.json");
eq("parseArgs reads --shard", JSON.stringify(parseArgs(["m.json", "--shard", "2/4"]).shard), JSON.stringify({ index: 2, count: 4 }));
eq("parseArgs reads --shard=", JSON.stringify(parseArgs(["m.json", "--shard=1/1"]).shard), JSON.stringify({ index: 1, count: 1 }));
eq("parseArgs reads --baseline-timeout", parseArgs(["m.json", "--baseline-timeout", "900"]).baselineTimeoutMs, 900000);
eq("the baseline timeout defaults to the mutant timeout", parseArgs(["m.json", "--timeout", "40"]).baselineTimeoutMs, 40000);
for (const bad of ["0/4", "5/4", "1/0", "2", "x/y", "9007199254740993/9007199254740992", "1/9007199254740992"]) eq(`parseArgs refuses --shard ${bad}`, typeof parseArgs(["m.json", "--shard", bad]).error, "string");
const nine = Array.from({ length: 9 }, (_, i) => ({ label: String(i) }));
eq("no shard keeps every mutant", shardOf(nine, null).length, 9);
eq("shard 1/4 takes every fourth from the first", shardOf(nine, { index: 1, count: 4 }).map((m) => m.label).join(), "0,4,8");
eq("shard 4/4 takes every fourth from the fourth", shardOf(nine, { index: 4, count: 4 }).map((m) => m.label).join(), "3,7");
eq("the shards of a list cover it exactly once", [1, 2, 3, 4].flatMap((index) => shardOf(nine, { index, count: 4 })).map((m) => m.label).sort().join(), nine.map((m) => m.label).join());
const one = { name: "a-mutants.json", text: JSON.stringify([good]) }, other = { name: "b-mutants.json", text: JSON.stringify([good]) };
eq("one file keeps its labels", loadMutantFiles([one])[0].label, "a");
eq("several files name each label's file", loadMutantFiles([one, other]).map((m) => m.label).join(), "a-mutants.json: a,b-mutants.json: a");
check("a broken file among several names that file", (() => { try { loadMutantFiles([one, { name: "c-mutants.json", text: "[]" }]); return false; } catch (e) { return e.message.startsWith("c-mutants.json: "); } })());
eq("survivors do not fail the run by default", parseArgs(["m.json"]).failOnSurvivor, false);
eq("parseArgs reads --fail-on-survivor", parseArgs(["m.json", "--fail-on-survivor"]).failOnSurvivor, true);
eq("a survivor exits 0 without the flag", exitCode({ caught: 1, survived: 1, inconclusive: 0, errors: 0 }, false), 0);
eq("a survivor exits 1 with the flag", exitCode({ caught: 1, survived: 1, inconclusive: 0, errors: 0 }, true), 1);
eq("all caught exits 0 with the flag", exitCode({ caught: 2, survived: 0, inconclusive: 0, errors: 0 }, true), 0);
eq("an error exits 2 with or without the flag", [exitCode({ caught: 0, survived: 1, inconclusive: 0, errors: 1 }, true), exitCode({ caught: 0, survived: 0, inconclusive: 0, errors: 1 }, false)].join(), "2,2");

const root = mkdtempSync(join(tmpdir(), "mutants-test-"));
try {
  const repo = join(root, "repo");
  const scratchParent = join(root, "scratch");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(scratchParent);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "");
  writeFileSync(join(repo, ".git", "HEAD"), "");
  writeFileSync(join(repo, "src", "untracked-ignored.js"), "");
  mkdirSync(join(repo, "desktop", "node_modules", "x"), { recursive: true });
  writeFileSync(join(repo, "desktop", "node_modules", "x", "i.js"), "");
  const copy = makeScratch(repo, scratchParent, ["src/a.ts"]);
  check("scratch copy holds the source", existsSync(join(copy, "src", "a.ts")));
  check("scratch copy holds only the listed files", !existsSync(join(copy, "src", "untracked-ignored.js")));
  check("scratch copy leaves nested node_modules behind", !existsSync(join(copy, "desktop")));
  check("scratch copy leaves .git behind", !existsSync(join(copy, ".git")));
  check("scratch node_modules is a link", lstatSync(join(copy, "node_modules")).isSymbolicLink());
  check("scratch node_modules reaches the dependencies", existsSync(join(copy, "node_modules", "dep", "index.js")));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const handoff = mkdtempSync(join(tmpdir(), "mutants-handoff-"));
try {
  const scratch = join(handoff, "mutant-x");
  mkdirSync(join(scratch, "tests"), { recursive: true });
  const hooks = 'import test, { before, after, beforeEach, afterEach } from "node:test"; import assert from "node:assert/strict";\n';
  const fixtures = {
    "pass.test.mjs": 'import test from "node:test"; test("passes", () => {});\n',
    "assert.test.mjs": 'import test from "node:test"; import assert from "node:assert/strict"; test("asserts", () => { assert.equal(1, 2); });\n',
    "syntax.test.mjs": 'import test from "node:test"; test("broken", () => { ) });\n',
    "exit.test.mjs": 'import test from "node:test"; test("fine", () => {}); process.exit(1);\n',
    "exit-inside.test.mjs": 'import test from "node:test"; test("exits", () => { process.exit(1); });\n',
    "throw.test.mjs": 'import test from "node:test"; test("throws", () => { null.x; });\n',
    "loop.test.mjs": 'import test from "node:test"; test("spins", () => { for (;;) {} });\n',
    "empty.test.mjs": "export {};\n",
    "before.test.mjs": hooks + 'before(() => { assert.equal(1, 2); }); test("body", () => {});\n',
    "after.test.mjs": hooks + 'after(() => { assert.equal(1, 2); }); test("body", () => {});\n',
    "before-each.test.mjs": hooks + 'beforeEach(() => { assert.equal(1, 2); }); test("body", () => {});\n',
    "after-each.test.mjs": hooks + 'afterEach(() => { assert.equal(1, 2); }); test("body", () => {});\n',
    "skip.test.mjs": hooks + 'test("skipped", { skip: true }, () => { assert.equal(1, 2); }); test.skip("also skipped", () => {});\n',
    "skip-assert.test.mjs": hooks + 'test.skip("skipped", () => { assert.equal(1, 2); }); test("runs", () => {});\n',
    "todo.test.mjs": hooks + 'test.todo("todo", () => { assert.equal(1, 2); }); test("runs", () => {});\n',
    "imports.test.mjs": hooks + 'import "./unselected.test.mjs"; test("selected passes", () => {});\n',
    "unselected.test.mjs": hooks + 'test("unselected fails", () => { assert.equal(1, 2); });\n',
    "assert-hang.test.mjs": hooks + 'test("asserts", () => { assert.equal(1, 2); }); test("hangs", () => new Promise(() => { setInterval(() => {}, 1000); }));\n',
    "cause.test.mjs": hooks + 'test("wrapped", () => { try { assert.equal(1, 2); } catch (e) { throw new Error("wrapped", { cause: e }); } });\n',
    "named.test.mjs": hooks + 'test("named", () => { const e = new Error("x"); e.name = "AssertionError"; throw e; });\n',
    "coded.test.mjs": hooks + 'test("coded", () => { const e = new Error("x"); e.code = "ERR_ASSERTION"; throw e; });\n'
  };
  for (const [name, text] of Object.entries(fixtures)) writeFileSync(join(scratch, "tests", name), text);
  const judge = async (names, timeoutMs = 60000) => {
    const chosen = names.map((name) => `tests/${name}`);
    const run = await runChild(scratch, chosen, timeoutMs, process.execPath);
    return verdict(run, run.events, chosen);
  };
  const expect = async (name, names, status, detail, timeoutMs) => {
    const got = await judge(names, timeoutMs);
    check(name, got.status === status && got.detail.includes(detail), JSON.stringify(got));
  };
  await expect("passing tests make a survivor", ["pass.test.mjs"], "survived", "");
  await expect("an assertion failure in a named test is caught", ["pass.test.mjs", "assert.test.mjs"], "caught", '"asserts"');
  await expect("a syntax error is inconclusive", ["syntax.test.mjs"], "inconclusive", "failed outside its tests");
  await expect("process.exit(1) at load is inconclusive", ["exit.test.mjs"], "inconclusive", "failed outside its tests");
  await expect("process.exit(1) inside a test is inconclusive", ["exit-inside.test.mjs"], "inconclusive", "failed outside its tests");
  await expect("an error that is not an assertion is inconclusive", ["throw.test.mjs"], "inconclusive", "TypeError");
  await expect("an endless loop is inconclusive by timeout", ["loop.test.mjs"], "inconclusive", "timeout", 5000);
  await expect("a file without tests is inconclusive", ["empty.test.mjs"], "inconclusive", "no chosen test ran");
  await expect("an assertion beside a crash in another file is still caught", ["syntax.test.mjs", "assert.test.mjs"], "caught", '"asserts"');
  await expect("an assertion in before is inconclusive, since no body ran", ["before.test.mjs"], "inconclusive", "a hook of");
  await expect("an assertion in after is inconclusive", ["after.test.mjs"], "inconclusive", "a hook of");
  await expect("an assertion in beforeEach is inconclusive", ["before-each.test.mjs"], "inconclusive", "a hook of");
  await expect("an assertion in afterEach is inconclusive", ["after-each.test.mjs"], "inconclusive", "a hook of");
  await expect("a file with only skipped tests is inconclusive", ["skip.test.mjs"], "inconclusive", "no chosen test ran");
  await expect("a skipped test's body is no evidence", ["skip-assert.test.mjs"], "survived", "");
  await expect("an assertion in a failing todo test is no evidence and fails nothing", ["todo.test.mjs"], "survived", "");
  await expect("an assertion from a test file that was not chosen is inconclusive", ["imports.test.mjs"], "inconclusive", "which was not chosen");
  await expect("an assertion stays caught when the run later times out", ["assert-hang.test.mjs"], "caught", "then the run timed out", 5000);
  await expect("a hanging file does not hide a later file's assertion", ["loop.test.mjs", "assert.test.mjs"], "caught", '"asserts"', 5000);
  await expect("an Error whose cause is an assertion is inconclusive", ["cause.test.mjs"], "inconclusive", "Error: wrapped");
  await expect("an Error merely named AssertionError is inconclusive", ["named.test.mjs"], "inconclusive", "AssertionError: x");
  await expect("an Error with code ERR_ASSERTION is caught", ["coded.test.mjs"], "caught", '"coded"');
  check("the file list reaches the child through a file", existsSync(join(handoff, "mutant-x-files.json")));
  check("the event file is removed after the run", !existsSync(join(handoff, "mutant-x-events.jsonl")));

  const missing = await runChild(scratch, ["tests/pass.test.mjs"], 60000, join(handoff, "no-such-node"));
  check("a missing node binary is reported, not thrown", missing.code === -1 && typeof missing.error === "string");
  eq("a missing node binary is an error verdict", verdict(missing, missing.events).status, "error");
  const refused = await runChild(scratch, ["tests/pass.test.mjs"], 60000, "bad\0node");
  check("a spawn that throws is reported, not thrown", refused.code === -1 && typeof refused.error === "string");

  const repo = join(handoff, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(handoff, "parent"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  const outcome = await runMutant({ label: "a", file: "src/a.ts", find: "1", replace: "2", tests: [], testFiles: [] }, { repo, files: ["src/a.ts"], parent: join(handoff, "parent"), timeoutMs: 1000, node: "bad\0node", keep: false });
  eq("a spawn failure makes the mutant an error", outcome.status, "error");
  check("the error says the test run could not start", outcome.detail.startsWith("could not start the test run"));
} finally {
  rmSync(handoff, { recursive: true, force: true });
}

const fixtureRepo = mkdtempSync(join(tmpdir(), "mutants-repo-"));
try {
  spawnSync("git", ["init", "-q"], { cwd: fixtureRepo });
  mkdirSync(join(fixtureRepo, "src"));
  mkdirSync(join(fixtureRepo, "tests"));
  writeFileSync(join(fixtureRepo, "src", "a.mjs"), "export const a = 1;\n");
  writeFileSync(join(fixtureRepo, "tests", "a.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; import { a } from "../src/a.mjs"; test("a is one", () => { assert.equal(a, 1); });\n');
  const source = { file: "src/a.mjs", find: "export const a = 1;", tests: ["tests/a.test.mjs"] };
  const run = async (name, mutants, args = []) => {
    const lines = [];
    writeFileSync(join(fixtureRepo, `${name}.json`), JSON.stringify(mutants));
    const code = await main([join(fixtureRepo, `${name}.json`), "--concurrency", "5", "--timeout", "10", ...args], { repo: fixtureRepo, print: (l) => lines.push(l), printError: (l) => lines.push(l) });
    rmSync(join(fixtureRepo, `${name}.json`));
    return { code, text: lines.join("\n") };
  };
  const kinds = await run("kinds", [
    { ...source, label: "value", replace: "export const a = 2;" },
    { ...source, label: "syntax", replace: "export const a = ;" },
    { ...source, label: "exit", replace: "export const a = 1; process.exit(1);" },
    { ...source, label: "loop", replace: "export const a = 1; for (;;) {}" },
    { ...source, label: "same", replace: "export const a =  1;" }
  ], ["--fail-on-survivor"]);
  for (const [label, status] of [["value", "caught"], ["syntax", "inconclusive"], ["exit", "inconclusive"], ["loop", "inconclusive"], ["same", "survived"]]) {
    check(`end to end: ${label} is ${status}`, kinds.text.includes(`  ${label}: ${status}`), kinds.text);
  }
  eq("end to end: survivors and inconclusive mutants exit 1 with --fail-on-survivor", kinds.code, 1);
  const crashOnly = await run("crash", [{ ...source, label: "syntax", replace: "export const a = ;" }], ["--fail-on-survivor"]);
  eq("end to end: a crash alone is not caught and fails with --fail-on-survivor", crashOnly.code, 1);

  const missing = await run("missing", [{ ...source, label: "value", replace: "export const a = 2;", tests: ["tests/a.test.mjs", "tests/nowhere.test.mjs"] }]);
  eq("a test filter that matches no file stops the run", missing.code, 2);
  check("the unmatched filter is named", missing.text.includes('"tests/nowhere.test.mjs" matches no unit test file'), missing.text);

  writeFileSync(join(fixtureRepo, "tests", "b.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; test("b fails unmutated", () => { assert.ok(false); });\n');
  const narrow = await run("narrow", [{ ...source, label: "value", replace: "export const a = 2;" }]);
  eq("a filtered list's baseline covers only its tests", narrow.code, 0);
  const mixed = await run("mixed", [{ ...source, label: "value", replace: "export const a = 2;" }, { ...source, label: "everything", replace: "export const a = 3;", tests: [] }]);
  eq("an unfiltered entry makes the baseline cover every unit test", mixed.code, 2);
  check("the baseline failure names the failing test", mixed.text.includes("tests/b.test.mjs") && mixed.text.includes("b fails unmutated"), mixed.text);
} finally {
  rmSync(fixtureRepo, { recursive: true, force: true });
}

const work = mkdtempSync(join(tmpdir(), "mutants-kill-"));
const here = join(work, "x");
check("confinedPath accepts a source file", confinedPath(here, "src/a.ts") === join(here, "src", "a.ts"));
check("confinedPath refuses a parent path", confinedPath(here, "../a.ts") === null);
check("confinedPath refuses an absolute path", confinedPath(here, join(work, "elsewhere", "a.ts")) === null);
check("confinedPath refuses node_modules", confinedPath(here, "node_modules/dep/index.js") === null);
check("confinedPath refuses nested node_modules", confinedPath(here, "desktop/node_modules/dep/index.js") === null);
check("confinedPath refuses the root itself", confinedPath(here, ".") === null);

const pidFile = join(work, "grandchild.pid");
const spinner = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); for (;;) {}`;
const parentSrc = `const { spawn } = require("child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(spinner)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
const parent = spawn(process.execPath, ["-e", parentSrc], { stdio: "ignore", detached: process.platform !== "win32" });
const deadline = Date.now() + 10000;
while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
const grandchild = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
check("grandchild is running before the kill", grandchild > 0 && alive(grandchild));
killTree(parent);
const gone = Date.now() + 10000;
while (alive(grandchild) && Date.now() < gone) await new Promise((r) => setTimeout(r, 50));
check("killTree stops the grandchild too", grandchild > 0 && !alive(grandchild));

if (process.platform === "win32") {
  console.log("  SKIP interrupt test â€” signals differ on Windows");
} else {
  const tmp = mkdtempSync(join(tmpdir(), "mutants-int-"));
  try {
    const config = join(tmp, "hang.json");
    writeFileSync(config, JSON.stringify({
      tests: ["tests/core/document/timing.test.ts"],
      mutants: [{ label: "hang", file: "src/core/document/timing.ts", find: "export const DEFAULT_WPM = 150;", replace: "export const DEFAULT_WPM = 150; while (true) {}" }]
    }));
    const script = join(dirname(fileURLToPath(import.meta.url)), "mutants.mjs");
    const runner = spawn(process.execPath, [script, config, "--no-baseline"], { stdio: "ignore", env: { ...process.env, TMPDIR: tmp } });
    const exited = new Promise((r) => runner.on("close", (code, signal) => r({ code, signal })));
    const leftovers = () => spawnSync("pgrep", ["-f", tmp], { encoding: "utf8" }).stdout.split("\n").filter((l) => l && Number(l) !== process.pid && Number(l) !== runner.pid);
    const until = async (fn, ms) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return fn(); };
    const started = await until(() => leftovers().length > 0, 60000);
    check("a hanging mutant's tests start", started);
    runner.kill("SIGINT");
    const result = await exited;
    check("SIGINT ends the run with 130", result.code === 130, JSON.stringify(result));
    check("SIGINT leaves no test process behind", await until(() => leftovers().length === 0, 10000));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
