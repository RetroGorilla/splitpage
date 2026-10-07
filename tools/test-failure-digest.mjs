import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDigest, digestFromLogDir, judge, suiteNumber, validateVerdicts, SECTION_LIMIT } from "./failure-digest.mjs";

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
eq("a green suite judges as passing", [judge(green(4).split("\n")).checks, judge(green(4).split("\n")).suiteFailed], [4, false]);
eq("a missing RESULT line is one failed check", [judge(["x"]).checks, judge(["x"]).failedChecks, judge(["x"]).suiteFailed], [1, 1, true]);
eq("more passed than ran is one failed check", [judge(["RESULT: 5/3 checks passed"]).failedChecks, judge(["RESULT: 5/3 checks passed"]).reason !== null], [1, true]);
eq("a RESULT that is not at the start of its line does not count", judge(["see RESULT: 5/5 checks passed"]).suiteFailed, true);
eq("the runner's last RESULT line wins, matched case-insensitively", [judge(["RESULT: 3/3 checks passed", "RESULT: garbage"]).suiteFailed, judge(["RESULT: 3/3 checks passed", "RESULT: garbage"]).failedChecks], [true, 1]);
eq("a later good RESULT wins over an earlier garbage one", judge(["RESULT: garbage", "RESULT: 3/3 checks passed"]).suiteFailed, false);
eq("a lowercase result line is still the result line", judge(["result: 2/2 checks passed"]).suiteFailed, false);
eq("FAILED text on a full pass still fails the suite, with no failed checks", [judge(["RESULT: 3/3 checks passed - FAILED"]).suiteFailed, judge(["RESULT: 3/3 checks passed - FAILED"]).failedChecks], [true, 0]);
const twoResults = buildDigest({ suites: [{ name: "01-a", out: "RESULT: 3/3 checks passed\nRESULT: garbage" }] });
check("two RESULT lines, the last unreadable, digest as a failure", twoResults.text.startsWith("FAILED - 0/1 checks passed") && twoResults.text.includes("unreadable RESULT line"), twoResults.text);

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

const exact = (n) => [...Array.from({ length: n }, (_, i) => `FAIL e${i}`), `RESULT: 0/${n} checks passed - ${n} FAILED`].join("\n");
const atLimit = buildDigest({ suites: [{ name: "12-edge", out: exact(SECTION_LIMIT) }] });
check("a section of exactly the limit has no pointer", !atLimit.text.includes("more line(s) cut"), atLimit.text);
const overLimit = buildDigest({ suites: [{ name: "12-edge", out: exact(SECTION_LIMIT + 1) }] });
check("one line past the limit gets a pointer saying 1 line was cut", overLimit.text.includes("  ... 1 more line(s) cut; full log: 12-edge"), overLimit.text);

const noisy = ["n1", "n2", "n3", "n4", "n5", ...Array.from({ length: 70 }, (_, i) => `noise ${i}`), "FAIL the real one", "     expected: 1", "     actual:   2", "RESULT: 0/1 checks passed - 1 FAILED"].join("\n");
const noisyDigest = buildDigest({ suites: [{ name: "13-noise", out: noisy }] });
check("noise before a failure never pushes the failure past the cap", noisyDigest.text.includes("  > FAIL the real one") && noisyDigest.text.includes("  >      actual:   2"), noisyDigest.text);
const crowded = buildDigest({ suites: [{ name: "14-crowd", out: [...Array.from({ length: 30 }, (_, i) => `FAIL f${i}\nctx-a${i}\nctx-b${i}`), "RESULT: 0/30 checks passed - 30 FAILED"].join("\n") }], limit: 40 });
check("every failure line is listed before any context is, and context is trimmed first", Array.from({ length: 30 }, (_, i) => crowded.text.includes(`  > FAIL f${i}`)).every(Boolean), crowded.text);
eq("the trimmed section stays within the limit plus its pointer", crowded.text.split("\n").filter((l) => l.startsWith("  ")).length <= 41 + 1, true);

