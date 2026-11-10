import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { lifetimeDataHash, readLifetimeTimedArchive, validateLifetimeCharacterSource } from "../../src/perf/lifetime/audit.ts";
import { readLifetimeCounts } from "../../src/perf/lifetime/record.ts";
import { readLifetimeSensitivity } from "../../src/perf/lifetime/sensitivity.ts";
import { legacyReviewerStatusEvents, observeStatusOrder, statusOrderEvidence, statusOrderHistory } from "../../src/perf/lifetime/status-order.ts";
import { LifetimeHistory } from "../../src/perf/lifetime/workload.ts";
import { legacyStatusValue } from "../marks/status-readers.ts";
import { statusTimingChanges, validateStatusTimingChanges } from "../../src/marks/status-source-audit.ts";

for (const recreate of [false, true]) for (const clients of [[1, 2], [2, 1]] as const) {
  test(`T21 scalar literal delivery-order disagreement, authors ${clients.join("/")}, recreation ${recreate}`, () => {
    const value = observeStatusOrder(["a", "c", "b", "d"], recreate, clients, legacyStatusValue, [], legacyReviewerStatusEvents);
    assert.deepEqual(value.observations.map(row => row.status), clients[0] === 1 ? ["ready", "shot", "shot"] : ["ready", "shot", "ready"]);
    assert.deepEqual(value.observations.slice(0, 2).map(row => row.keys), [["a", "c", "b", "d"], ["b", "d", "a", "c"]]);
    assert.equal(value.identicalEncodedState, true); assert.equal(value.agrees, false);
  });
}

test("all 96 scalar delivery observations and the minimized failing history reproduce without repairing the legacy reader", () => {
  const value = statusOrderEvidence(legacyStatusValue, legacyReviewerStatusEvents); assert.equal(value.total, 96); assert.equal(value.disagreements, 80);
  assert.equal(value.rows.filter(row => row.recreate && !row.agrees).length, 40);
  assert.equal(value.rows.filter(row => !row.recreate && !row.agrees).length, 40);
  assert.deepEqual(JSON.parse(readFileSync(new URL("../../src/perf/lifetime/status-order.json", import.meta.url), "utf8")) as unknown, value);
  assert.ok(readFileSync(new URL("../../histories/T21-scalar-map-order.md", import.meta.url), "utf8").startsWith(statusOrderHistory(value)));
});

test("sensitivity intervention overrides change actual correction, revision, removal and status record counts", () => {
  const history = new LifetimeHistory(2, { title: "Sensitivity", rows: Array.from({ length: 30 }, (_, index) => ({ id: `R${index}`, audioText: "abcd", visualText: "", status: "todo" })),
    comments: [], people: [], productionTags: [], brollShots: [] }, false, { correctionsPer55: 2, revisionBeats: 10, statusesPerBeat: 4, removals: 4 });
  try {
    history.appendBlock();
    assert.deepEqual([history.operations.correctionDeletes, history.operations.correctionRetypes, history.operations.revisionDeletes, history.operations.revisionTyping,
      history.operations.removals, history.operations.restores, history.operations.statuses], [4, 4, 10, 20, 4, 1, 120]);
    assert.equal(history.master.doc.getMap("statusEvents").size, 120);
  } finally { history.destroy(); }
});

test("committed sensitivity results retain literal parameter changes and the reviewer crossing blocks", () => {
  const value = readLifetimeSensitivity();
  assert.deepEqual(value.rows.map(row => row.firstCap.block), [36, 31, 34, 26, 36]);
  assert.deepEqual(value.rows.map(row => row.parameters), [
    { correctionsPer55: 1, revisionBeats: 5, statusesPerBeat: 2, removals: 2 },
    { correctionsPer55: 1, revisionBeats: 5, statusesPerBeat: 4, removals: 2 },
    { correctionsPer55: 2, revisionBeats: 5, statusesPerBeat: 2, removals: 2 },
    { correctionsPer55: 1, revisionBeats: 5, statusesPerBeat: 2, removals: 4 },
    { correctionsPer55: 1, revisionBeats: 10, statusesPerBeat: 2, removals: 2 }
  ]);
});

test("post-status source audit pins declared changed work and rejects unlisted character changes", () => {
  const archive = readLifetimeTimedArchive(), current = Object.fromEntries(Object.keys(archive.files).map(file => [file,
    readFileSync(new URL(`../../src/perf/lifetime/${file}`, import.meta.url), "utf8")]));
  validateLifetimeCharacterSource(archive.files, current);
  for (const file of ["projector.ts", "probe.ts", "record.ts"]) {
    const changed = { ...current };
    const value = changed[file]; assert.ok(value);
    changed[file] = file === "projector.ts" ? value.replace("const cached = this.values.get(id);", 'const cached = this.values.get("wrong");') : value + "\n";
    assert.throws(() => validateLifetimeCharacterSource(archive.files, changed));
  }
  assert.equal(statusTimingChanges().counts.before, archive.defaultDataSha256);
  assert.equal(lifetimeDataHash(readLifetimeCounts().data), statusTimingChanges().validationCounts?.after ?? statusTimingChanges().reviewCounts?.after ?? statusTimingChanges().counts.after);
  assert.equal(createHash("sha256").update(readFileSync(new URL("../../src/perf/lifetime/timings.json", import.meta.url))).digest("hex"), archive.timingsSha256);
});

test("status timing audit rejects changed hashes, missing declarations and duplicate declarations", () => {
  validateStatusTimingChanges();
  for (const defect of ["hash", "missing", "duplicate"] as const) {
    const changed = structuredClone(statusTimingChanges());
    const file = changed.files[0]; assert.ok(file);
    if (defect === "hash") file.after = "0".repeat(64);
    if (defect === "missing") changed.files.pop();
    if (defect === "duplicate") changed.files.push(file);
    assert.throws(() => validateStatusTimingChanges(changed));
  }
});

test("status review audit rejects broken before/after chains and duplicate declarations", () => {
  for (const defect of ["before", "after", "duplicate", "dependencies", "counts"] as const) {
    const changed = structuredClone(statusTimingChanges()), file = changed.reviewChanges?.[0]; assert.ok(file);
    if (defect === "before") file.before = "0".repeat(64);
    if (defect === "after") file.after = "0".repeat(64);
    if (defect === "duplicate") changed.reviewChanges?.push(file);
    if (defect === "dependencies") { assert.ok(changed.reviewDependencies); changed.reviewDependencies.before = "0".repeat(64); }
    if (defect === "counts") { assert.ok(changed.reviewCounts); changed.reviewCounts.before = "0".repeat(64); }
    assert.throws(() => validateStatusTimingChanges(changed));
  }
});

test("status validation audit rejects broken source, dependency and count chains", () => {
  for (const defect of ["before", "after", "duplicate", "extra", "dependencies", "counts"] as const) {
    const changed = structuredClone(statusTimingChanges()), file = changed.validationChanges?.[0]; assert.ok(file);
    if (defect === "before") file.before = "0".repeat(64);
    if (defect === "after") file.after = "0".repeat(64);
    if (defect === "duplicate") changed.validationChanges?.push(file);
    if (defect === "extra") changed.validationChanges?.push({ ...file, path: "src/schema.ts" });
    if (defect === "dependencies") { assert.ok(changed.validationDependencies); changed.validationDependencies.before = "0".repeat(64); }
    if (defect === "counts") { assert.ok(changed.validationCounts); changed.validationCounts.before = "0".repeat(64); }
    assert.throws(() => validateStatusTimingChanges(changed));
  }
});
