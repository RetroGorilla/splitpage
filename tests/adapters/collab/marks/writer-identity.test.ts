import { createMonitoredSharedDocument as createSharedDocument } from "../helpers.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { DeliveryQueue, deliveryOrders } from "../../../collab/delivery.ts";
import { assertReplicasAgree } from "../../../collab/agreement.ts";
import { MarkTraceReplica } from "./replica.ts";
import { collabState } from "../../../../src/adapters/collab/state.ts";
import { destroySharedDocument, transactSharedDocument } from "../../../../src/adapters/collab/document.ts";
import { prepareSharedMarkRecord, readSharedMarkCharacters, writeSharedMarkRecord } from "../../../../src/adapters/collab/mark-store.ts";
import { readSharedTextTarget, createCollabText } from "../../../../src/adapters/collab/text-target.ts";
import { monitorSharedFormatting } from "../helpers.ts";

for (const removal of [false, true]) test(removal ? "colliding operation ids: removals and births name the observed writer's addition" : "colliding operation ids: bold a and italic d both survive with either client-id assignment", () => {
  let scenarios = 0;
  for (const [clientA, clientB] of [[1, 2], [2, 1]] as const) for (const order of deliveryOrders) {
    const source = new MarkTraceReplica(50, "abcd"), a = new MarkTraceReplica(clientA, undefined, source.state()), b = new MarkTraceReplica(clientB, undefined, source.state());
    const queue = new DeliveryQueue<Uint8Array>(update => update.slice(), update => String(update.length));
    let c: MarkTraceReplica | null = null;
    try {
      assert.equal(collabState(a.handle).doc.clientID, clientA); assert.equal(collabState(b.handle).doc.clientID, clientB);
      queue.addReplica("A", a.queuePort()); queue.addReplica("B", b.queuePort());
      a.execute({ id: "same", kind: "add", from: removal ? 1 : 0, to: removal ? 3 : 1, mark: { kind: removal ? "i" : "b", value: true } });
      if (removal) a.execute({ id: "remove", kind: "remove", from: 1, to: 3, mark: { kind: "i", value: null } });
      if (order === "D2" || order === "late-C") queue.flush(order);
      if (order === "late-C") { c = new MarkTraceReplica(90, undefined, a.state()); queue.lateJoin("C", c.queuePort(), "A", a.state()); }
      b.execute({ id: "same", kind: "add", from: removal ? 1 : 3, to: removal ? 3 : 4, mark: { kind: "i", value: true } });
      if (removal) b.execute({ id: "birth", kind: "insert", from: 2, to: 2, text: "X", mode: "plain" });
      if (order === "D3") queue.deliverFrom("B", order);
      queue.flush(order);
      if (!c) { c = new MarkTraceReplica(90, undefined, a.state()); queue.lateJoin("C", c.queuePort(), "A", a.state()); }
      const expected = removal ? [
        { value: "a", marks: [] }, { value: "b", marks: [{ kind: "i", value: true }] }, { value: "X", marks: [] }, { value: "c", marks: [{ kind: "i", value: true }] }, { value: "d", marks: [] }
      ] : [{ value: "a", marks: [{ kind: "b", value: true }] }, { value: "b", marks: [] }, { value: "c", marks: [] }, { value: "d", marks: [{ kind: "i", value: true }] }];
      assertReplicasAgree<unknown>("colliding command ids", [{ order: "D1", replica: "A", output: expected }, ...[a, b, c].map((replica, index) => ({
        order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order, replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const,
        output: replica.read().map(char => ({ value: char.value, marks: char.marks })) }))]);
      scenarios++;
    } finally { queue.destroy(); source.destroy(); a.destroy(); b.destroy(); c?.destroy(); }
  }
  assert.equal(scenarios, 12);
});

test("only an initial hydration transaction uses the deterministic hydration writer", () => {
  const readings = [];
  for (const client of [101, 202]) {
    const handle = createSharedDocument(); monitorSharedFormatting(handle); collabState(handle).doc.clientID = client;
    const target = readSharedTextTarget({ owner: "R1", segment: "b:R1", field: "audioText" }); assert.ok(target);
    try {
      transactSharedDocument(handle, "hydration", () => {
        const segment = new Y.Map<unknown>(); collabState(handle).roots.segments.set("b:R1", segment); const text = createCollabText(handle, segment); text.insert(0, "a");
        const record = prepareSharedMarkRecord(handle, target, "seed", 0, 1, { type: "add", mark: { kind: "b", value: true } }); assert.ok(record);
        assert.equal(record.writer, "hydration"); assert.equal(writeSharedMarkRecord(handle, target, "seed", record).ok, true);
      });
      readings.push(readSharedMarkCharacters(handle, target)?.map(char => ({ value: char.value, marks: char.marks })));
      transactSharedDocument(handle, "hydration", () => {
        const record = prepareSharedMarkRecord(handle, target, "later", 0, 1, { type: "add", mark: { kind: "i", value: true } }); assert.ok(record); assert.equal(record.writer, client);
      });
    } finally { destroySharedDocument(handle); }
  }
  const expected = [{ value: "a", marks: [{ kind: "b", id: null, values: [true], additions: [{ record: '["hydration","seed"]', operation: "seed", value: true }] }] }];
  assert.deepEqual(readings, [expected, expected]);
});
