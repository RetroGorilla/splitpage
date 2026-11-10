import { test } from "node:test";
import { ReplicaHarness } from "../../src/delivery.ts";
import { checkModel } from "../../src/model.ts";
import type { ScriptOracle } from "../../src/model.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { storedMarkNames } from "../../src/marks/projection.ts";
import assert from "node:assert/strict";
import * as Y from "yjs";

for (const candidate of ["A", "B"] as const) {
  test(`${candidate}: a same-character link tie inside a tag uses the smallest link id`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abc" }]);
    try {
      harness.alice.doc.transact(() => harness.alice.doc.getMap("tags").set("P", {}), "fixture");
      harness.queue.flush("D2");
      harness.alice.format("R1", 0, 3, { "t:oA": "P" });
      harness.alice.format("R1", 0, 1, { "l:L2": "http://two" });
      harness.bob.format("R1", 0, 1, { "l:L1": "http://one" });
      harness.queue.flush("dup");
      harness.lateJoin(harness.bob);
      const oracle: ScriptOracle = { rows: [{ id: "R1", characters: [["s1", "a", { tag: "P", href: "http://one" }], ["s2", "b", { tag: "P", href: "http://one" }], ["s3", "c", { tag: "P", href: "http://one" }]] }], carets: {}, recovery: [] };
      for (const replica of harness.replicas) checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "tag link tie");
    } finally { harness.destroy(); }
  });
  test(`${candidate}: explicit typing attributes avoid inheriting observed comment and tag keys in stored text`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }]);
    try {
      harness.alice.format("R1", 0, 2, { "c:C1": true, "t:oA": "P" });
      harness.queue.flush("D2");
      harness.bob.insert("R1", 1, "X", ["b1"], {});
      harness.queue.flush("D1");
      harness.lateJoin(harness.bob);
      for (const replica of harness.replicas) {
        const raw = replica.characters().map(character => ({ ...character, notation: harness.identities.notation(character.identity) }));
        assert.deepEqual(storedMarkNames("c:C1", raw), ["s1", "s2"]);
        assert.deepEqual(storedMarkNames("t:oA", raw), ["s1", "s2"]);
      }
    } finally { harness.destroy(); }
  });
  test(`${candidate}: a detached comment preserves its stored visual field`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }]);
    try {
      harness.alice.doc.transact(() => {
        const comment = new Map<string, unknown>([["author", "Alice"], ["createdAt", 0], ["text", "gone"], ["rowId", "R1"], ["field", "visualText"]]);
        harness.alice.doc.getMap("comments").set("C1", new Y.Map(comment));
      }, "fixture");
      harness.queue.flush("D2");
      harness.lateJoin(harness.bob);
      const oracle: ScriptOracle = {
        rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }], carets: {}, recovery: [],
        records: { comments: { C1: { author: "Alice", createdAt: 0, text: "gone", rowId: "R1", field: "visualText", recovery: true, replies: [] } }, recoveryReplies: [] }
      };
      for (const replica of harness.replicas) checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "detached visual field");
    } finally { harness.destroy(); }
  });
  for (const swapped of [false, true]) test(`${candidate}: same-start nested occurrences project longest outermost${swapped ? " swapped ids" : ""}`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abc" }], swapped);
    try {
      harness.alice.doc.transact(() => { harness.alice.doc.getMap("tags").set("P", {}); harness.alice.doc.getMap("tags").set("S", {}); }, "fixture");
      harness.queue.flush("D2");
      harness.alice.format("R1", 0, 2, { "t:oA": "S" });
      harness.bob.format("R1", 0, 3, { "t:oB": "P" });
      harness.queue.flush("D1");
      harness.lateJoin(harness.bob);
      const oracle: ScriptOracle = { rows: [{ id: "R1", characters: [["s1", "a", { tag: "P", innerTags: ["S"] }], ["s2", "b", { tag: "P", innerTags: ["S"] }], ["s3", "c", { tag: "P" }]] }], carets: {}, recovery: [] };
      for (const replica of harness.replicas) checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "longest outermost");
    } finally {
      harness.destroy();
    }
  });
  test(`${candidate}: whole-tag link uses first character with a link rather than last or smallest id elsewhere`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abc" }]);
    try {
      harness.alice.doc.transact(() => harness.alice.doc.getMap("tags").set("P", {}), "fixture");
      harness.queue.flush("D2");
      harness.alice.format("R1", 0, 3, { "t:oA": "P" });
      harness.bob.format("R1", 0, 1, { "l:L2": "http://first" });
      harness.bob.format("R1", 2, 1, { "l:L1": "http://last" });
      harness.queue.flush("rev");
      harness.lateJoin(harness.bob);
      const oracle: ScriptOracle = { rows: [{ id: "R1", characters: [["s1", "a", { tag: "P", href: "http://first" }], ["s2", "b", { tag: "P", href: "http://first" }], ["s3", "c", { tag: "P", href: "http://first" }]] }], carets: {}, recovery: [] };
      for (const replica of harness.replicas) checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "first link");
    } finally {
      harness.destroy();
    }
  });
  test(`${candidate}: two link keys on one character choose the smallest link id`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }]);
    try {
      harness.alice.format("R1", 0, 1, { "l:L2": "http://two" });
      harness.bob.format("R1", 0, 1, { "l:L1": "http://one" });
      harness.queue.flush("dup");
      harness.lateJoin(harness.bob);
      const oracle: ScriptOracle = { rows: [{ id: "R1", characters: [["s1", "a", { href: "http://one" }], ["s2", "b", {}]] }], carets: {}, recovery: [] };
      for (const replica of harness.replicas) checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "smallest link id");
    } finally {
      harness.destroy();
    }
  });
}
