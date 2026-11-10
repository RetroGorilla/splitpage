import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateCurrentPerfReport, readStructuralEvidence, validateStructuralEvidence } from "../../src/perf/report.ts";
import { validatePerfSetup, validateTimedSource } from "../../src/perf/setup.ts";
import type { PerfTimedSourceAudit, plannedPerfSetup } from "../../src/perf/setup.ts";
import { hasPrivatePerfMetadata, redactPerfText } from "../../src/perf/privacy.ts";
import { measuredMetadataSnapshot, privacyText } from "./privacy-check.ts";

const evidence = readStructuralEvidence();
const setup = JSON.parse(readFileSync(new URL("../../src/perf/setup.json", import.meta.url), "utf8")) as ReturnType<typeof plannedPerfSetup>;

test("prepared recorder pins source, runtime, five alternating runs, samples and machine guards without timing anything", () => {
  validatePerfSetup(setup);
  validateStructuralEvidence(evidence);
});

test("generated report agrees with deterministic counts and only includes complete valid timing sets", () => {
  const report = generateCurrentPerfReport();
  assert.equal(readFileSync(new URL("../../perf-results.md", import.meta.url), "utf8"), report);
  if (!existsSync(new URL("../../src/perf/results.json", import.meta.url))) {
    assert.match(report, /No valid timing measurement set has been run/);
    assert.doesNotMatch(report, /A p50|B p50|measured ms/);
  }
});

for (const defect of ["RAM", "CPU", "sample count", "rounds", "runtime", "case", "source hash"] as const) {
  test(`method checker rejects changed ${defect}`, () => {
    const mutated = structuredClone(setup);
    if (defect === "RAM") mutated.minFreeMemoryBytes = 2 * 1024 ** 3;
    if (defect === "CPU") mutated.maxCpuBusyPercent = 90;
    if (defect === "sample count") mutated.samplesPerCase = 1;
    if (defect === "rounds") mutated.rounds = 1;
    if (defect === "runtime") mutated.node = "v22.22.0";
    if (defect === "case") mutated.cases.pop();
    if (defect === "source hash") mutated.sourceDigest = "0".repeat(64);
    assert.throws(() => validatePerfSetup(mutated));
  });
}

test("structural checker rejects stale sources, missing checkpoints and wrong literal scan control", () => {
  for (const defect of ["source", "checkpoint", "scan"]) {
    const mutated = structuredClone(evidence);
    if (defect === "source") mutated.sourceDigest = "0".repeat(64);
    if (defect === "checkpoint") mutated.data.rows.find(row => row.fixture === "large")?.checkpoints.pop();
    if (defect === "scan") {
      const control = mutated.data.controls[0];
      assert.ok(control);
      control.capture.relativeItems--;
    }
    assert.throws(() => validateStructuralEvidence(mutated));
  }
});

for (const file of ["void-preflight.json", "void-interrupted.json"]) test(`${file} is explicitly excluded from performance conclusions`, () => {
  const value = JSON.parse(readFileSync(new URL(`../../src/perf/${file}`, import.meta.url), "utf8")) as { status: string; reason: string; usableForComparisons: boolean };
  assert.equal(value.status, "void");
  assert.equal(value.usableForComparisons, false);
  assert.match(value.reason, /game/);
});

test("ownership invalidation mutation fails four literal controls and restoration passes all four", () => {
  const result = JSON.parse(readFileSync(new URL("ownership-mutation.json", import.meta.url), "utf8")) as { mutant: { tests: number; pass: number; fail: number }; restored: { tests: number; pass: number; fail: number } };
  assert.deepEqual(result.mutant, { tests: 4, pass: 0, fail: 4 });
  assert.deepEqual(result.restored, { tests: 4, pass: 4, fail: 0 });
});

test("timed audit retains original implementation hashes and refuses an unlisted implementation change", () => {
  const audit = JSON.parse(readFileSync(new URL("../../src/perf/timed-source.json", import.meta.url), "utf8")) as PerfTimedSourceAudit;
  validateTimedSource(audit.sourceHead, audit.sourceDigest, audit);
  const wrong = structuredClone(audit);
  wrong.files["incremental.ts"] = "0".repeat(64);
  assert.throws(() => validateTimedSource(audit.sourceHead, audit.sourceDigest, wrong));
});

