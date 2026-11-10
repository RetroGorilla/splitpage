import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryQueue, deliveryOrders } from "./delivery.ts";
import type { DeliveryReplica } from "./delivery.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class LogReplica implements DeliveryReplica<Uint8Array> {
  readonly received: string[] = [];
  readonly items = new Set<string>();
  private readonly listeners = new Set<(update: Uint8Array) => void>();
  echo = false;

  onLocalUpdate(listener: (update: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  apply(update: Uint8Array): void {
    const items = decoder.decode(update).split(",").filter(Boolean);
    this.received.push(items.join(","));
    for (const item of items) this.items.add(item);
    if (this.echo) this.emit(update);
  }

  write(item: string): void {
    this.items.add(item);
    this.emit(encoder.encode(item));
  }

  state(): Uint8Array {
    return encoder.encode([...this.items].join(","));
  }

  sorted(): string[] {
    return [...this.items].sort();
  }

  private emit(update: Uint8Array): void {
    for (const listener of this.listeners) listener(update);
  }
}

function setup(): { queue: DeliveryQueue<Uint8Array>; a: LogReplica; b: LogReplica } {
  const queue = new DeliveryQueue<Uint8Array>(update => update.slice(), update => `${update.length} bytes`);
  const a = new LogReplica();
  const b = new LogReplica();
  queue.addReplica("A", a);
  queue.addReplica("B", b);
  return { queue, a, b };
}

test("the orders are the Stage 0 notation, with no clock among them", () => {
  assert.deepEqual(deliveryOrders, ["D1", "D2", "D3", "dup", "rev", "late-C"]);
});

test("D1: both replicas act, then every update is exchanged once in enqueue order", () => {
  const { queue, a, b } = setup();
  a.write("a1");
  a.write("a2");
  b.write("b1");
  assert.deepEqual(queue.pending.map(message => `${message.id} ${message.from}->${message.to}`), ["A1 A->B", "A2 A->B", "B3 B->A"]);
  queue.flush("D1");
  assert.deepEqual(b.received, ["a1", "a2"]);
  assert.deepEqual(a.received, ["b1"]);
  assert.deepEqual(a.sorted(), b.sorted());
  assert.deepEqual(queue.history, [
    "enqueue A1 A->B 2 bytes", "enqueue A2 A->B 2 bytes", "enqueue B3 B->A 2 bytes",
    "deliver A1 A->B copy 1", "deliver A2 A->B copy 1", "deliver B3 B->A copy 1"
  ]);
});

test("D2: the first replica's update reaches the second before it acts", () => {
  const { queue, a, b } = setup();
  a.write("a1");
  queue.flush("D2");
  assert.deepEqual(b.sorted(), ["a1"]);
  b.write("b1");
  queue.flush("D2");
  assert.deepEqual(a.received, ["b1"]);
  assert.equal(queue.pending.length, 0);
});

test("D3: Bob's update reaches Alice while Alice's own updates stay queued", () => {
  const { queue, a, b } = setup();
  a.write("a1");
  b.write("b1");
  queue.deliverFrom("B", "D3");
  assert.deepEqual(a.received, ["b1"]);
  assert.deepEqual(b.received, []);
  assert.deepEqual(queue.pending.map(message => message.id), ["A1"]);
  queue.flush("D3");
  assert.deepEqual(b.received, ["a1"]);
});

test("dup delivers every update twice", () => {
  const { queue, a, b } = setup();
  a.write("a1");
  b.write("b1");
  queue.flush("dup");
  assert.deepEqual(b.received, ["a1", "a1"]);
  assert.deepEqual(a.received, ["b1", "b1"]);
  assert.deepEqual(a.sorted(), b.sorted());
});

test("rev delivers in reverse order, from one replica or from all", () => {
  const first = setup();
  first.a.write("a1");
  first.a.write("a2");
  first.a.write("a3");
  first.queue.deliverFrom("A", "rev");
  assert.deepEqual(first.b.received, ["a3", "a2", "a1"]);
  const second = setup();
  second.a.write("a1");
  second.b.write("b1");
  second.a.write("a2");
  second.queue.flush("rev");
  assert.deepEqual(second.b.received, ["a2", "a1"]);
  assert.deepEqual(second.a.received, ["b1"]);
});

test("late-C joins from one replica's full state and then exchanges updates both ways", () => {
  const { queue, a, b } = setup();
  a.write("a1");
  b.write("b1");
  queue.flush("late-C");
  const c = new LogReplica();
  queue.lateJoin("C", c, "A", a.state());
  assert.deepEqual(c.received, ["a1,b1"]);
  assert.equal(queue.history.at(-1), "late-C full state from A");
  c.write("c1");
  a.write("a2");
  queue.flush("late-C");
  assert.deepEqual([a.sorted(), b.sorted()], [c.sorted(), c.sorted()]);
  assert.deepEqual(c.sorted(), ["a1", "a2", "b1", "c1"]);
  assert.throws(() => queue.lateJoin("C", new LogReplica(), "A", a.state()), /Replica C already attached/);
  assert.throws(() => setup().queue.lateJoin("C", new LogReplica(), "C", new Uint8Array()), /Missing source C/);
});

test("the queue delivers its own copy, so a later change to the sender's buffer is not delivered", () => {
  const queue = new DeliveryQueue<Uint8Array>(update => update.slice(), update => `${update.length} bytes`);
  const sent = encoder.encode("a1");
  const a: DeliveryReplica<Uint8Array> = { onLocalUpdate: listener => { listener(sent); return () => {}; }, apply: () => {} };
  const b = new LogReplica();
  queue.addReplica("B", b);
  queue.addReplica("A", a);
  sent.fill(0);
  queue.flush("D1");
  assert.deepEqual(b.received, ["a1"]);
});

test("a replica that reports a delivered update as its own is refused", () => {
  const { queue, a, b } = setup();
  b.echo = true;
  a.write("a1");
  assert.throws(() => queue.flush("D1"), /Replica B reported a delivered update as local/);
});

test("delivery fails loudly on an unknown message and stops after destroy", () => {
  const { queue, a } = setup();
  assert.throws(() => queue.deliver("A9"), /No queued delivery A9/);
  queue.destroy();
  a.write("a1");
  assert.equal(queue.pending.length, 0);
});
