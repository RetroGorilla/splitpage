import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { readLifetimeCounts, validateLifetimeCounts, validateLifetimeTimings, lifetimeTimingMethod, lifetimeTimingPoints } from "../../src/perf/lifetime/record.ts";
import type { LifetimeTimingEvidence } from "../../src/perf/lifetime/record.ts";
import { lifetimeGrowthSvg, lifetimeReport } from "../../src/perf/lifetime/report.ts";

test("literal timing contract pins unchanged guards, five rounds, seven states, warm-up and alternating sample counts", () => {
  const { rounds, warmup, samples, minFreeMemoryBytes, maxCpuBusyPercent, maxConsecutiveRefusals, retryDelayMs, locks } = lifetimeTimingMethod;
  assert.deepEqual({ rounds, warmup, samples, minFreeMemoryBytes, maxCpuBusyPercent, maxConsecutiveRefusals, retryDelayMs, locks },
    { rounds: 5, warmup: 3, samples: 11, minFreeMemoryBytes: 3221225472, maxCpuBusyPercent: 35, maxConsecutiveRefusals: 3, retryDelayMs: 30000, locks: ["perf", "smoke"] });
  assert.deepEqual(lifetimeTimingPoints(readLifetimeCounts()).map(point => point.name), [
    "realistic 2 writers / 1 blocks", "realistic 2 writers / 10 blocks", "realistic 2 writers / 36 blocks",
    "realistic 6 writers / 1 blocks", "realistic 6 writers / 10 blocks", "realistic 6 writers / 36 blocks", "synthetic / 50100 operations"
  ]);
});

test("lifetime evidence pins method, sources, wire totals, three history checkpoints and index scan reduction", () => {
  const counts = readLifetimeCounts(); validateLifetimeCounts(counts);
  const synthetic = counts.data.synthetic.checkpoints.at(-1); assert.ok(synthetic);
  assert.equal(synthetic.bytes.encodedBytes, 3356090);
  assert.equal(synthetic.bytes.categories["removal records"], 2585302);
  assert.equal(synthetic.legacy.work.structure.records.statusEvents, 700000);
  assert.equal(synthetic.indexed.work.structure.records.statusEvents ?? 0, 0);
  for (const defect of ["source", "method", "bytes", "scan", "instrumentation"] as const) {
    const changed = structuredClone(counts);
    const point = changed.data.synthetic.checkpoints[0]; assert.ok(point);
    if (defect === "source") changed.source.sha256 = "0".repeat(64);
    if (defect === "method") (changed.data.plan as { correctionEvery: number }).correctionEvery = 1;
    if (defect === "bytes") point.bytes.categories.other++;
    if (defect === "scan") point.indexed.work.structure.records.statusEvents = 1;
    if (defect === "instrumentation") { const item = changed.instrumentation[0]; assert.ok(item); item.sha256 = "0".repeat(64); }
    assert.throws(() => validateLifetimeCounts(changed), defect);
  }
});

function methodFixture(): LifetimeTimingEvidence {
  const counts = readLifetimeCounts();
  const phase = { applyExcludingIncremental: 100, incremental: 100, structure: 100, component: 300, capture: 100, resolve: 100, withIdentity: 500 };
  return { version: 1, source: counts.source, sourceHead: "f".repeat(40), method: lifetimeTimingMethod,
    machine: { cpu: "fixture CPU", platform: "win32", osRelease: "fixture", architecture: "x64", totalMemoryBytes: 32 * 1024 ** 3, node: "v24.22.1", yjs: "13.6.33" }, refused: [],
    runs: Array.from({ length: 5 }, (_, round) => ({ round, before: { at: "2000-01-01T00:00:00.000Z", freeMemoryBytes: 4 * 1024 ** 3, cpuBefore: 10, forbiddenProcesses: [] }, cpuAfter: 10, valid: true,
      points: lifetimeTimingPoints(counts).map(point => ({ name: point.name, sha256: point.sha256, modes: (round % 2 ? ["indexed", "legacy"] as const : ["legacy", "indexed"] as const).map(mode => ({ mode, target: "literal", p50: { ...phase }, p95: { ...phase }, samples: Array.from({ length: 11 }, () => ({ ...phase })) })) })) })) };
}

test("timing method checker accepts literal slow samples but rejects changed guards, sample shape, pairing and summaries", () => {
  validateLifetimeTimings(methodFixture());
  for (const defect of ["RAM", "CPU", "rounds", "samples", "pairing", "hash", "summary", "phase"] as const) {
    const changed = methodFixture(), run = changed.runs[0], point = run?.points[0], mode = point?.modes[0]; assert.ok(run && point && mode);
    if (defect === "RAM") run.before.freeMemoryBytes = 1;
    if (defect === "CPU") run.cpuAfter = 36;
    if (defect === "rounds") changed.runs.pop();
    if (defect === "samples") mode.samples.pop();
    if (defect === "pairing") point.modes.reverse();
    if (defect === "hash") point.sha256 = "0".repeat(64);
    if (defect === "summary") mode.p50.component = (mode.p50.component ?? 0) + 1;
    if (defect === "phase") { const sample = mode.samples[0]; assert.ok(sample); sample.component++; }
    assert.throws(() => validateLifetimeTimings(changed), defect);
  }
});

test("lifetime report and growth figure reproduce exactly and partial clocks stay out of timing tables", () => {
  const counts = readLifetimeCounts(), path = new URL("../../src/perf/lifetime/timings.json", import.meta.url);
  const timings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as LifetimeTimingEvidence : undefined;
  assert.equal(readFileSync(new URL("../../lifetime-results.md", import.meta.url), "utf8"), lifetimeReport(counts, timings));
  assert.equal(readFileSync(new URL("../../src/perf/lifetime/growth.svg", import.meta.url), "utf8"), lifetimeGrowthSvg(counts));
  const partial = methodFixture(); partial.runs.pop();
  const report = lifetimeReport(counts, partial);
  assert.match(report, /No complete accepted timing set exists/);
  assert.doesNotMatch(report, /Legacy ms p50/);
});