test("timed audit rejects missing, duplicate, stale and wrongly attributed post-timing declarations", () => {
  const audit = JSON.parse(readFileSync(new URL("../../src/perf/timed-source.json", import.meta.url), "utf8")) as PerfTimedSourceAudit;
  assert.equal(audit.postTimingChanges?.length, 5);
  for (const defect of ["missing", "duplicate", "current hash", "timed hash", "unlisted", "PR", "reason"] as const) {
    const wrong = structuredClone(audit);
    const changes = wrong.postTimingChanges;
    const changed = changes?.find(change => change.path === "../proj/richtext.ts");
    assert.ok(changes && changed);
    if (defect === "missing") wrong.postTimingChanges = changes.filter(change => change !== changed);
    if (defect === "duplicate") changes.push({ ...changed });
    if (defect === "current hash") changed.currentSha256 = "0".repeat(64);
    if (defect === "timed hash") changed.timedSha256 = "0".repeat(64);
    if (defect === "unlisted") changes.push({ ...changed, path: "not-a-timed-file.ts", timedSha256: null });
    if (defect === "PR") changed.pullRequest = "";
    if (defect === "reason") changed.change = "";
    assert.throws(() => validateTimedSource(audit.sourceHead, audit.sourceDigest, wrong), defect);
  }
});

test("every tracked prototype text file omits private machine/user tokens and drive-letter absolute paths", () => {
  const root = new URL("../../../../", import.meta.url);
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "prototypes/collab/"], { cwd: fileURLToPath(root), encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(tracked.length > 0);
  const leaking = tracked.filter(file => {
    if (file.split("/").includes("node_modules") || /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(file)) return false;
    const bytes = readFileSync(new URL(file, root));
    return !bytes.includes(0) && hasPrivatePerfMetadata(privacyText(file, bytes.toString("utf8")));
  });
  assert.deepEqual(leaking, [], "Private identifying metadata in tracked prototype files");
});

test("privacy scanning decodes JSON escapes without mistaking escaped mark-key quotes for paths", () => {
  const drive = ["Q", ":", "/"].join("");
  assert.equal(hasPrivatePerfMetadata(privacyText("evidence.json", JSON.stringify({ path: `${drive}checkout/file.ts` }))), true);
  assert.equal(hasPrivatePerfMetadata(privacyText("mutation.json", JSON.stringify({ before: 'key.startsWith("c:")' }))), false);
});

test("the synthetic projection fixture exemption rejects another drive path and whole-value prefix/suffix variants", () => {
  const file = "prototypes/collab/test/proj/supplement.splitpage";
  const text = readFileSync(new URL("../../../../" + file, import.meta.url), "utf8");
  const fixture = JSON.parse(text) as { rows: { imageLinks: { location: { path: string } }[] }[] };
  const location = fixture.rows[0]?.imageLinks[0]?.location;
  assert.ok(location);
  const original = location.path;
  assert.equal(hasPrivatePerfMetadata(privacyText(file, text)), false);
  for (const changed of [["Q", ":", "/private/take.mp4"].join(""), `${original}/private`, `private/${original}`]) {
    location.path = changed;
    assert.equal(hasPrivatePerfMetadata(privacyText(file, JSON.stringify(fixture))), true);
  }
});

test("redaction preserves all 76 comparison rows, 4510 samples, numeric values, timestamps and counts", () => {
  const baseline = JSON.parse(readFileSync(new URL("redaction-preservation.json", import.meta.url), "utf8")) as ReturnType<typeof measuredMetadataSnapshot>;
  assert.equal(baseline.comparisonRowCount, 76);
  assert.equal(baseline.data.find(file => file.file.endsWith("/results.json"))?.sampleCount, 4510);
  let report = readFileSync(new URL("../../perf-results.md", import.meta.url), "utf8");
  for (const [current, previous] of [
    ["| delta.ts (shared) | 62 | 62 |", "| delta.ts (shared) | 57 | 57 |"],
    ["| blocks.ts (shared) | 74 | 74 |", "| blocks.ts (shared) | 111 | 111 |"],
    ["| incremental.ts (shared) | 115 | 115 |", "| incremental.ts (shared) | 119 | 119 |"],
    ["| operations.ts (shared) | 54 | 54 |", "| operations.ts (shared) | 73 | 73 |"],
    ["| Total physical lines, including blanks | 305 | 305 |", "| Total physical lines, including blanks | 360 | 360 |"],
    ["| Shared delta.ts | 62 | 62 |", "| Shared delta.ts | 57 | 57 |"],
    ["| Shared blocks.ts | 74 | 74 |", "| Shared blocks.ts | 111 | 111 |"],
    ["| Shared incremental.ts | 115 | 115 |", "| Shared incremental.ts | 119 | 119 |"],
    ["| Shared operations.ts | 54 | 54 |", "| Shared operations.ts | 73 | 73 |"]
  ]) {
    assert.ok(current && previous); assert.equal(report.split(current).length, 2);
    report = report.replace(current, previous);
  }
  assert.deepEqual(measuredMetadataSnapshot(baseline.data.map(file => file.file), report), baseline);
});

test("transcript redaction emits repository-relative paths and preserves source line/column metadata", () => {
  const drive = ["Q", ":", "/"].join("");
  const input = `file:///${drive}checkout/prototypes/collab/test/perf/input.ts:48:14`;
  assert.equal(hasPrivatePerfMetadata(input), true);
  assert.equal(redactPerfText(input), "prototypes/collab/test/perf/input.ts:48:14");
});
