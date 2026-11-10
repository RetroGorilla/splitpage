import * as Y from "yjs";
import { IdentityBook } from "./model.ts";
import type { SchemaCandidate, SeedBeat } from "./schema.ts";
import { SchemaReplica } from "./schema.ts";

export const deliveryOrders = ["D1", "D2", "D3", "dup", "rev", "late-C"] as const;
export type DeliveryOrder = typeof deliveryOrders[number];
export type ReplicaName = "A" | "B" | "C";

export interface QueuedDelivery {
  id: string;
  from: ReplicaName;
  to: ReplicaName;
  update: Uint8Array;
}

export class DeliveryQueue {
  readonly pending: QueuedDelivery[] = [];
  readonly history: string[] = [];
  private serial = 0;
  private readonly replicas: Map<ReplicaName, SchemaReplica>;
  private readonly inbound: (replica: ReplicaName, update: Uint8Array) => void;
  private readonly listeners = new Map<ReplicaName, (update: Uint8Array, origin: unknown) => void>();

  constructor(replicas: { A: SchemaReplica; B: SchemaReplica }, inbound?: (replica: ReplicaName, update: Uint8Array) => void) {
    this.replicas = new Map();
    this.inbound = inbound ?? ((name, update) => {
      const replica = this.replicas.get(name);
      if (!replica) throw new Error(`Missing recipient ${name}`);
      Y.applyUpdate(replica.doc, update, "delivery");
    });
    this.addReplica("A", replicas.A);
    this.addReplica("B", replicas.B);
  }

  addReplica(from: ReplicaName, replica: SchemaReplica): void {
    if (this.replicas.has(from)) throw new Error(`Replica ${from} already attached`);
    this.replicas.set(from, replica);
    const listener = (update: Uint8Array, origin: unknown): void => {
      if (origin === "delivery" || origin === "network") return;
      for (const to of this.replicas.keys()) {
        if (to === from) continue;
        const id = `${from}${++this.serial}`;
        this.pending.push({ id, from, to, update: update.slice() });
        this.history.push(`enqueue ${id} ${from}->${to} ${update.length} bytes`);
      }
    };
    this.listeners.set(from, listener);
    replica.doc.on("update", listener);
  }

  deliver(id: string, copies = 1): void {
    const index = this.pending.findIndex(message => message.id === id);
    const [message] = index < 0 ? [] : this.pending.splice(index, 1);
    if (!message) throw new Error(`No queued delivery ${id}`);
    for (let copy = 0; copy < copies; copy++) {
      this.history.push(`deliver ${id} ${message.from}->${message.to} copy ${copy + 1}`);
      this.inbound(message.to, message.update.slice());
    }
  }

  deliverFrom(from: ReplicaName, order: DeliveryOrder): void {
    const messages = this.pending.filter(message => message.from === from);
    if (order === "rev") messages.reverse();
    for (const message of messages) this.deliver(message.id, order === "dup" ? 2 : 1);
  }

  flush(order: DeliveryOrder): void {
    const messages = [...this.pending];
    if (order === "rev") messages.reverse();
    for (const message of messages) this.deliver(message.id, order === "dup" ? 2 : 1);
    if (this.pending.length > 0) throw new Error("Delivery echoed a remote update");
  }

  destroy(): void {
    for (const [name, listener] of this.listeners) this.replicas.get(name)?.doc.off("update", listener);
  }
}

export class ReplicaHarness {
  readonly identities = new IdentityBook();
  readonly alice: SchemaReplica;
  readonly bob: SchemaReplica;
  readonly queue: DeliveryQueue;
  readonly replicas: SchemaReplica[];

  constructor(candidate: SchemaCandidate, beats: readonly SeedBeat[], swapped = false) {
    const seed = new SchemaReplica(candidate, 10, this.identities);
    this.alice = new SchemaReplica(candidate, swapped ? 2 : 1, this.identities);
    this.bob = new SchemaReplica(candidate, swapped ? 1 : 2, this.identities);
    try {
      seed.seed(beats);
      const update = Y.encodeStateAsUpdate(seed.doc);
      Y.applyUpdate(this.alice.doc, update, "seed");
      Y.applyUpdate(this.bob.doc, update, "seed");
    } finally {
      seed.destroy();
    }
    this.replicas = [this.alice, this.bob];
    this.queue = new DeliveryQueue({ A: this.alice, B: this.bob });
  }

  lateJoin(source: SchemaReplica = this.alice): SchemaReplica {
    const carol = new SchemaReplica(source.candidate, 3, this.identities);
    Y.applyUpdate(carol.doc, Y.encodeStateAsUpdate(source.doc), "delivery");
    this.replicas.push(carol);
    this.queue.addReplica("C", carol);
    this.queue.history.push(`late-C full state from client ${source.doc.clientID}`);
    return carol;
  }

  destroy(): void {
    this.queue.destroy();
    for (const replica of this.replicas) replica.destroy();
  }
}
