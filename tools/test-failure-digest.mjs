import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDigest, digestFromLogDir, judge, suiteNumber, SECTION_LIMIT } from "./failure-digest.mjs";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " - " + detail : ""));
  console.log("  FAIL " + name + (detail ? " - " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const green = (n) => ["at http://localhost:1/", ...Array.from({ length: n }, (_, i) => `PASS check ${i}`), `RESULT: ${n}/${n} checks passed`].join("\n");

const failing = [
  "at http://localhost:1/",
  "line a",
  "line b",
  "line c",
  "line d",
  "line e",
  "line f",
  "FAIL document.title",
  "     expected: 'One'",
  "     actual:   'Two'",
  "PASS later",
  "ERROR: JS error: boom is not defined",
  "RESULT: 1/3 checks passed - 2 FAILED"
].join("\n");

console.log("\nfailure-digest:\n");

eq("suite numbers come from the file name", [suiteNumber("03-exports"), suiteNumber("exports")], ["03", ""]);
eq("a green suite judges as passing", [judge(green(4).split("\n")).ran, judge(green(4).split("\n")).failed], [4, 0]);
eq("a missing RESULT line is one failed check", [judge(["x"]).ran, judge(["x"]).failed], [1, 1]);
eq("more passed than ran is one failed check", [judge(["RESULT: 5/3 checks passed"]).failed, judge(["RESULT: 5/3 checks passed"]).reason !== null], [1, true]);

const clean = buildDigest({ suites: [{ name: "01-core", out: green(3) }, { name: "02-prod", out: green(2) }] });
eq("a green run digests to one line", clean.text, "ALL PASS - 5/5 checks across 2 suite(s)\n");

const mixed = buildDigest({ suites: [{ name: "01-core", out: green(3) }, { name: "02-prod", out: failing }] });
const mixedLines = mixed.text.split("\n");
eq("the overall line counts the failed suite", mixedLines[0], "FAILED - 4/6 checks passed across 2 suite(s), 1 suite(s) failed");
check("the failing suite is named with its number", mixed.text.includes("== suite 02 02-prod: RESULT: 1/3 checks passed - 2 FAILED"), mixed.text);
check("the failing check keeps 5 lines of context, not 6", mixed.text.includes("  . line b") && mixed.text.includes("  . line f") && !mixed.text.includes("line a"), mixed.text);
check("expected and actual follow the failure", mixed.text.includes("  >      expected: 'One'") && mixed.text.includes("  >      actual:   'Two'"), mixed.text);
check("the exception text is kept", mixed.text.includes("  > ERROR: JS error: boom is not defined"), mixed.text);
check("the passing suite does not appear", !mixed.text.includes("01-core"), mixed.text);
eq("the failed-suite and check counts are returned", [mixed.failedSuites, mixed.failedChecks, mixed.checks], [1, 2, 6]);

const zero = buildDigest({ suites: [{ name: "07-empty", out: "at http://localhost:1/\nWARNING: no expect/wait assertions ran - this proved nothing.\nRESULT: 0/0 checks passed" }] });
check("a suite that ran 0 checks is a failure", zero.text.startsWith("FAILED - 0/1 checks passed across 1 suite(s), 1 suite(s) failed"), zero.text);
check("and says why, with the log tail", zero.text.includes("no checks ran, counted as one failed check") && zero.text.includes("  . at http://localhost:1/"), zero.text);

const silent = buildDigest({ suites: [{ name: "08-dead", out: "partial output" }, { name: "09-gone", out: null }] });
check("a suite with no RESULT or no log is a failure", silent.failedSuites === 2 && silent.text.includes("no RESULT line") && silent.text.includes("no log was written"), silent.text);

const retried = buildDigest({
  suites: [
    { name: "03-a", out: green(1), err: "[driver] static server attempt 1 of 3 failed: port 5: conflicts\n[driver] server up on http://localhost:5/" },
    { name: "04-b", out: green(1), err: "[driver] static server attempt 2 of 3 failed: port 6: busy" }
  ]
});
check("retries are listed even when the run is green", retried.text.startsWith("ALL PASS") && retried.text.includes("retries (2):") && retried.text.includes("  03-a: [driver] static server attempt 1 of 3 failed: port 5: conflicts") && retried.text.includes("04-b:"), retried.text);
check("a line that is not a retry is not listed", !retried.text.includes("server up"), retried.text);

const warned = buildDigest({
  suites: [
    { name: "01-a", out: "WARNING: no expect/wait assertions ran - this proved nothing.\n" + green(1) },
    { name: "02-b", out: "WARNING: no expect/wait assertions ran - this proved nothing.\nWARNING: no expect/wait assertions ran - this proved nothing.\n" + green(1) },
    { name: "03-c", out: "warning: lowercase page noise\n" + green(1) }
  ]
});
check("warnings are de-duplicated with a count", warned.text.includes("  x3 in 2 suite(s): WARNING: no expect/wait assertions ran - this proved nothing."), warned.text);
check("page noise in lowercase is not a warning", !warned.text.includes("lowercase page noise"), warned.text);
eq("a green run with a warning is the overall line, then the warnings", warned.text.split("\n").slice(0, 3), ["ALL PASS - 3/3 checks across 3 suite(s)", "", "warnings:"]);

const many = ["start", ...Array.from({ length: 80 }, (_, i) => `FAIL check ${i}`), "RESULT: 0/80 checks passed - 80 FAILED"].join("\n");
const cut = buildDigest({ suites: [{ name: "10-big", out: many }], logPath: () => "C:\\logs\\10-big.out.txt" });
const cutLines = cut.text.split("\n").filter((l) => l.startsWith("  "));
eq("a long section is cut to the limit plus a pointer", cutLines.length, SECTION_LIMIT + 1);
check("the pointer names the full log and the cut size", cutLines.at(-1).includes("more line(s) cut; full log: C:\\logs\\10-big.out.txt"), cutLines.at(-1));
check("a section under the limit has no pointer", !mixed.text.includes("full log:"), mixed.text);
const small = buildDigest({ suites: [{ name: "10-big", out: many }], limit: 5 });
check("the limit is adjustable", small.text.includes("  ... 76 more line(s) cut"), small.text);

const adjacent = buildDigest({ suites: [{ name: "11-adj", out: "a\nb\nFAIL one\nFAIL two\nRESULT: 0/2 checks passed - 2 FAILED" }] });
eq("adjacent failures do not repeat context lines", adjacent.text.split("\n").filter((l) => l === "  > FAIL one").length, 1);

const work = mkdtempSync(join(tmpdir(), "splitpage-digest-"));
try {
  writeFileSync(join(work, "01-core.out.txt"), green(2));
  writeFileSync(join(work, "01-core.err.txt"), "[driver] static server attempt 1 of 3 failed: x");
  writeFileSync(join(work, "02-bad.out.txt"), failing);
  const fromDir = digestFromLogDir(work, ["01-core", "02-bad", "03-missing"]);
  check("reading a log folder finds failures, retries and a missing log", fromDir.failedSuites === 2 && fromDir.text.includes("retries (1):") && fromDir.text.includes("no log was written"), fromDir.text);
  check("the pointer path is the suite's own .out.txt", digestFromLogDir(work, ["02-bad"], 3).text.includes(join(work, "02-bad.out.txt")), "");

  const cli = fileURLToPath(new URL("./failure-digest.mjs", import.meta.url));
  const outFile = join(work, "digest.txt");
  const run = spawnSync(process.execPath, [cli, "--logs", work, "--out", outFile, "--suites", "01-core,02-bad"], { encoding: "utf8" });
  eq("the command line writes digest.txt and exits 0", [run.status, readFileSync(outFile, "utf8").split("\n")[0]], [0, "FAILED - 3/5 checks passed across 2 suite(s), 1 suite(s) failed"]);
  eq("the command line without options exits 2", spawnSync(process.execPath, [cli], { encoding: "utf8" }).status, 2);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
