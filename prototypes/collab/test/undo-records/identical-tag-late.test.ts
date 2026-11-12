import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplicaHarness } from "../../src/delivery.ts";
import { tagRange } from "../../src/undo-records/commands.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";

const ORDERS = ["D1", "dup", "rev"] as const;
const KEPT = [{ insert: "ab", attributes: { "t:P@10.4-10.5": "P" } }];
const REMOVED = [{ insert: "ab" }];

function drain(h: ReplicaHarness, order: typeof ORDERS[number]): void {
  for (let round = 0; h.queue.pending.length > 0; round++) {
    const batch = [...h.queue.pending];
    if (order === "rev" && round === 0) batch.reverse();
    for (const message of batch) h.queue.deliver(message.id, order === "dup" ? 2 : 1);
  }
}

function replay(order: typeof ORDERS[number], deliveredFirst: boolean): unknown[] {
  const h = new ReplicaHarness("B", [{ id: "R1", text: "ab" }]);
  try {
    h.alice.doc.transact(() => h.alice.doc.getMap("tags").set("P", { kind: "Prop" }), "fixture");
    drain(h, "D1");
    const alice = new CommandHistory(h.alice), bob = new CommandHistory(h.bob);
    assert.equal(tagRange(alice, "R1", 0, 2, "P"), "t:P@10.4-10.5");
    assert.equal(tagRange(bob, "R1", 0, 2, "P"), "t:P@10.4-10.5");
    if (deliveredFirst) drain(h, order);
    assert.equal(alice.undo().effective, true);
    drain(h, order);
    return h.replicas.map((replica): unknown => replica.locate("R1").text.toDelta());
  } finally { h.destroy(); }
}

for (const order of ORDERS) {
  test(`${order}: identical tag, Alice undoes before Bob's tag arrives: both prototype copies keep the tag`, () => {
    assert.deepEqual(replay(order, false), [KEPT, KEPT]);
  });

  test(`${order}: identical tag, Alice undoes after Bob's tag arrived: both prototype copies lose the tag`, () => {
    assert.deepEqual(replay(order, true), [REMOVED, REMOVED]);
  });
}
