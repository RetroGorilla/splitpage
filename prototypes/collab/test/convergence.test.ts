import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";

test("concurrent inserts converge in both delivery orders and on a late join", () => {
  for (const reverse of [false, true]) {
    const replicas: [Y.Doc, Y.Doc, Y.Doc] = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    const [alice, bob, late] = replicas;
    try {
      alice.clientID = 1;
      bob.clientID = 2;
      alice.getText("text").insert(0, "A");
      bob.getText("text").insert(0, "B");
      const updates = [Y.encodeStateAsUpdate(alice), Y.encodeStateAsUpdate(bob)];
      if (reverse) updates.reverse();
      for (const update of updates) {
        Y.applyUpdate(alice, update);
        Y.applyUpdate(bob, update);
      }
      assert.equal(alice.getText("text").toString(), "AB");
      assert.equal(bob.getText("text").toString(), "AB");
      Y.applyUpdate(late, Y.encodeStateAsUpdate(alice));
      assert.equal(late.getText("text").toString(), "AB");
    } finally {
      for (const replica of replicas) replica.destroy();
    }
  }
});
