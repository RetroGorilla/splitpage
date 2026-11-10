import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReplicasAgree } from "./agreement.ts";
import type { ReplicaReading } from "./agreement.ts";
import { DeliveryQueue } from "./delivery.ts";
import type { DeliveryOrder, DeliveryReplica, ReplicaName } from "./delivery.ts";

interface StatusWrite {
  id: string;
  value: string;
}

class StatusReplica implements DeliveryReplica<StatusWrite[]> {
  readonly writes = new Map<string, string>();
  private readonly listeners = new Set<(update: StatusWrite[]) => void>();

  onLocalUpdate(listener: (update: StatusWrite[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  apply(update: StatusWrite[]): void {
    for (const write of update) if (!this.writes.has(write.id)) this.writes.set(write.id, write.value);
  }

  write(id: string, value: string): void {
    this.writes.set(id, value);
    for (const listener of this.listeners) listener([{ id, value }]);
  }

  state(): StatusWrite[] {
    return [...this.writes].map(([id, value]) => ({ id, value }));
  }
}

function firstWrite(replica: StatusReplica): string | undefined {
  return replica.writes.values().next().value;
}

function lowestWrite(replica: StatusReplica): string | undefined {
  return [...replica.writes].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))[0]?.[1];
}

function readings<Output>(reader: (replica: StatusReplica) => Output): ReplicaReading<Output>[] {
  const found: ReplicaReading<Output>[] = [];
  for (const order of ["D1", "rev"] as const satisfies readonly DeliveryOrder[]) {
    const queue = new DeliveryQueue<StatusWrite[]>(update => update.map(write => ({ ...write })), update => update.map(write => write.id).join(","));
    const replicas: Record<"A" | "B", StatusReplica> = { A: new StatusReplica(), B: new StatusReplica() };
    queue.addReplica("A", replicas.A);
    queue.addReplica("B", replicas.B);
    replicas.A.write("a", "ready");
    replicas.B.write("b", "shot");
    queue.flush(order);
    for (const name of ["A", "B"] as const satisfies readonly ReplicaName[]) found.push({ order, replica: name, output: reader(replicas[name]) });
    if (order === "rev") {
      const late = new StatusReplica();
      queue.lateJoin("C", late, "B", replicas.B.state());
      found.push({ order: "late-C", replica: "C", output: reader(late) });
    }
    queue.destroy();
  }
  return found;
}

test("a reader that takes the first map entry is caught, and the message names the replica and order that differ", () => {
  assert.throws(() => assertReplicasAgree("status", readings(firstWrite)),
    /^Error: status: replica B after D1 differs from replica A after D1 at status: "ready" against "shot"$/);
});

test("a reader with an order independent of delivery agrees across orders and the late joiner", () => {
  assertReplicasAgree("status", readings(lowestWrite));
});

test("a difference only in key order or map entry order is a disagreement", () => {
  assert.throws(() => assertReplicasAgree("fields", [
    { order: "D1", replica: "A", output: { a: 1, b: 2 } },
    { order: "late-C", replica: "C", output: { b: 2, a: 1 } }
  ]), /replica C after late-C differs from replica A after D1 at fields: keys \["a","b"\] against \["b","a"\]/);
  assert.throws(() => assertReplicasAgree("records", [
    { order: "D1", replica: "A", output: new Map([["x", 1], ["y", 2]]) },
    { order: "late-C", replica: "C", output: new Map([["y", 2], ["x", 1]]) }
  ]), /replica C after late-C differs from replica A after D1 at records<key 0>: "x" against "y"/);
  assert.throws(() => assertReplicasAgree("rows", [
    { order: "D1", replica: "A", output: [{ id: "R1", tags: new Set(["P", "S"]) }] },
    { order: "late-C", replica: "C", output: [{ id: "R1", tags: new Set(["S", "P"]) }] }
  ]), /at rows\[0\]\.tags<0>: "P" against "S"/);
});

test("readings must cover more than one delivery order and include the late joiner", () => {
  assert.throws(() => assertReplicasAgree("x", []), /x: no readings/);
  assert.throws(() => assertReplicasAgree("x", [{ order: "D1", replica: "A", output: 1 }, { order: "D1", replica: "B", output: 1 }]), /one delivery order only/);
  assert.throws(() => assertReplicasAgree("x", [{ order: "D1", replica: "A", output: 1 }, { order: "rev", replica: "B", output: 1 }]), /no late joiner C reading/);
});
