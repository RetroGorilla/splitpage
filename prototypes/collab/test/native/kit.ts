import * as Y from "yjs";
import { NativeReplica, nativeCopy, nativeMarkName } from "../../src/native/variant.ts";
import type { NativeDeltaItem, NativeScheme } from "../../src/native/variant.ts";

export interface KitRow { id: string; audioText: string; visualText?: string; [field: string]: unknown }
export type KitOrder = "forward" | "reverse" | "twice";

export function start(rows: readonly KitRow[], count = 2, scheme: NativeScheme = "name", captureTimeout = 0): NativeReplica[] {
  const seed = new NativeReplica(900, 0, scheme);
  seed.hydrate({ rows: rows.map(row => ({ visualText: "", ...row })) });
  return Array.from({ length: count }, (_, index) => nativeCopy(seed, index + 1, captureTimeout));
}

// why: `a[bc|b,t:P]d` reads as: bc carries bold and tag P; an inline atom prints as ￼
export function marked(delta: readonly NativeDeltaItem[]): string {
  const parts: { text: string; names: string }[] = [];
  for (const item of delta) {
    const names = [...new Set(Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => nativeMarkName(key)))].sort().join(",");
    const text = typeof item.insert === "string" ? item.insert : "￼", last = parts.at(-1);
    if (last?.names === names) last.text += text; else parts.push({ text, names });
  }
  return parts.map(part => part.names ? `[${part.text}|${part.names}]` : part.text).join("");
}

export function show(replica: NativeReplica): string[] {
  return replica.rows().map(row => `${row.id}: ${marked(row.audio)}${row.visual.length ? ` / ${marked(row.visual)}` : ""}`);
}

export function recovered(replica: NativeReplica): string[] {
  return replica.recovery().map(item => `${item.beat}: ${item.kept}${item.unseen.length ? ` (unseen: ${item.unseen.join(",")})` : ""}${item.visual ? ` / ${item.visual}` : ""}`);
}

export function type(replica: NativeReplica, beat: string, at: number, text: string, field: "audioText" | "visualText" = "audioText"): void {
  replica.splice(beat, field, at, at, [{ text, marks: {} }]);
  replica.changes();
}

export function cut(replica: NativeReplica, beat: string, from: number, to: number): void {
  replica.splice(beat, "audioText", from, to, []);
  replica.changes();
}

// why: every update a copy makes itself is sent, also the clean-up the library runs after remote formatting arrives
export class KitNet {
  private readonly logs = new Map<NativeReplica, Uint8Array[]>();
  private readonly read = new Map<string, number>();
  readonly replicas: NativeReplica[];

  constructor(replicas: NativeReplica[]) {
    this.replicas = replicas;
    for (const replica of replicas) this.join(replica);
  }

  private join(replica: NativeReplica): void {
    const log: Uint8Array[] = [];
    this.logs.set(replica, log);
    replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") log.push(update); });
  }

  pending(from: NativeReplica, to: NativeReplica): number {
    return (this.logs.get(from)?.length ?? 0) - (this.read.get(`${from.doc.clientID}>${to.doc.clientID}`) ?? 0);
  }

  deliver(from: NativeReplica, to: NativeReplica, order: KitOrder = "forward"): void {
    const key = `${from.doc.clientID}>${to.doc.clientID}`, log = this.logs.get(from) ?? [], updates = log.slice(this.read.get(key) ?? 0);
    this.read.set(key, log.length);
    const sequence = order === "reverse" ? [...updates].reverse() : order === "twice" ? [...updates, ...updates] : updates;
    for (const update of sequence) Y.applyUpdate(to.doc, update, "remote");
    to.changes();
  }

  settle(order: KitOrder = "forward"): void {
    for (let round = 0; round < 8; round++) {
      let moved = false;
      for (const from of this.replicas) for (const to of this.replicas) {
        if (from === to || this.pending(from, to) === 0) continue;
        this.deliver(from, to, order); moved = true;
      }
      if (!moved) return;
    }
    throw new Error("The copies never settled");
  }

  // why: a copy that joins from the stored state alone must read what the others read
  late(scheme: NativeScheme = "name"): NativeReplica {
    const source = this.replicas[0];
    if (!source) throw new Error("No copy to join from");
    const replica = new NativeReplica(800 + this.replicas.length, 0, scheme);
    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(source.doc), "remote");
    replica.changes();
    return replica;
  }

  agree(scheme: NativeScheme = "name"): string[] {
    const all = [...this.replicas, this.late(scheme)], first = JSON.stringify([show(all[0] as NativeReplica), recovered(all[0] as NativeReplica)]);
    for (const replica of all) {
      const other = JSON.stringify([show(replica), recovered(replica)]);
      if (other !== first) throw new Error(`Copies differ: ${first} / ${other}`);
    }
    return show(all[0] as NativeReplica);
  }
}