const continued = buildDigest({ suites: [{ name: "15-cont", out: "FAIL x\n    a\n    b\n    c\n    d\n    e\n    f\n    g\nRESULT: 0/1 checks passed - 1 FAILED" }] });
check("up to 5 continuation lines follow a failure", continued.text.includes("  >     e") && !continued.text.includes("    f"), continued.text);

const started = buildDigest({ suites: [{ name: "16-ns", out: "NOT STARTED: static server did not come up\nRESULT: 0/1 checks passed - 1 FAILED" }] });
check("a NOT STARTED line is a failure line", started.text.includes("  > NOT STARTED: static server did not come up"), started.text);

const quoted = buildDigest({ suites: [{ name: "17-q", out: "FAIL " + "z".repeat(400) + "\nRESULT: 0/1 checks passed - 1 FAILED", err: "[driver] WARNING: " + "w".repeat(400) }] });
check("long lines are clipped", quoted.text.includes("z".repeat(295) + "...") && !quoted.text.includes("z".repeat(301)) && !quoted.text.includes("w".repeat(301)), quoted.text.length);
const keyed = buildDigest({ suites: [{ name: "18-k", out: green(1), err: "[driver] WARNING: same thing\nWARNING: same thing" }] });
check("a warning with and without the [driver] tag is one warning", keyed.text.includes("  x2 in 1 suite(s): WARNING: same thing"), keyed.text);

const two = buildDigest({ suites: [{ name: "19-a", out: failing }, { name: "20-b", out: failing }, { name: "21-c", out: green(4) }] });
eq("two failed suites and a green one add up", two.text.split("\n")[0], "FAILED - 6/10 checks passed across 3 suite(s), 2 suite(s) failed");
eq("each failed suite has its own section", two.text.split("\n").filter((l) => l.startsWith("== suite")).length, 2);

const hung = buildDigest({
  suites: [{ name: "22-hang", out: "FAIL early\nlast a\nlast b", err: "[driver] err 1\n[driver] err 2", verdict: { name: "22-hang", failed: true, timedOut: true, checks: 1, failedChecks: 1 } }],
  timeoutSec: 12
});
check("a timed-out suite says so and shows the log tails even with a FAIL line", hung.text.includes("== suite 22 22-hang: TIMED OUT after 12s") && hung.text.includes("  . last b") && hung.text.includes("  e [driver] err 2"), hung.text);
const hungSilent = buildDigest({ suites: [{ name: "23-q", out: "one\ntwo", err: "[driver] boom" }] });
check("a suite with no RESULT shows both tails", hungSilent.text.includes("  . two") && hungSilent.text.includes("  e [driver] boom"), hungSilent.text);
const verdictRules = buildDigest({ suites: [{ name: "24-v", out: "RESULT: 3/3 checks passed", verdict: { failed: true, timedOut: false, checks: 3, failedChecks: 0 } }] });
eq("the runner's verdict overrides the digest's own reading", verdictRules.text.split("\n")[0], "FAILED - 3/3 checks passed across 1 suite(s), 1 suite(s) failed");
const verdictPass = buildDigest({ suites: [{ name: "25-v", out: "RESULT: garbage", verdict: { failed: false, timedOut: false, checks: 2, failedChecks: 0 } }] });
eq("and so does a passing verdict", verdictPass.text.split("\n")[0], "ALL PASS - 2/2 checks across 1 suite(s)");

