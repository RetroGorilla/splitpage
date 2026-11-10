import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { fromDocument, toDocument } from "../../src/proj/document.ts";
import { mapValue } from "../../src/schema.ts";
import { IncrementalProjection } from "../../src/perf/incremental.ts";
import { perfStructureView, splitPerfBeat, writePerfStatus } from "../../src/perf/operations.ts";
import { IndexedStructureProjection } from "../../src/perf/lifetime/projector.ts";
import { attributeLifetimeBytes } from "../../src/perf/lifetime/attribution.ts";
import { countLifetimeRemote } from "../../src/perf/lifetime/probe.ts";
import { LifetimeHistory } from "../../src/perf/lifetime/workload.ts";
import { reviewerStatusEvents } from "../../src/perf/lifetime/status-order.ts";

const source = () => ({ title: "Literal", rows: Array.from({ length: 30 }, (_, index) => ({ id: `R${index}`, audioText: "abcd", visualText: "", status: "todo" })),
  comments: Array.from({ length: 4 }, (_, index) => ({ id: `C${index}`, rowId: "R0", body: "note", replies: [] })),
  productionTags: Array.from({ length: 31 }, (_, index) => ({ id: `T${index}`, cat: "prop", name: `tag ${index}` })), people: [], brollShots: [] });

test("literal writing history pins correction, revision, structural, metadata and picture counts for two and six writers", () => {
  const documents = [];
  for (const writers of [2, 6]) {
    const history = new LifetimeHistory(writers, source());
    try {
      history.appendBlock();
      assert.deepEqual(history.operations, { typing: 120, correctionDeletes: 2, correctionRetypes: 2, revisionDeletes: 5, revisionTyping: 10, atoms: 0,
        splits: 5, joins: 5, joinRetirements: 5, moves: 5, removals: 2, restores: 1, statuses: 60, comments: 4, tags: 31, pictures: 10 });
      assert.equal(history.master.doc.getMap("removalRecords").size, 2);
      assert.equal(history.master.doc.getMap("retiredJoins").size, 5);
      assert.equal(history.master.doc.getMap("statusEvents").size, 60);
      assert.equal(history.master.doc.getArray("order").length, 35);
      documents.push(toDocument(history.master.doc, "B"));
    } finally { history.destroy(); }
  }
  assert.deepEqual(documents[0], documents[1]);
});

test("status index preserves literal conflict, retirement, overwrite, deletion and fallback results", () => {
  const replica = fromDocument({ title: "", rows: [{ id: "R1", audioText: "ab", visualText: "", status: "todo" }] }, "B");
  const projection = new IncrementalProjection(replica), indexed = new IndexedStructureProjection(replica);
  const event = (id: string, value: string, parents: string[], prior = "todo") => replica.doc.getMap("statusEvents").set(id, { by: "writer", target: "R1", value, parents, prior });
  const check = (expected: string): void => {
    assert.equal(indexed.view(projection.document).groups[0]?.status, expected);
    assert.deepEqual(indexed.view(projection.document), perfStructureView(replica, toDocument(replica.doc, "B")));
  };
  try {
    check("todo"); event("a", "ready", []); check("ready"); event("b", "shot", []); check("todo");
    event("b", "ready", []); check("ready"); replica.doc.getMap("retiredStatus").set("a", true); check("todo");
    replica.doc.getMap("statusEvents").delete("a"); check("ready"); event("c", "shot", ["b"], "ready"); check("shot");
    replica.doc.getMap("retiredStatus").set("c", true); check("ready");
  } finally { indexed.destroy(); projection.destroy(); replica.destroy(); }
});

test("literal two-branch status fallback remains todo after c is deleted and recreated", () => {
  const replica = fromDocument({ title: "", rows: [{ id: "R1", audioText: "abcd", visualText: "", status: "todo" }] }, "B");
  const projection = new IncrementalProjection(replica), indexed = new IndexedStructureProjection(replica);
  const check = (): void => {
    assert.equal(perfStructureView(replica, projection.document).groups[0]?.status, "todo");
    assert.equal(indexed.view(projection.document).groups[0]?.status, "todo");
  };
  try {
    for (const [id, event] of Object.entries(reviewerStatusEvents)) replica.doc.getMap("statusEvents").set(id, structuredClone(event));
    check();
    replica.doc.getMap("statusEvents").delete("c");
    replica.doc.getMap("statusEvents").set("c", structuredClone(reviewerStatusEvents.c));
    check();
  } finally { indexed.destroy(); projection.destroy(); replica.destroy(); }
});

