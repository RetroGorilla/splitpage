import assert from "node:assert/strict";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { readOperation, readSharedContentRef } from "../../../src/core/collab/read-operation.ts";
import { createSharedDocument, applySharedUpdate, encodeSharedState, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { deliveryReplica, validatedFixture } from "./helpers.ts";
import { DeliveryQueue } from "../../collab/delivery.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { ReplicaReading } from "../../collab/agreement.ts";

export function ref(value: string) { const id = readSharedContentRef(value); assert.ok(id); return id; }
export function operation(value: unknown): SharedOperation { const result = readOperation(value); assert.ok(result); return result; }
export function execute(handle: SharedDocumentHandle, ...commands: unknown[]): void {
  assert.deepEqual(executeSharedOperations(handle, commands.map(operation)), { ok: true });
}

export function replicas(count = 2) {
  const a = createSharedDocument(), b = createSharedDocument(), c = createSharedDocument();
  [a, b, c].forEach((handle, index) => { collabState(handle).doc.clientID = index + 1; });
  hydrateSharedDocument(a, validatedFixture({ title: "Title", rows: [{ id: "R1", audioText: "abZ", status: "todo" }],
    sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }],
    productionTags: [{ id: "t_1", cat: "prop", name: "Cup", status: "needed" }],
    brollShots: [{ id: "S1", name: "Cup", status: "unshot", origin: "list" }] }));
  for (const handle of [b, c]) assert.ok(applySharedUpdate(handle, encodeSharedState(a)).ok);
  const queue = new DeliveryQueue<Uint8Array>(bytes => bytes.slice(), bytes => String(bytes.length));
  queue.addReplica("A", deliveryReplica(a)); queue.addReplica("B", deliveryReplica(b));
  if (count === 3) queue.addReplica("C", deliveryReplica(c));
  return { a, b, c, queue, close: () => { queue.destroy(); for (const handle of [a, b, c]) destroySharedDocument(handle); } };
}

export function agree<T>(label: string, order: DeliveryOrder, handles: readonly SharedDocumentHandle[], read: (handle: SharedDocumentHandle) => T, expected?: T): void {
  const source = handles[0]; assert.ok(source);
  const late = createSharedDocument();
  try {
    assert.ok(applySharedUpdate(late, encodeSharedState(source)).ok);
    const readings: ReplicaReading<T>[] = handles.map((handle, index) => ({ order: order === "late-C" ? "D1" as const : order,
      replica: index ? "B" as const : "A" as const, output: read(handle) }));
    readings.push({ order: "late-C", replica: "C", output: read(late) });
    if (expected !== undefined) readings.unshift({ order: "D2", replica: "A", output: expected });
    assertReplicasAgree(label, readings);
  } finally { destroySharedDocument(late); }
}