const lineCount = (text, line) => text.split("\n").filter((l) => l.endsWith(line)).length;
eq("a timed-out suite's FAIL line appears once, not again in the log tail", lineCount(hung.text, "FAIL early"), 1);
eq("the rest of the tail is kept after the FAIL line is dropped from it", [hung.text.includes("  . last a"), hung.text.includes("  . last b")], [true, true]);
const hungCtx = buildDigest({ suites: [{ name: "26-ctx", out: "pre a\npre b\nFAIL mid\n     expected: 1\ntail a\ntail b", verdict: { name: "26-ctx", failed: true, timedOut: true, checks: 1, failedChecks: 1 } }], timeoutSec: 5 });
eq("a context line or a continuation line shown above is not repeated in the tail", [lineCount(hungCtx.text, "pre a"), lineCount(hungCtx.text, "pre b"), lineCount(hungCtx.text, "FAIL mid"), lineCount(hungCtx.text, "expected: 1")], [1, 1, 1, 1]);
const noRes = buildDigest({ suites: [{ name: "27-nr", out: "FAIL only\nthen nothing" }] });
eq("a suite with no RESULT line shows its FAIL line once too", lineCount(noRes.text, "FAIL only"), 1);
const sameText = buildDigest({ suites: [{ name: "28-dup", out: "FAIL x\nFAIL x\nFAIL x\nend", verdict: { name: "28-dup", failed: true, timedOut: true, checks: 1, failedChecks: 1 } }], timeoutSec: 5 });
eq("identical FAIL lines are each shown once", lineCount(sameText.text, "FAIL x"), 3);

const good = { name: "01-core", failed: false, timedOut: false, checks: 2, failedChecks: 0 };
const bad = (patch, drop) => {
  const entry = { ...good, ...patch };
  for (const key of drop ?? []) delete entry[key];
  return { timeoutSec: 9, suites: [good, entry] };
};
const problem = (verdicts) => {
  try { validateVerdicts(verdicts); return null; } catch (e) { return String(e.message); }
};
eq("a complete verdicts object is accepted", problem({ timeoutSec: 9, suites: [good] }), null);
eq("an empty suite list is accepted", problem({ timeoutSec: 9, suites: [] }), null);
for (const field of ["name", "failed", "timedOut", "checks", "failedChecks"]) {
  const message = problem(bad({}, [field]));
  check(`an entry with no ${field} field is refused, naming the entry and the field`, message !== null && message.includes("suites[1]") && message.includes(`"${field}"`), message);
}
check("the refusal names the suite by its name when it has one", problem(bad({ name: "05-x" }, ["failed"])).includes("05-x"), problem(bad({ name: "05-x" }, ["failed"])));
for (const [what, patch] of [
  ["a string failed flag", { failed: "false" }],
  ["a null failed flag", { failed: null }],
  ["a numeric timedOut flag", { timedOut: 0 }],
  ["a string check count", { checks: "2" }],
  ["a fractional check count", { checks: 1.5 }],
  ["a negative check count", { checks: -1 }],
  ["a null failed-check count", { failedChecks: null }],
  ["more failed checks than checks", { checks: 2, failedChecks: 3 }],
  ["a passing suite that has failed checks", { failed: false, failedChecks: 1 }],
  ["a timed-out suite that is not marked failed", { failed: false, timedOut: true, checks: 1, failedChecks: 0 }],
  ["an empty name", { name: "" }],
  ["a numeric name", { name: 7 }]
]) {
  eq(`${what} is refused`, problem(bad(patch)) !== null, true);
}
eq("a failed suite with no failed checks is still accepted", problem({ timeoutSec: 9, suites: [{ ...good, failed: true }] }), null);
eq("a timed-out failed suite is accepted", problem({ timeoutSec: 9, suites: [{ ...good, failed: true, timedOut: true, checks: 1, failedChecks: 1 }] }), null);
const namesProblem = (verdicts, names) => {
  try { validateVerdicts(verdicts, names); return null; } catch (e) { return String(e.message); }
};
const second = { ...good, name: "02-prod" };
eq("verdicts that cover every named suite exactly once are accepted", namesProblem({ timeoutSec: 9, suites: [good, second] }, ["01-core", "02-prod"]), null);
const duplicated = namesProblem({ timeoutSec: 9, suites: [{ ...second, failed: true, failedChecks: 1 }, second] }, ["02-prod"]);
check("a duplicate suite name is refused and named", duplicated !== null && duplicated.includes("02-prod") && duplicated.includes("more than once"), duplicated);
const unknown = namesProblem({ timeoutSec: 9, suites: [good, { ...second, name: "03-ghost", failed: true, timedOut: true, checks: 1, failedChecks: 1 }] }, ["01-core"]);
check("a verdict for a suite that is not in the suite list is refused and named", unknown !== null && unknown.includes("03-ghost") && unknown.includes("not in the suite list"), unknown);
const missing = namesProblem({ timeoutSec: 9, suites: [good] }, ["01-core", "02-prod"]);
check("a named suite with no verdict is refused and named", missing !== null && missing.includes("02-prod") && missing.includes("no verdict"), missing);
eq("names are not cross-checked when no suite list is given", namesProblem({ timeoutSec: 9, suites: [good, second] }), null);
eq("every bad entry is reported, not only the first", (problem({ timeoutSec: 9, suites: [{ name: "a" }, { name: "b" }] }).match(/suites\[\d\]/g) ?? []).length >= 2, true);
for (const [what, value] of [
  ["a null file", null],
  ["an array", []],
  ["a string", "x"],
  ["an object with no suites", { timeoutSec: 9 }],
  ["suites that is not a list", { timeoutSec: 9, suites: {} }],
  ["an entry that is not an object", { timeoutSec: 9, suites: [null] }],
  ["an entry that is a number", { timeoutSec: 9, suites: [3] }],
  ["no timeoutSec", { suites: [good] }],
  ["a string timeoutSec", { timeoutSec: "9", suites: [good] }],
  ["a negative timeoutSec", { timeoutSec: -1, suites: [good] }]
]) {
  eq(`${what} is refused`, problem(value) !== null, true);
}