for (const seed of [17, 1376, 50100]) test(`B indexed structure and incremental document agree with independent full reads after every seeded edit ${seed}`, () => {
  const replica = fromDocument({ title: "", rows: [{ id: "R1", audioText: "abcd", visualText: "", status: "todo" }, { id: "R2", audioText: "efgh", visualText: "", status: "todo" }] }, "B");
  const projection = new IncrementalProjection(replica), indexed = new IndexedStructureProjection(replica);
  let random = seed;
  let recreations = 0;
  try {
    for (let step = 0; step < 100; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const id = (random >>> 16) % 2 ? "R1" : "R2", location = replica.locate(id);
      switch (random % 8) {
        case 0: location.text.insert(location.end, "x", {}); break;
        case 1: if (location.end > location.start) location.text.delete(location.start, 1); break;
        case 2: writePerfStatus(replica, id, `status-${step}`, step % 2 ? "ready" : "shot"); break;
        case 3: replica.doc.getMap("retiredStatus").set(`status-${step - 1}`, true); break;
        case 4: replica.join("R2", "R1", `join-${step}`); break;
        case 5: replica.doc.getMap("retiredJoins").set(`join-${step - 1}`, true); break;
        case 6: mapValue(mapValue(replica.doc.getMap("beats").get(id)).get("removals")).set("removed", true); break;
        case 7: {
          const events = replica.doc.getMap("statusEvents"), keys = [...events.keys()], key = keys[(random >>> 8) % keys.length];
          if (!key) break;
          const event = structuredClone(events.get(key));
          events.delete(key);
          const deleted = toDocument(replica.doc, "B");
          assert.deepEqual(projection.document, deleted, `delete step ${step}`);
          assert.deepEqual(indexed.view(projection.document), perfStructureView(replica, deleted), `delete step ${step}`);
          events.set(key, event); recreations++; break;
        }
      }
      if (step % 11 === 0) mapValue(mapValue(replica.doc.getMap("beats").get(id)).get("removals")).delete("removed");
      const full = toDocument(replica.doc, "B");
      assert.deepEqual(projection.document, full, `step ${step}`);
      assert.deepEqual(indexed.view(projection.document), perfStructureView(replica, full), `step ${step}`);
    }
    assert.ok(recreations > 0);
  } finally { indexed.destroy(); projection.destroy(); replica.destroy(); }
});

test("wire attribution sums exactly and remote counters distinguish repeated status scans from indexed lookup", () => {
  const replica = fromDocument({ title: "", rows: [{ id: "R1", audioText: "abcd", visualText: "", status: "todo" }, { id: "R2", audioText: "efgh", visualText: "", status: "todo" }] }, "B");
  try {
    writePerfStatus(replica, "R1", "a", "ready"); writePerfStatus(replica, "R1", "b", "shot"); writePerfStatus(replica, "R2", "c", "ready");
    replica.locate("R1").text.delete(0, 1);
    const bytes = attributeLifetimeBytes(replica);
    assert.equal(Object.values(bytes.categories).reduce((sum, value) => sum + value, 0), Y.encodeStateAsUpdate(replica.doc).length);
    assert.ok(bytes.categories["live text items"] > 0); assert.ok(bytes.categories["deleted text tombstones"] > 0); assert.ok(bytes.categories["status events"] > 0);
    const state = Y.encodeStateAsUpdate(replica.doc), legacy = countLifetimeRemote(state, "legacy"), indexed = countLifetimeRemote(state, "indexed");
    assert.equal(legacy.work.structure.records.statusEvents, 6);
    assert.equal(indexed.work.structure.records.statusEvents ?? 0, 0);
    assert.equal(indexed.value.statusRecordsRead, 0);
    assert.equal(indexed.work.apply.integratedItems, 1);
    assert.equal(indexed.value.projectedBeats, 1);
  } finally { replica.destroy(); }
});

test("indexed projection observes status added after a split and per-writer join retirement", () => {
  const history = new LifetimeHistory(2, source());
  try {
    history.appendBlock();
    const projection = new IncrementalProjection(history.master), indexed = new IndexedStructureProjection(history.master);
    try {
      splitPerfBeat(history.master, "R0", 1, "later"); writePerfStatus(history.master, "later", "later-status", "shot");
      assert.deepEqual(indexed.view(projection.document), perfStructureView(history.master, toDocument(history.master.doc, "B")));
    } finally { indexed.destroy(); projection.destroy(); }
  } finally { history.destroy(); }
});
