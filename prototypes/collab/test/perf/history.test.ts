import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { createProjectionReplica, fromDocument } from "../../src/proj/document.ts";
import { largeProjectionFixture } from "../../src/proj/costs.ts";
import { projectionReferences } from "../../src/proj/reference.ts";
import { applyWritingCycle, retainedCounts } from "../../src/perf/history.ts";
import { scalePerfFixture } from "../../src/perf/fixtures.ts";

test("large fixture uses the existing SCALE generator, including shared registries and retargeted ids", () => {
  const input = projectionReferences().find(input => input.name === "src/starters/long-demo.json");
  assert.ok(input);
  assert.deepEqual(scalePerfFixture(input.document, 10), largeProjectionFixture(input.document));
});

for (const candidate of ["A", "B"] as const) test(`${candidate}: writing history keeps observed removals and retired joins with default GC, including reload`, () => {
  const source = { title: "History", rows: [{ id: "R1", audioText: "A sentence that can be revised and written again.", visualText: "", status: "todo" }],
    comments: [{ id: "C1", rowId: "R1", field: "audioText", body: "note", replies: [] }], people: [], productionTags: [], brollShots: [] };
  const replica = fromDocument(source, candidate);
  const late = createProjectionReplica(candidate, 3);
  try {
    let operations = 0;
    for (let cycle = 0; cycle < 10; cycle++) operations += applyWritingCycle(replica, cycle, "R1", "C1");
    assert.equal(operations, 1002);
    assert.equal(replica.doc.gc, true);
    const counts = retainedCounts(replica);
    assert.equal(counts.beats, 11);
    assert.equal(counts.removedBeats, 2);
    assert.equal(counts.removalRecords, 12);
    assert.equal(counts.joinEntries, 10);
    assert.equal(counts.retiredJoins, 10);
    assert.equal(counts.statusEvents, 20);
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(replica.doc));
    assert.deepEqual(retainedCounts(late), counts);
  } finally { replica.destroy(); late.destroy(); }
});
