import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { ReplicaHarness, deliveryOrders } from "../../src/delivery.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { addComment, addReply } from "../../src/marks/commands.ts";
import { IncrementalProjection } from "../../src/perf/incremental.ts";
import { fromDocument, createProjectionReplica, toDocument } from "../../src/proj/document.ts";
import { PerfBlockIndex } from "../../src/perf/blocks.ts";
import { projectionDifference } from "../strict-comparison.ts";
import { ReaderConvergence } from "../reader-convergence.ts";
import { structureManager } from "../../src/structure.ts";
import { changeStatus, undoStatus } from "../../src/marks/commands.ts";
import { identityEntries, wireIdentity } from "../../src/readers/identity.ts";
import { readCommentRecord, readReplyRecord, sameProjectionValue } from "../../src/readers/records.ts";

for (const candidate of ["A", "B"] as const) test(`${candidate}: comment command normalizes its key and anchor identity before writing`, () => {
  const h = new ReplicaHarness(candidate, [{ id: "R1", text: "a" }]), guard = new ReaderConvergence(h, deliveryOrders);
  try {
    addComment(h.alice, "\ud800", "R1", 0, 1, "Alice");
    addReply(h.alice, "\ud801", "\ud800", "Alice"); h.queue.flush("rev"); h.lateJoin(h.alice);
    for (const replica of h.replicas) {
      const comments = readStructure(replica.doc, candidate, h.identities).records?.comments as Record<string, { recovery: boolean; replies: { id: string }[] }>;
      assert.deepEqual(Object.keys(comments), ["\ufffd"]);
      assert.equal(comments["\ufffd"]?.recovery, false);
      assert.deepEqual(comments["\ufffd"]?.replies.map(reply => reply.id), ["\ufffd"]);
      assert.deepEqual([...replica.doc.getMap("comments").keys()], ["\ufffd"]);
    }
    guard.check("wire comment command");
  } finally { h.destroy(); }
});

for (const candidate of ["A", "B"] as const) test(`${candidate}: identity-writing commands store normalized keys and references`, () => {
  const source = fromDocument({ title: "", rows: [{ id: "\ud800", audioText: "ab", visualText: "v", status: "todo" }],
    people: [{ id: "\ud800", name: "Alice" }], productionTags: [{ id: "\ud800", name: "Tag" }], brollShots: [{ id: "\ud800", name: "Shot" }],
    comments: [{ id: "\ud800", rowId: "\ud800", replies: [{ id: "\ud801", body: "Reply" }] }] }, candidate, 200);
  const manager = structureManager(source);
  try {
    source.split("\ud800", 1, "split\ud800", "boundary", "Alice");
    source.join("split\ud800", "\ud800", "join\ud800"); source.remove("\ud800", "remove\ud800", "Alice"); source.restore("\ud800", "remove\ud800");
    changeStatus(source, manager, "\ud800", "status\ud800", "ready", "Alice"); undoStatus(source, manager);
    const visit = (map: Y.Map<unknown>): void => {
      for (const [key, value] of map) {
        assert.equal(key, wireIdentity(key));
        if (value instanceof Y.Map) visit(value);
      }
    };
    for (const name of ["comments", "replies", "people", "tags", "shots", "beats", "segments", "visuals", "gallery", "statusEvents", "retiredStatus", "removalRecords"]) visit(source.doc.getMap(name));
    assert.deepEqual(identityEntries(source.doc.getMap("statusEvents")).map(([id]) => id), ["status\ufffd"]);
  } finally { manager.destroy(); source.destroy(); }
});

test("strict reload findings: binary record fields are absent and cache equality preserves property presence", () => {
  assert.equal(readCommentRecord({ rowId: "R1", author: "Alice", resolution: new Uint8Array([1]) }), null);
  assert.equal(readReplyRecord({ commentId: "C1", author: new Uint8Array([1]) }), null);
  assert.equal(sameProjectionValue([], new Array(1)), false);
  assert.equal(sameProjectionValue({}, { absent: undefined }), false);
  assert.equal(sameProjectionValue([undefined], new Array(1)), false);
});

for (const candidate of ["A", "B"] as const) test(`${candidate}: patched section output preserves fresh own-key order and first scene`, () => {
  const source = fromDocument({ title: "", rows: [{ id: "R1", audioText: "ab", visualText: "" }, { id: "R2", audioText: "cd", visualText: "" }],
    sections: [{ name: "Scene", firstSceneId: "R1", id: "H1" }] }, candidate, 200), cache = new IncrementalProjection(source);
  try {
    source.insert("R2", 1, "x", ["x1"]);
    assert.deepEqual(cache.document.sections, [{ name: "Scene", firstSceneId: "R1", id: "H1" }]);
    assert.deepEqual(Object.keys((cache.document.sections as object[])[0] ?? {}), ["name", "firstSceneId", "id"]);
    assert.equal(projectionDifference(cache.document, toDocument(source.doc, candidate), "section cache"), null);
  } finally { cache.destroy(); source.destroy(); }
});

for (const candidate of ["A", "B"] as const) for (const order of deliveryOrders) test(`${candidate}/${order}: concurrent deletion and formatting have one literal fresh/observing delta`, () => {
  const source = fromDocument({ title: "", rows: [{ id: "R1", audioText: "abcd", visualText: "", status: "todo" }] }, candidate, 200);
  const other = createProjectionReplica(candidate, 201), late = createProjectionReplica(candidate, 202);
  Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(source.doc));
  const a = new IncrementalProjection(source), b = new IncrementalProjection(other), updates: Uint8Array[] = [];
  const capture = (update: Uint8Array, origin: unknown): void => { if (origin !== "delivery") updates.push(update); };
  source.doc.on("update", capture); other.doc.on("update", capture);
  try {
    const left = source.locate("R1"), right = other.locate("R1");
    left.text.delete(left.start + 1, 1); right.text.format(right.start + 1, 1, { bold: true });
    const delivered = order === "rev" ? [...updates].reverse() : updates;
    for (const replica of [source, other]) for (const update of delivered) {
      Y.applyUpdate(replica.doc, update, "delivery"); if (order === "dup") Y.applyUpdate(replica.doc, update, "delivery");
    }
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(source.doc));
    const expected = [{ insert: "acd", attributes: {} }];
    for (const replica of [source, other, late]) {
      const fresh = new PerfBlockIndex(replica.doc, candidate);
      assert.deepEqual(fresh.spans[0]?.block.delta, expected);
      assert.equal(projectionDifference(a.document, toDocument(replica.doc, candidate), "document"), null);
    }
    assert.deepEqual(a.index.spans[0]?.block.delta, expected); assert.deepEqual(b.index.spans[0]?.block.delta, expected);
  } finally { a.destroy(); b.destroy(); source.destroy(); other.destroy(); late.destroy(); }
});
