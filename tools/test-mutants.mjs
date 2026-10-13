import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit, formatTable, loadMutants, makeScratch, parseArgs, summarize } from "./mutants.mjs";

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
  const copy = makeScratch(repo, scratchParent);
  check("scratch copy holds the source", existsSync(join(copy, "src", "a.ts")));
  check("scratch copy leaves .git behind", !existsSync(join(copy, ".git")));
  check("scratch node_modules is a link", lstatSync(join(copy, "node_modules")).isSymbolicLink());
  check("scratch node_modules reaches the dependencies", existsSync(join(copy, "node_modules", "dep", "index.js")));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
