import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplicaHarness, deliveryOrders } from "../../src/delivery.ts";
import { removeWithUndo, undoRemoval } from "../../src/readers/removal-commands.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { structureManager } from "../../src/structure.ts";

for (const order of deliveryOrders) test(`${order}: the original library-backed command cancels the unseen removal, with encoded late joiner`, () => {
  const h = new ReplicaHarness("B", [{ id: "R1", text: "" }]), alice = structureManager(h.alice), bob = structureManager(h.bob);
  try {
    removeWithUndo(h.alice, alice, "R1", "a", "Alice"); removeWithUndo(h.bob, bob, "R1", "b", "Bob");
    undoRemoval(h.alice, alice); h.queue.flush(order); h.lateJoin(h.alice);
    for (const replica of h.replicas) {
      const model = readStructure(replica.doc, "B", h.identities);
      assert.deepEqual({ rows: model.rows.map(row => row.id), recovery: model.recovery.map(entry => ({ id: entry.row.id, by: entry.by, edited: entry.edited })) }, { rows: ["R1"], recovery: [] });
    }
  } finally { alice.destroy(); bob.destroy(); h.destroy(); }
});
