import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { generateCurrentPerfReport, readStructuralEvidence, validateStructuralEvidence } from "../../src/perf/report.ts";
import { validatePerfSetup, validateTimedSource } from "../../src/perf/setup.ts";
import type { PerfTimedSourceAudit, plannedPerfSetup } from "../../src/perf/setup.ts";
import { hasPrivatePerfMetadata, redactPerfText } from "../../src/perf/privacy.ts";
import { measuredMetadataSnapshot } from "./privacy-check.ts";

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

test("post-run wording changes preserve the prepared timed implementation and a changed implementation hash is refused", () => {
  const audit = JSON.parse(readFileSync(new URL("../../src/perf/timed-source.json", import.meta.url), "utf8")) as PerfTimedSourceAudit;
  validateTimedSource(audit.sourceHead, audit.sourceDigest, audit);
  const wrong = structuredClone(audit);
  wrong.files["incremental.ts"] = "0".repeat(64);
  assert.throws(() => validateTimedSource(audit.sourceHead, audit.sourceDigest, wrong));
});

test("every added prototype file omits private machine/user tokens and drive-letter absolute paths", () => {
  const added = JSON.parse(readFileSync(new URL("added-files.json", import.meta.url), "utf8")) as string[];
  const root = new URL("../../../../", import.meta.url);
  assert.equal(added.length, 32);
  assert.equal(new Set(added).size, 32);
  for (const file of added) assert.equal(hasPrivatePerfMetadata(readFileSync(new URL(file, root), "utf8")), false, `Private identifying metadata in ${file}`);
});

test("redaction preserves all 76 comparison rows, 4510 samples, numeric values, timestamps and counts", () => {
  const baseline = JSON.parse(readFileSync(new URL("redaction-preservation.json", import.meta.url), "utf8")) as ReturnType<typeof measuredMetadataSnapshot>;
  assert.equal(baseline.comparisonRowCount, 76);
  assert.equal(baseline.data.find(file => file.file.endsWith("/results.json"))?.sampleCount, 4510);
  assert.deepEqual(measuredMetadataSnapshot(baseline.data.map(file => file.file)), baseline);
});

test("transcript redaction emits repository-relative paths and preserves source line/column metadata", () => {
  const drive = ["Q", ":", "/"].join("");
  const input = `file:///${drive}checkout/prototypes/collab/test/perf/input.ts:48:14`;
  assert.equal(hasPrivatePerfMetadata(input), true);
  assert.equal(redactPerfText(input), "prototypes/collab/test/perf/input.ts:48:14");
});
