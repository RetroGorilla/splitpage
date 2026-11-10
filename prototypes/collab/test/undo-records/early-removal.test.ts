import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplicaHarness, deliveryOrders } from "../../src/delivery.ts";
import type { DeliveryOrder } from "../../src/delivery.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { removeBeat } from "../../src/undo-records/commands.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";

function replay(order: DeliveryOrder, concurrent = true, delivered = false) {
  const h = new ReplicaHarness("B", [{ id: "R1", text: "" }]);
  const histories = [new CommandHistory(h.alice), new CommandHistory(h.bob)];
  try {
    for (let index = 0; index < (concurrent ? 2 : 1); index++) {
      const id = index ? "b" : "a", by = index ? "Bob" : "Alice";
      const history = histories[index]; assert.ok(history);
      removeBeat(history, "R1", id, by);
    }
    if (delivered) h.queue.flush(order);
    const history = histories[0]; assert.ok(history); assert.equal(history.undo().effective, true);
    h.queue.flush(order); h.lateJoin(h.alice);
    return h.replicas.map(replica => {
      const model = readStructure(replica.doc, "B", h.identities);
      return { rows: model.rows.map(row => row.id), recovery: model.recovery.map(entry => ({ id: entry.row.id, by: entry.by, edited: entry.edited })) };
    });
  } finally { h.destroy(); }
}

for (const order of deliveryOrders) {
test(`${order}: command-record early removal undo cancels an unseen identical removal, with encoded late joiner`, () => {
  for (const actual of replay(order)) assert.deepEqual(actual, { rows: ["R1"], recovery: [] });
});

test(`${order}: command records pass after receiving the concurrent removal`, () => {
  for (const actual of replay(order, true, true)) assert.deepEqual(actual, { rows: ["R1"], recovery: [] });
});

test(`${order}: command records pass without the concurrent removal`, () => {
  for (const actual of replay(order, false)) assert.deepEqual(actual, { rows: ["R1"], recovery: [] });
});
}
