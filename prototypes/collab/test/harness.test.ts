import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { ReplicaHarness } from "../src/delivery.ts";
import type { DeliveryOrder } from "../src/delivery.ts";
import { checkModel } from "../src/model.ts";
import type { ScriptOracle } from "../src/model.ts";
import { readReplica } from "../src/reader.ts";
import type { ReplicaCaretAnchor, ReplicaCarets } from "../src/reader.ts";
import type { SchemaCandidate } from "../src/schema.ts";
import { copyOnJoin, copyOnRestore, deleteStaleOffsets, omitLength, replaceWithStaleBeat, singleCommentMark } from "../src/defects.ts";
import { commentsOracle, deletionOracle, joinOracle, lengthOracle, removedOracle, restorationOracle, splitOracle, splitUndoOracle, swappedSplitOracle } from "./oracles.ts";

function checkEvery(harness: ReplicaHarness, oracle: ScriptOracle, carets: ReplicaCarets): void {
  for (const replica of harness.replicas) {
    checkModel(readReplica(replica.doc, replica.candidate, harness.identities, carets), oracle, harness.identities, `client${replica.doc.clientID}`);
  }
}

function caret(harness: ReplicaHarness, beat: string, offset: number, assoc = 0): Y.RelativePosition {
  const { text, start } = harness.alice.locate(beat);
  return Y.createRelativePositionFromTypeIndex(text, start + offset, assoc);
}

for (const candidate of ["A", "B"] as const) {
  for (const defect of ["Lost remote character", "Stale base"] as const) {
    test(`${candidate}: checker rejects ${defect} (T01 D3 M2)`, () => {
      const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abcd" }]);
      try {
        const carets = new Map([["A", { position: caret(harness, "R1", 1, -1) }]]);
        harness.queue.history.push("A painted abcd; native buffer deletes original bc -> ad");
        harness.bob.insert("R1", 2, "X", ["b1"]);
        harness.queue.deliverFrom("B", "D3");
        if (defect === "Lost remote character") replaceWithStaleBeat(harness.alice);
        else deleteStaleOffsets(harness.alice);
        harness.queue.flush("D3");
        for (const replica of harness.replicas) {
          const actual = readReplica(replica.doc, candidate, harness.identities, carets);
          assert.equal(actual.rows[0]?.characters.map(character => character.value).join(""), defect === "Lost remote character" ? "ad" : "acd");
          assert.throws(() => checkModel(actual, deletionOracle, harness.identities, "T01"), /T01.rows\[0\].characters\[1\].identity/);
        }
      } finally {
        harness.destroy();
      }
    });
  }

  test(`${candidate}: checker rejects Duplicated identity (T10 D1 late-C)`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, { id: "R3", text: "ef" }]);
    try {
      const carets = new Map([["A", { position: caret(harness, "R2", 0) }]]);
      harness.alice.remove("R2", "rA", "Alice");
      harness.bob.insert("R2", 1, "X", ["b1"]);
      harness.queue.flush("D1");
      harness.lateJoin(harness.bob);
      checkEvery(harness, removedOracle, carets);
      copyOnRestore(harness.alice);
      harness.queue.flush("D1");
      for (const replica of harness.replicas) {
        const actual = readReplica(replica.doc, candidate, harness.identities, carets);
        assert.equal(actual.rows[1]?.characters.map(character => character.value).join(""), "cdcXd");
        assert.throws(() => checkModel(actual, restorationOracle, harness.identities, "T10"), /T10.rows\[1\].characters\[0\].identity/);
      }
    } finally {
      harness.destroy();
    }
  });

  test(`${candidate}: checker rejects Duplicated identity (join) (T06 D1 narration probe)`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]);
    try {
      harness.alice.format("R1", 0, 2, { b: true });
      harness.queue.flush("D2");
      const carets = new Map([[
        "A", { position: caret(harness, "R2", 0) }
      ], ["B", { position: caret(harness, "R2", 0) }]]);
      copyOnJoin(harness.alice);
      harness.bob.join("R2", "R1", "jB");
      harness.queue.flush("D1");
      for (const replica of harness.replicas) {
        const actual = readReplica(replica.doc, candidate, harness.identities, carets);
        assert.equal(actual.rows[0]?.characters.map(character => character.value).join(""), "abcd cd");
        assert.throws(() => checkModel(actual, joinOracle, harness.identities, "T06"), /T06.rows\[0\].characters\[2\].identity/);
      }
    } finally {
      harness.destroy();
    }
  });

  test(`${candidate}: checker rejects Lost mark (T11 step 1 D1)`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abcd" }]);
    try {
      singleCommentMark(harness.alice, "C1", 1);
      singleCommentMark(harness.bob, "C2", 2);
      harness.queue.flush("D1");
      for (const replica of harness.replicas) {
        const actual = readReplica(replica.doc, candidate, harness.identities);
        assert.equal(Object.keys(actual.rows[0]?.characters[2]?.marks ?? {}).length, 1);
        assert.throws(() => checkModel(actual, commentsOracle, harness.identities, "T11"), /T11.rows\[0\].characters\[2\].marks.c:C1/);
      }
    } finally {
      harness.destroy();
    }
  });

  test(`${candidate}: checker rejects Omitted field (PROJ serialization)`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab", lengthSeconds: 12 }]);
    try {
      checkEvery(harness, lengthOracle, new Map());
      for (const replica of harness.replicas) {
        assert.throws(() => checkModel(omitLength(readReplica(replica.doc, candidate, harness.identities)), lengthOracle, harness.identities, "PROJ"), /PROJ.rows\[0\].lengthSeconds: expected 12, got <missing>/);
      }
    } finally {
      harness.destroy();
    }
  });

  test(`${candidate}: independent comment attributes keep both marks (T11 step 1 probe)`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abcd" }]);
    try {
      harness.alice.format("R1", 1, 2, { "c:C1": true });
      harness.bob.format("R1", 2, 2, { "c:C2": true });
      harness.queue.flush("D1");
      checkEvery(harness, commentsOracle, new Map());
    } finally {
      harness.destroy();
    }
  });

  test(`${candidate}: an honest deletion and undo retain remote identity and give restores new identities`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abcd" }]);
    const undo = harness.alice.undoManager();
    try {
      const restores = harness.alice.captureUndoIdentities(["s2", "s3"]);
      const carets = new Map<string, ReplicaCaretAnchor>([["A", { position: caret(harness, "R1", 1, -1) }]]);
      const selectionEnd = caret(harness, "R1", 3);
      harness.bob.insert("R1", 2, "X", ["b1"]);
      harness.queue.deliverFrom("B", "D3");
      harness.alice.deleteIdentities(["s2", "s3"]);
      harness.queue.flush("D3");
      checkEvery(harness, deletionOracle, carets);
      undo.undo();
      harness.alice.bindUndoRestores(restores);
      const firstRestore = restores[0];
      assert.ok(firstRestore);
      const restoredStart = Y.createAbsolutePositionFromRelativePosition(firstRestore.position, harness.alice.doc, true);
      assert.ok(restoredStart);
      carets.set("A", { position: Y.createRelativePositionFromTypeIndex(restoredStart.type, restoredStart.index, 0), selectionEnd });
      harness.queue.flush("dup");
      harness.lateJoin();
      checkEvery(harness, {
        rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2*", "b", {}], ["b1", "X", {}], ["s3*", "c", {}], ["s4", "d", {}]] }],
        carets: { A: { beat: "R1", offset: 1, selection: { beat: "R1", from: 1, to: 4 } } }, recovery: []
      }, carets);
    } finally {
      undo.destroy();
      harness.destroy();
    }
  });

  for (const order of ["D1", "dup", "rev", "late-C"] satisfies DeliveryOrder[]) {
    for (const swapped of [false, true]) {
      test(`${candidate}: T05 ${order}${swapped ? " swapped clientIDs" : ""}, including undo`, () => {
        runSplit(candidate, order, swapped);
      });
    }
  }
}

