import { test } from "node:test";
import assert from "node:assert/strict";
import { DeliveryQueue } from "./delivery.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, encodeSharedStateVector, encodeSharedUpdate, observeSharedTransactions, observeSharedUpdates, readSharedRevision, shouldDeliverSharedUpdate, transactSharedDocument } from "../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument as createSharedDocument } from "../adapters/collab/helpers.ts";
import { holdSharedBuffer, observeSharedDeclined } from "../../src/adapters/collab/ingress.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { projectSharedDocument } from "../../src/adapters/collab/project.ts";

for (const order of ["D1", "rev", "dup"] as const) {
  test(`rule 26: ${order} declined arrivals are recovered by a state-vector exchange`, () => {
    const a = createSharedDocument(), b = createSharedDocument(), reference = createSharedDocument(), referenceB = createSharedDocument();
    const queue = new DeliveryQueue<Uint8Array>(update => Uint8Array.from(update), update => String(update.byteLength));
    let refused = 0, declined = 0;
    const expected: ReturnType<typeof snapshot>[] = [], expectedB: ReturnType<typeof snapshot>[] = [];
    const accepted = order === "D1" ? [true, false, false] : order === "rev" ? [true, true, false] : [true, false, false, false, false, false];
    let arrival = 0;
    const receive = (update: Uint8Array, accept: boolean): void => {
      if (accept) { assert.deepEqual(applySharedUpdate(reference, update), { ok: true }); expected.push(snapshot(reference)); }
      assert.deepEqual(applySharedUpdate(a, update), accept ? { ok: true } : { ok: false, reason: "queue-full" });
      if (!accept) refused++;
    };
    observeSharedTransactions(a, () => {
      const prefix = expected.shift(); assert.ok(prefix);
      assert.deepEqual(snapshot(a), prefix, "A publishes exactly its accepted arrival prefix, including redelivery");
    });
    for (const [name, handle] of [["A", a], ["B", b]] as const) queue.addReplica(name, {
      onLocalUpdate: listener => observeSharedUpdates(handle, (update, origin) => { if (shouldDeliverSharedUpdate(origin)) listener(update); }),
      apply: update => {
        assert.equal(handle, a);
        const accept = accepted[arrival++]; assert.notEqual(accept, undefined);
        receive(update, accept === true);
      }
    });
    try {
      const release = holdSharedBuffer(a);
      observeSharedDeclined(a, () => { declined++; });
      for (const [key, value] of [["first", "x".repeat(40000)], ["second", "y".repeat(40000)], ["small", "z"]] as const) {
        transactSharedDocument(b, "local-command", () => collabState(b).roots.meta.set(key, value));
      }
      assert.deepEqual(applySharedUpdate(referenceB, encodeSharedState(b)), { ok: true });
      collabState(referenceB).revision = 3;
      observeSharedTransactions(b, () => {
        const prefix = expectedB.shift(); assert.ok(prefix);
        assert.deepEqual(snapshot(b), prefix, "B publishes its accepted resynchronization prefix");
      });
      queue.flush(order);
      assert.ok(refused > 0);
      assert.deepEqual(collabState(a).roots.meta.toJSON(), {});
      release();
      assert.equal(declined, 1);
      const difference = encodeSharedUpdate(b, encodeSharedStateVector(a));
      receive(difference, true);
      if (order === "dup") receive(difference, true);
      const echoed = encodeSharedUpdate(a, encodeSharedStateVector(b));
      assert.deepEqual(applySharedUpdate(referenceB, echoed), { ok: true }); expectedB.push(snapshot(referenceB));
      assert.deepEqual(applySharedUpdate(b, echoed), { ok: true });
      assert.deepEqual(collabState(a).roots.meta.toJSON(), { first: "x".repeat(40000), second: "y".repeat(40000), small: "z" });
      assert.deepEqual(collabState(a).roots.meta.toJSON(), collabState(b).roots.meta.toJSON());
      assert.deepEqual(encodeSharedStateVector(a), encodeSharedStateVector(b));
      assert.deepEqual([expected, expectedB], [[], []]);
    } finally { queue.destroy(); for (const handle of [a, b, reference, referenceB]) destroySharedDocument(handle); }
  });
}

function snapshot(handle: ReturnType<typeof createSharedDocument>) {
  return { revision: readSharedRevision(handle), meta: collabState(handle).roots.meta.toJSON(), projection: JSON.stringify(projectSharedDocument(handle)), vector: encodeSharedStateVector(handle) };
}
