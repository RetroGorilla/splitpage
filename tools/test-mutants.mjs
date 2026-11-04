import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdit, confinedPath, formatTable, killTree, loadMutants, makeScratch, parseArgs, runChild, runMutant, summarize } from "./mutants.mjs";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
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
  { label: "three", status: "caught", detail: "timeout", ms: 12000 },
  { label: "four", status: "error", detail: "find string not present", ms: 5 }
];
const s = summarize(results);
eq("summarize counts caught", s.caught, 2);
eq("summarize counts survivors", s.survived, 1);
eq("summarize line", s.line, "Mutants caught: 2/4 (1 could not run)");
check("table lists every label", results.every((r) => formatTable(results).includes(r.label)));
check("table shows the timeout detail", formatTable(results).includes("caught (timeout)"));

eq("parseArgs default has a file requirement", typeof parseArgs([]).error, "string");
eq("parseArgs reads concurrency", parseArgs(["m.json", "--concurrency", "2"]).concurrency, 2);
eq("parseArgs reads concurrency=", parseArgs(["m.json", "--concurrency=3"]).concurrency, 3);
eq("parseArgs reads timeout seconds", parseArgs(["m.json", "--timeout", "10"]).timeoutMs, 10000);
eq("parseArgs refuses zero concurrency", typeof parseArgs(["m.json", "--concurrency", "0"]).error, "string");
eq("parseArgs refuses unknown flags", typeof parseArgs(["m.json", "--nope"]).error, "string");
check("default concurrency is at least 1", parseArgs(["m.json"]).concurrency >= 1);

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
  const seen = join(handoff, "seen.json");
  mkdirSync(join(scratch, "tools"), { recursive: true });
  writeFileSync(join(scratch, "tools", "run-tests.mjs"), `import { writeFileSync } from "node:fs";\nexport function runTests(o) { writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ files: o.files, only: o.only })); return 0; }\n`);
  const many = Array.from({ length: 4000 }, (_, i) => `src/features/some-feature/long-directory-name/file-${i}.ts`);
  check("the file list is longer than a Windows command line", JSON.stringify(many).length > 200000);
  const run = await runChild(scratch, many, ["a"], 60000, process.execPath);
  eq("a very long file list reaches the child", run.code, 0);
  const got = existsSync(seen) ? JSON.parse(readFileSync(seen, "utf8")) : null;
  check("the child reads the whole file list", got !== null && got.files.length === many.length && got.files[3999] === many[3999]);
  check("the child still gets the test filter", got !== null && got.only[0] === "a");

  const missing = await runChild(scratch, many, [], 60000, join(handoff, "no-such-node"));
  check("a missing node binary is reported, not thrown", missing.code === -1 && typeof missing.error === "string");
  const refused = await runChild(scratch, many, [], 60000, "bad\0node");
  check("a spawn that throws is reported, not thrown", refused.code === -1 && typeof refused.error === "string");

  const repo = join(handoff, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(handoff, "parent"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  const outcome = await runMutant({ label: "a", file: "src/a.ts", find: "1", replace: "2", tests: [] }, { repo, files: ["src/a.ts"], parent: join(handoff, "parent"), timeoutMs: 1000, node: "bad\0node", keep: false });
  eq("a spawn failure makes the mutant an error", outcome.status, "error");
  check("the error says the test run could not start", outcome.detail.startsWith("could not start the test run"));
} finally {
  rmSync(handoff, { recursive: true, force: true });
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
  console.log("  SKIP interrupt test — signals differ on Windows");
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
