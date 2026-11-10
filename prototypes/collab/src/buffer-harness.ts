import * as Y from "yjs";
import { DeliveryQueue } from "./delivery.ts";
import type { ReplicaName } from "./delivery.ts";
import { EditableBeatBuffer } from "./editing-buffer.ts";
import type { BufferMechanism } from "./editing-buffer.ts";
import { IdentityBook, checkModel } from "./model.ts";
import type { ScriptOracle } from "./model.ts";
import { readReplica } from "./reader.ts";
import { SchemaReplica } from "./schema.ts";
import type { SchemaCandidate, SeedBeat } from "./schema.ts";

export class BufferHarness {
  readonly identities = new IdentityBook();
  readonly alice: EditableBeatBuffer;
  readonly bob: EditableBeatBuffer;
  readonly queue: DeliveryQueue;
  readonly sessions = new Map<ReplicaName, EditableBeatBuffer>();
  private readonly timeline: string[] = [];
  private readonly candidate: SchemaCandidate;
  private readonly mechanism: BufferMechanism;

  constructor(candidate: SchemaCandidate, mechanism: BufferMechanism, beats: readonly SeedBeat[]) {
    this.candidate = candidate;
    this.mechanism = mechanism;
    const seed = new SchemaReplica(candidate, 10, this.identities);
    try {
      seed.seed(beats);
      const initial = Y.encodeStateAsUpdate(seed.doc);
      this.alice = this.createSession(1, initial);
      this.bob = this.createSession(2, initial);
    } finally {
      seed.destroy();
    }
    this.sessions.set("A", this.alice);
    this.sessions.set("B", this.bob);
    this.queue = new DeliveryQueue({ A: this.alice.network, B: this.bob.network }, (name, update) => {
      const session = this.sessions.get(name);
      if (!session) throw new Error(`Missing buffer session ${name}`);
      session.receive(update);
    }, line => this.timeline.push(`queue ${line}`));
  }

  private createSession(client: number, initial: Uint8Array): EditableBeatBuffer {
    const editor = new SchemaReplica(this.candidate, client, this.identities);
    Y.applyUpdate(editor.doc, initial, "seed");
    const record = (line: string): void => { this.timeline.push(`${client === 1 ? "A" : client === 2 ? "B" : "C"} ${line}`); };
    if (this.mechanism !== "M3") return new EditableBeatBuffer(editor, this.mechanism, editor, record);
    const network = new SchemaReplica(this.candidate, client + 100, this.identities);
    Y.applyUpdate(network.doc, initial, "seed");
    return new EditableBeatBuffer(editor, this.mechanism, network, record);
  }

  lateJoin(): void {
    const session = this.createSession(3, Y.encodeStateAsUpdate(this.bob.network.doc));
    this.sessions.set("C", session);
    this.queue.addReplica("C", session.network);
    this.queue.history.push("late-C full state from B's network document; no paint or identity cache transferred");
  }

  check(oracle: ScriptOracle): void {
    if (!this.alice.caret) throw new Error("Alice has no caret");
    const anchors = new Map([["A", this.alice.caret]]);
    for (const [name, session] of this.sessions) {
      checkModel(readReplica(session.editor.doc, this.candidate, this.identities, anchors), oracle, this.identities, `${name}.E`);
      if (session.editor !== session.network) checkModel(readReplica(session.network.doc, this.candidate, this.identities, anchors), oracle, this.identities, `${name}.N`);
    }
  }

  history(): string[] {
    return [...this.timeline];
  }

  destroy(): void {
    this.queue.destroy();
    for (const session of this.sessions.values()) {
      session.destroy();
      session.editor.destroy();
      if (session.editor !== session.network) session.network.destroy();
    }
  }
}
