import { test } from "node:test";
import assert from "node:assert/strict";
import { DeliveryQueue } from "./delivery.ts";
import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedStateVector, encodeSharedUpdate, observeSharedUpdates, shouldDeliverSharedUpdate, transactSharedDocument } from "../../src/adapters/collab/document.ts";
import { holdSharedBuffer, observeSharedDeclined } from "../../src/adapters/collab/ingress.ts";
import { collabState } from "../../src/adapters/collab/state.ts";

for (const order of ["D1", "rev", "dup"] as const) {
  test(`rule 26: ${order} declined arrivals are recovered by a state-vector exchange`, () => {
    const a = createSharedDocument(), b = createSharedDocument();
    const queue = new DeliveryQueue<Uint8Array>(update => Uint8Array.from(update), update => String(update.byteLength));
    let refused = 0, declined = 0;
    for (const [name, handle] of [["A", a], ["B", b]] as const) queue.addReplica(name, {
      onLocalUpdate: listener => observeSharedUpdates(handle, (update, origin) => { if (shouldDeliverSharedUpdate(origin)) listener(update); }),
      apply: update => {
        const result = applySharedUpdate(handle, update);
        if (!result.ok) { assert.equal(result.reason, "queue-full"); refused++; }
      }
    });
    try {
      const release = holdSharedBuffer(a);
      observeSharedDeclined(a, () => { declined++; });
      for (const [key, value] of [["first", "x".repeat(40000)], ["second", "y".repeat(40000)], ["small", "z"]] as const) {
        transactSharedDocument(b, "local-command", () => collabState(b).roots.meta.set(key, value));
      }
      queue.flush(order);
      assert.ok(refused > 0);
      assert.deepEqual(collabState(a).roots.meta.toJSON(), {});
      release();
      assert.equal(declined, 1);
      const difference = encodeSharedUpdate(b, encodeSharedStateVector(a));
      assert.deepEqual(applySharedUpdate(a, difference), { ok: true });
      if (order === "dup") assert.deepEqual(applySharedUpdate(a, difference), { ok: true });
      assert.deepEqual(collabState(a).roots.meta.toJSON(), { first: "x".repeat(40000), second: "y".repeat(40000), small: "z" });
      assert.deepEqual(collabState(a).roots.meta.toJSON(), collabState(b).roots.meta.toJSON());
      assert.deepEqual(encodeSharedStateVector(a), encodeSharedStateVector(b));
    } finally { queue.destroy(); destroySharedDocument(a); destroySharedDocument(b); }
  });
}