function runSplit(candidate: SchemaCandidate, order: DeliveryOrder, swapped: boolean): void {
  const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abcd" }], swapped);
  const undo = harness.alice.undoManager();
  try {
    const restoredCaret = caret(harness, "R1", 2);
    harness.alice.split("R1", 2, "Ra", "a1");
    const aCaret = caret(harness, "Ra", 0, -1);
    harness.bob.insert("R1", 2, "X", ["b1"]);
    const bobLocation = harness.bob.locate("R1");
    const bCaret = Y.createRelativePositionFromTypeIndex(bobLocation.text, bobLocation.start + 3, -1);
    const carets = new Map([["A", { position: aCaret }], ["B", { position: bCaret }]]);
    harness.queue.flush(order);
    if (order === "late-C") harness.lateJoin(harness.bob);
    checkEvery(harness, swapped ? swappedSplitOracle : splitOracle, carets);
    undo.undo();
    carets.set("A", { position: restoredCaret });
    harness.queue.flush(order);
    checkEvery(harness, splitUndoOracle, carets);
  } finally {
    undo.destroy();
    harness.destroy();
  }
}

test("queue delays a dependency, duplicates and reverses it; C joins from full state and receives later updates", () => {
  const harness = new ReplicaHarness("A", [{ id: "R1", text: "ab" }]);
  try {
    harness.bob.insert("R1", 1, "X", ["b1"]);
    harness.bob.insert("R1", 2, "Y", ["b2"]);
    const later = harness.queue.pending[1];
    assert.ok(later);
    harness.queue.deliver(later.id, 2);
    assert.equal(harness.alice.characters().map(character => character.value).join(""), "ab");
    harness.queue.flush("rev");
    const expected: ScriptOracle = {
      rows: [{ id: "R1", characters: [["s1", "a", {}], ["b1", "X", {}], ["b2", "Y", {}], ["s2", "b", {}]] }], carets: {}, recovery: []
    };
    harness.lateJoin();
    checkEvery(harness, expected, new Map());
    harness.alice.deleteIdentities(["b2"]);
    harness.queue.flush("dup");
    checkEvery(harness, {
      rows: [{ id: "R1", characters: [["s1", "a", {}], ["b1", "X", {}], ["s2", "b", {}]] }], carets: {}, recovery: []
    }, new Map());
    assert.equal(harness.queue.pending.length, 0);
  } finally {
    harness.destroy();
  }
});

test("D2 delivers the first writer before the second acts", () => {
  const harness = new ReplicaHarness("B", [{ id: "R1", text: "ab" }]);
  try {
    harness.alice.insert("R1", 1, "X", ["a1"]);
    harness.queue.deliverFrom("A", "D2");
    harness.bob.insert("R1", 2, "Y", ["b1"]);
    harness.queue.flush("D2");
    checkEvery(harness, {
      rows: [{ id: "R1", characters: [["s1", "a", {}], ["a1", "X", {}], ["b1", "Y", {}], ["s2", "b", {}]] }], carets: {}, recovery: []
    }, new Map());
  } finally {
    harness.destroy();
  }
});