const work = mkdtempSync(join(tmpdir(), "splitpage-digest-"));
try {
  writeFileSync(join(work, "01-core.out.txt"), green(2));
  writeFileSync(join(work, "01-core.err.txt"), "[driver] static server attempt 1 of 3 failed: x");
  writeFileSync(join(work, "02-bad.out.txt"), failing);
  const fromDir = digestFromLogDir(work, ["01-core", "02-bad", "03-missing"]);
  check("reading a log folder finds failures, retries and a missing log", fromDir.failedSuites === 2 && fromDir.text.includes("retries (1):") && fromDir.text.includes("no log was written"), fromDir.text);
  check("the pointer path is the suite's own .out.txt", digestFromLogDir(work, ["02-bad"], { limit: 3 }).text.includes(join(work, "02-bad.out.txt")), "");

  const cli = fileURLToPath(new URL("./failure-digest.mjs", import.meta.url));
  const outFile = join(work, "digest.txt");
  const run = spawnSync(process.execPath, [cli, "--logs", work, "--out", outFile, "--suites", "01-core,02-bad"], { encoding: "utf8" });
  eq("the command line writes digest.txt and exits 0", [run.status, readFileSync(outFile, "utf8").split("\n")[0]], [0, "FAILED - 3/5 checks passed across 2 suite(s), 1 suite(s) failed"]);
  const trailing = spawnSync(process.execPath, [cli, "--logs", work, "--out", outFile, "--suites", "01-core,"], { encoding: "utf8" });
  eq("an empty name in the suite list is ignored", [trailing.status, readFileSync(outFile, "utf8").split("\n")[0]], [0, "ALL PASS - 2/2 checks across 1 suite(s)"]);
  const verdictFile = join(work, "verdicts.json");
  writeFileSync(verdictFile, JSON.stringify({ timeoutSec: 9, suites: [{ name: "01-core", failed: true, timedOut: true, checks: 1, failedChecks: 1 }] }));
  spawnSync(process.execPath, [cli, "--logs", work, "--out", outFile, "--suites", "01-core", "--verdicts", verdictFile], { encoding: "utf8" });
  check("the command line reads the runner's verdicts", readFileSync(outFile, "utf8").includes("TIMED OUT after 9s"), readFileSync(outFile, "utf8"));
  eq("the command line without options exits 2", spawnSync(process.execPath, [cli], { encoding: "utf8" }).status, 2);

  const refuse = (name, content) => {
    const file = join(work, name);
    if (content !== undefined) writeFileSync(file, content);
    const target = join(work, "refused-" + name + ".txt");
    const result = spawnSync(process.execPath, [cli, "--logs", work, "--out", target, "--suites", "01-core,02-bad", "--verdicts", file], { encoding: "utf8" });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, written: existsSync(target) };
  };
  const noFailed = refuse("no-failed.json", JSON.stringify({ timeoutSec: 9, suites: [{ name: "01-core", timedOut: false, checks: 2, failedChecks: 0 }, { name: "02-bad", failed: true, timedOut: false, checks: 3, failedChecks: 2 }] }));
  eq("a verdicts entry with no failed field exits 1 and writes no digest", [noFailed.status, noFailed.written], [1, false]);
  check("and the error names the entry and the field on stderr", noFailed.stderr.includes("01-core") && noFailed.stderr.includes('"failed"') && !noFailed.stderr.includes("    at "), noFailed.stderr);
  const noChecks = refuse("no-checks.json", JSON.stringify({ timeoutSec: 9, suites: [{ name: "01-core", failed: false, timedOut: false, failedChecks: 0 }] }));
  eq("a verdicts entry with no checks field exits 1 and writes no digest", [noChecks.status, noChecks.written], [1, false]);
  const broken = refuse("broken.json", "{ not json");
  eq("a verdicts file that is not JSON exits 1 with a plain message", [broken.status, broken.written, broken.stderr.includes("verdicts") && !broken.stderr.includes("    at ")], [1, false, true]);
  const absent = refuse("absent.json");
  eq("a verdicts file that does not exist exits 1", [absent.status, absent.written], [1, false]);
  const entry = (name, patch) => ({ name, failed: false, timedOut: false, checks: 2, failedChecks: 0, ...patch });
  const dup = refuse("dup.json", JSON.stringify({ timeoutSec: 9, suites: [entry("01-core"), entry("02-bad", { failed: true, failedChecks: 2, checks: 3 }), entry("02-bad")] }));
  eq("a duplicated suite name in the verdicts exits 1 and writes no digest", [dup.status, dup.written, dup.stderr.includes("02-bad")], [1, false, true]);
  const ghost = refuse("ghost.json", JSON.stringify({ timeoutSec: 9, suites: [entry("01-core"), entry("02-bad", { failed: true, failedChecks: 2, checks: 3 }), entry("03-ghost", { failed: true, timedOut: true, checks: 1, failedChecks: 1 })] }));
  eq("a verdict for a suite not on the command line exits 1 and writes no digest", [ghost.status, ghost.written, ghost.stderr.includes("03-ghost")], [1, false, true]);
  const lonely = refuse("lonely.json", JSON.stringify({ timeoutSec: 9, suites: [entry("01-core")] }));
  eq("a suite on the command line with no verdict exits 1 and writes no digest", [lonely.status, lonely.written, lonely.stderr.includes("02-bad")], [1, false, true]);
  const contradictory = refuse("contradictory.json", JSON.stringify({ timeoutSec: 9, suites: [entry("01-core", { failedChecks: 1 }), entry("02-bad", { failed: true, failedChecks: 2, checks: 3 })] }));
  eq("a passing verdict with failed checks exits 1 and writes no digest", [contradictory.status, contradictory.written], [1, false]);
  const okVerdicts = refuse("ok.json", JSON.stringify({ timeoutSec: 9, suites: [{ name: "01-core", failed: false, timedOut: false, checks: 2, failedChecks: 0 }, { name: "02-bad", failed: true, timedOut: false, checks: 3, failedChecks: 2 }] }));
  eq("a complete verdicts file still writes the digest", [okVerdicts.status, okVerdicts.written], [0, true]);
  check("digestFromLogDir refuses an incomplete verdicts object too", (() => { try { digestFromLogDir(work, ["01-core"], { verdicts: { timeoutSec: 9, suites: [{ name: "01-core" }] } }); return false; } catch { return true; } })(), "");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
