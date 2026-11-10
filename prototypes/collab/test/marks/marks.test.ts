import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Y from "yjs";
import { ReplicaHarness } from "../../src/delivery.ts";
import { addComment, addReply, changeStatus, editAuthoredRecord, ensureTag, statusValue, undoStatus } from "../../src/marks/commands.ts";
import { markReport } from "../../src/marks/report.ts";
import { markMutationDefinitions } from "../../src/marks/mutation-audit.ts";
import type { MarkMutationEvidence } from "../../src/marks/mutation-audit.ts";
import { checkModel } from "../../src/model.ts";
import type { ScriptOracle } from "../../src/model.ts";
import { mapValue } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { structureManager, undoOne } from "../../src/structure.ts";
import { markTraces, runMark } from "./runner.ts";
import { statusReaders } from "./status-readers.ts";

for (const [trace, orders] of Object.entries(markTraces)) {
  for (const candidate of ["A", "B"] as const) {
    for (const order of orders) test(`${candidate}: full ${trace} ${order}, including specified recovery and undo`, () => {
      const result = runMark(trace, candidate, order);
      assert.equal(result.failure, null, result.history.join("\n"));
      assert.ok(result.checks >= 4);
    });
  }
}

for (const candidate of ["A", "B"] as const) {
  test(`${candidate}: a later status command captures the actual prior value after identical undo`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }]);
    const { alice: a, bob: b, queue } = harness;
    const ua = structureManager(a);
    const ub = structureManager(b);
    try {
      a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R1")).set("status", "todo"), "fixture");
      queue.flush("D2");
      changeStatus(a, ua, "R1", "sA", "shot", "Alice");
      changeStatus(b, ub, "R1", "sB", "shot", "Bob");
      queue.flush("D1");
      undoStatus(a, ua);
      queue.flush("D1");
      changeStatus(b, ub, "R1", "sLater", "ready", "Bob");
      queue.flush("D2");
      undoStatus(b, ub);
      queue.flush("dup");
      harness.lateJoin(b);
      const oracle: ScriptOracle = { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "todo" }], carets: {}, recovery: [] };
      for (const replica of harness.replicas) checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "prior after retirement");
    } finally { ua.destroy(); ub.destroy(); harness.destroy(); }
  });
  test(`${candidate}: status event parents and prior values stay local to their target beat`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]);
    const { alice: a, bob: b, queue } = harness;
    const ua = structureManager(a);
    const ub = structureManager(b);
    try {
      a.doc.transact(() => { mapValue(a.doc.getMap("beats").get("R1")).set("status", "todo"); mapValue(a.doc.getMap("beats").get("R2")).set("status", "todo"); }, "fixture");
      queue.flush("D2");
      changeStatus(a, ua, "R1", "sA", "ready", "Alice");
      queue.flush("D2");
      changeStatus(b, ub, "R2", "sB", "shot", "Bob");
      undoStatus(b, ub);
      queue.flush("dup");
      harness.lateJoin(b);
      const oracle: ScriptOracle = { rows: [
        { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "ready" },
        { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]], status: "todo" }
      ], carets: {}, recovery: [] };
      for (const replica of harness.replicas) {
        checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "target status");
        assert.equal(statusValue(replica, "R1"), "ready");
        assert.equal(statusValue(replica, "R2"), "todo");
      }
    } finally { ua.destroy(); ub.destroy(); harness.destroy(); }
  });
  test(`${candidate}: Lost mark (tag) fails the literal nested stack checker`, () => {
    const result = runMark("T20 nest", candidate, "D1", "single-tag");
    assert.match(result.failure ?? "", /marks/);
  });
  test(`${candidate}: a single LWW status fails the required T21 scalar status`, () => {
    const result = runMark("T21 scalar", candidate, "D1", "lww-status");
    assert.match(result.failure ?? "", /status: expected "todo", got "shot"/);
  });
  test(`${candidate}: same tag registry creation on two replicas has one literal id`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "mug" }]);
    try {
      assert.equal(ensureTag(harness.alice, "Prop", "Mug"), "tag-Prop-4d7567");
      assert.equal(ensureTag(harness.bob, "Prop", "Mug"), "tag-Prop-4d7567");
      harness.queue.flush("dup");
      harness.lateJoin(harness.bob);
      for (const replica of harness.replicas) assert.deepEqual(replica.doc.getMap("tags").toJSON(), { "tag-Prop-4d7567": { kind: "Prop", name: "Mug" } });
    } finally {
      harness.destroy();
    }
  });
  test(`${candidate}: ineffective identical-status undo consumes its step before the writer's earlier insertion`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }]);
    const { alice: a, bob: b, queue } = harness;
    const ua = structureManager(a);
    const ub = structureManager(b);
    const retained: ScriptOracle = { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "Z", {}]], status: "todo" }], carets: {}, recovery: [] };
    const earlierUndone: ScriptOracle = { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "todo" }], carets: {}, recovery: [] };
    const check = (oracle: ScriptOracle): void => {
      queue.flush("dup");
      for (const replica of harness.replicas) checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "consumed undo");
    };
    try {
      a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R1")).set("status", "todo"), "fixture");
      queue.flush("D2");
      b.insert("R1", 2, "Z", ["b1"]);
      queue.flush("D2");
      changeStatus(a, ua, "R1", "sA", "shot", "Alice");
      changeStatus(b, ub, "R1", "sB", "shot", "Bob");
      queue.flush("D1");
      harness.lateJoin(b);
      undoStatus(a, ua);
      check(retained);
      undoStatus(b, ub);
      check(retained);
      undoOne(ub);
      check(earlierUndone);
    } finally {
      ua.destroy();
      ub.destroy();
      harness.destroy();
    }
  });
  test(`${candidate}: replies sort oldest first, tie by id; author guard refuses other writers without mutation`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }]);
    try {
      addComment(harness.alice, "C1", "R1", 0, 1, "Alice");
      harness.queue.flush("D2");
      addReply(harness.alice, "r3", "C1", "Alice", 3);
      addReply(harness.alice, "r1", "C1", "Alice", 1);
      addReply(harness.bob, "r2", "C1", "Bob", 1);
      harness.queue.flush("rev");
      const before = Y.encodeStateAsUpdate(harness.bob.doc);
      assert.equal(editAuthoredRecord(harness.bob, "comments", "C1", "Bob", "other"), false);
      assert.equal(editAuthoredRecord(harness.bob, "replies", "r1", "Bob", "other"), false);
      assert.deepEqual(Y.encodeStateAsUpdate(harness.bob.doc), before);
      assert.equal(editAuthoredRecord(harness.alice, "comments", "C1", "Alice", "mine"), true);
      assert.equal(editAuthoredRecord(harness.bob, "replies", "r2", "Bob", "mine"), true);
      harness.queue.flush("dup");
      harness.lateJoin(harness.bob);
      const oracle: ScriptOracle = {
        rows: [{ id: "R1", characters: [["s1", "a", { "c:C1": true }], ["s2", "b", {}]] }], carets: {}, recovery: [], records: { comments: {
          C1: { author: "Alice", createdAt: 0, text: "mine", rowId: "R1", field: "audioText", recovery: false, replies: [
            { id: "r1", commentId: "C1", author: "Alice", createdAt: 1, text: "" },
            { id: "r2", commentId: "C1", author: "Bob", createdAt: 1, text: "mine" },
            { id: "r3", commentId: "C1", author: "Alice", createdAt: 3, text: "" }
          ] }
        }, recoveryReplies: [] }
      };
      for (const replica of harness.replicas) {
        let updates = 0;
        replica.doc.on("update", () => updates++);
        checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "reply order/author");
        assert.equal(updates, 0, "projection must not write repairs");
      }
    } finally {
      harness.destroy();
    }
  });
  for (const swapped of [false, true]) for (const order of ["D1", "late-C"] as const) for (const same of [false, true]) for (const bobFirst of [false, true]) {
    test(`${candidate}: A-H12 ${same ? "identical" : "different"} status values ${order}, ${swapped ? "swapped" : "normal"} ids, ${bobFirst ? "Bob" : "Alice"} undoes`, () => {
      const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }], swapped);
      const { alice: a, bob: b, queue } = harness;
      const ua = structureManager(a);
      const ub = structureManager(b);
      const check = (status: "todo" | "ready" | "shot"): void => {
        queue.flush(order);
        const oracle: ScriptOracle = {
          rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status }], carets: {}, recovery: [],
          ...(same ? {} : { notices: ["Alice: concurrent status change did not apply", "Bob: concurrent status change did not apply"] })
        };
        for (const replica of harness.replicas) {
          checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "A-H12");
          for (const [reader, value] of Object.entries(statusReaders(replica))) assert.equal(value, status, `A-H12/${reader}`);
        }
      };
      try {
        a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R1")).set("status", "todo"), "fixture");
        queue.flush("D2");
        changeStatus(a, ua, "R1", "sA", same ? "shot" : "ready", "Alice");
        changeStatus(b, ub, "R1", "sB", "shot", "Bob");
        queue.flush(order);
        harness.lateJoin(b);
        check(same ? "shot" : "todo");
        const first = bobFirst ? b : a;
        const manager = bobFirst ? ub : ua;
        const second = bobFirst ? a : b;
        const otherManager = bobFirst ? ua : ub;
        if (!same) {
          manager.stopCapturing();
          changeStatus(first, manager, "R1", "sLater", "ready", bobFirst ? "Bob" : "Alice");
          check("ready");
          undoStatus(first, manager);
          check("todo");
        }
        undoStatus(first, manager);
        check("todo");
        let changes = 0;
        second.doc.on("update", () => changes++);
        undoStatus(second, otherManager);
        assert.equal(changes, 0);
        check("todo");
      } finally {
        ua.destroy();
        ub.destroy();
        harness.destroy();
      }
    });
  }
}

test("mark result table and deciding failure histories reproduce exactly", () => {
  const evidence = JSON.parse(readFileSync(new URL("../../mark-mutations.json", import.meta.url), "utf8")) as { baselinePasses: number; results: MarkMutationEvidence[] };
  assert.equal(evidence.baselinePasses, 116);
  assert.deepEqual(evidence.results.map(result => ({ id: result.id, outcome: result.outcome, edits: result.edits })), markMutationDefinitions.map(definition => ({ id: definition.id, outcome: definition.outcome ?? "DETECTED", edits: definition.edits })));
  for (const result of evidence.results) {
    if (result.outcome === "DETECTED") assert.ok(result.failedTestCount > 0 && result.failedTests.length > 0);
    else assert.equal(result.failedTestCount, 0);
  }
  const report = markReport();
  assert.equal(report.runs.length, 54);
  for (const [path, content] of report.files) assert.equal(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"), content, path);
});
