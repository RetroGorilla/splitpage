import assert from "node:assert/strict";
import { IdentityBook } from "../../../collab/checker.ts";
import { assertReplicasAgree } from "../../../collab/agreement.ts";
import type { DeliveryOrder } from "../../../collab/delivery.ts";
import type { DeliveryReplica } from "../../../collab/delivery.ts";
import { ScratchReplica } from "./designs.ts";
import type { ScratchCommand, ScratchDesign } from "./designs.ts";
import { ScratchModel } from "./model.ts";
import type { ScratchExpectedCharacter } from "./model.ts";

interface ScratchMessage { from: number; to: number; update: Uint8Array; known: string[] }
export class ScratchHistory {
  readonly replicas: ScratchReplica[];
  readonly known: Set<string>[];
  readonly model: ScratchModel;
  readonly book = new IdentityBook();
  readonly pending: ScratchMessage[] = [];
  readonly ports: DeliveryReplica<Uint8Array>[] = [];
  readonly commands: { writer: number; command: ScratchCommand; observed: string[]; selected: string[]; before: string | null; after: string | null; position?: number }[] = [];
  readonly detaches: (() => void)[] = [];
  deliveries = 0;
  checkpoints = 0;
  sequential = 0;
  selective = 0;
  afterJoin = 0;
  early = false;
  checkLocal = true;
  readonly design: ScratchDesign;
  readonly order: DeliveryOrder;
  readonly writers: number;

  constructor(design: ScratchDesign, order: DeliveryOrder, writers: number, initial: string) {
    this.design = design; this.order = order; this.writers = writers;
    const first = new ScratchReplica(design, 1, initial);
    this.replicas = [first, ...Array.from({ length: writers - 1 }, (_, index) => new ScratchReplica(design, index + 2, undefined, first.state()))];
    this.known = this.replicas.map(() => new Set<string>());
    this.model = new ScratchModel(initial);
    for (let index = 0; index < initial.length; index++) this.book.bind("s" + index, first.identity(index));
    this.replicas.forEach(replica => this.attach(replica));
  }

  execute(writer: number, command: ScratchCommand, insertionPosition?: number): void {
    const replica = this.replicas[writer], known = this.known[writer];
    if (!replica || !known) throw new Error("Missing writer");
    assert.equal(replica.text.toString(), this.model.characters(known).map(char => char.value).join(""), "local text before command");
    const characters = this.model.characters(known), selected = characters.slice(command.from, command.to).map(char => char.id);
    const before = characters[command.from - 1]?.id ?? null, after = characters[command.to]?.id ?? null;
    const observed = [...known].sort(), inserted = this.model.add(command, known, insertionPosition);
    known.add(command.id);
    replica.execute(command);
    inserted.forEach((id, index) => this.book.bind(id, replica.identity(command.from + index)));
    this.commands.push({ writer, command, observed, selected, before, after, ...(insertionPosition === undefined ? {} : { position: insertionPosition }) });
    if (this.checkLocal) this.check(writer);
    if (this.order === "D2") { this.flush(); this.sequential++; this.checkpoint(); }
  }

  prepare(writer: number): void {
    if (this.order === "D3" && writer === 0 && this.commands.length) { this.deliverFrom(1); this.selective++; }
  }

  flush(): void {
    for (let round = 0; round < 100; round++) {
      const messages = [...this.pending];
      if (this.order === "rev") messages.reverse();
      for (const message of messages) this.deliver(message);
      if (!this.pending.length) return;
    }
    throw new Error("Scratch delivery did not settle");
  }

  joinEarly(): void {
    if (this.order !== "late-C" || this.early) return;
    this.flush(); this.checkpoint(); this.join(); this.early = true;
  }

  finish(): ScratchExpectedCharacter[] {
    this.flush(); this.checkpoint();
    if (!this.early) this.join();
    this.flush();
    const output = this.expected(0);
    const readings = this.replicas.map((replica, index) => ({ order: index === this.writers ? "late-C" as const : this.order === "late-C" ? "D1" as const : this.order,
      replica: index === this.writers ? "C" as const : index === 0 ? "A" as const : "B" as const, output: replica.readNamed(this.book) }));
    assertReplicasAgree("scratch final", [{ order: "D1", replica: "A", output }, ...readings]);
    return output;
  }

  expected(writer: number): ScratchExpectedCharacter[] { return this.model.read(this.known[writer] ?? new Set()); }
  private check(writer: number): void {
    const actual = this.replicas[writer]?.readNamed(this.book), expected = this.expected(writer);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    const at = expected.findIndex((char, index) => JSON.stringify(char) !== JSON.stringify(actual?.[index]));
    const replica = this.replicas[writer];
    const coverage = replica?.contributions().filter(item => item.from <= at && item.to > at).map(item => ({ op: item.event.operation, type: item.event.type, from: item.from, to: item.to, observed: item.event.observed, born: item.event.born }));
    throw new Error("independent rule writer=" + writer + " at=" + at + " actual=" + JSON.stringify(actual?.[at]) + " expected=" + JSON.stringify(expected[at]) + " command=" + JSON.stringify(this.commands.at(-1)) + " coverage=" + JSON.stringify(coverage));
  }
  checkpoint(): void {
    for (let index = 0; index < this.replicas.length; index++) this.check(index);
    const first = this.replicas[0]; if (!first) throw new Error("Missing first");
    const reload = new ScratchReplica(this.design, 100 + this.checkpoints, undefined, first.state());
    try {
      assertReplicasAgree("scratch settled point", [{ order: "D1", replica: "A", output: this.expected(0) },
        ...this.replicas.map((replica, index) => ({ order: "D1" as const, replica: index === 0 ? "A" as const : "B" as const, output: replica.readNamed(this.book) })),
        { order: "late-C", replica: "C", output: reload.readNamed(this.book) }]);
    } finally { reload.destroy(); }
    this.checkpoints++;
  }
  destroy(): void { this.detaches.forEach(detach => detach()); this.replicas.forEach(replica => replica.destroy()); }

  private attach(replica: ScratchReplica): void {
    const from = this.ports.length, port = replica.queuePort(); this.ports.push(port);
    this.detaches.push(port.onLocalUpdate(update => {
      for (let to = 0; to < this.ports.length; to++) if (to !== from) this.pending.push({ from, to, update: update.slice(), known: [...this.known[from] ?? []] });
    }));
  }
  private join(): void {
    const first = this.replicas[0]; if (!first) throw new Error("Missing first");
    const replica = new ScratchReplica(this.design, 90, undefined, first.state());
    this.replicas.push(replica); this.known.push(new Set(this.known[0])); this.attach(replica);
  }
  private deliverFrom(from: number): void { for (const message of this.pending.filter(item => item.from === from)) this.deliver(message); }
  private deliver(message: ScratchMessage): void {
    const port = this.ports[message.to], known = this.known[message.to]; if (!port || !known) throw new Error("Missing recipient");
    this.pending.splice(this.pending.indexOf(message), 1);
    for (let copy = 0; copy < (this.order === "dup" ? 2 : 1); copy++) {
      message.known.forEach(id => known.add(id)); port.apply(message.update); this.deliveries++; if (this.early && message.to === this.writers) this.afterJoin++;
      port.afterDelivery?.();
    }
  }
}
