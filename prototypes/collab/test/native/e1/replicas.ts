import assert from "node:assert/strict";
import * as Y from "yjs";

export const ARRIVED = "arrived";

export interface Replica {
  readonly doc: Y.Doc;
  readonly log: Uint8Array[];
  readonly origin: { readonly replica: number };
  readonly undo: Y.UndoManager;
}

export interface Room {
  readonly replicas: readonly Replica[];
  send: (from: Replica, to: Replica, only?: number) => void;
  sync: () => void;
  late: () => Y.Doc;
  close: () => void;
}

// why: every update goes into its writer's log, also the formatting clean-up a copy runs after remote formatting
export type UndoScope = ConstructorParameters<typeof Y.UndoManager>[0];

export function room(clients: readonly number[], build: (doc: Y.Doc) => void, scope: (doc: Y.Doc) => UndoScope = doc => doc.getText("t"), captureTimeout = 0): Room {
  const seed = new Y.Doc();
  seed.clientID = 100;
  build(seed);
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  const sent = new Map<string, number>();
  const replicas = clients.map(client => {
    const doc = new Y.Doc();
    doc.clientID = client;
    Y.applyUpdate(doc, seedUpdate, ARRIVED);
    const origin = { replica: client }, log: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array, from: unknown) => { if (from !== ARRIVED) log.push(update); });
    const undo = new Y.UndoManager(scope(doc), {
      trackedOrigins: new Set([origin]),
      captureTimeout,
      deleteFilter: item => {
        if (!(item.content instanceof Y.ContentType)) return true;
        const type = item.content.type;
        return type instanceof Y.Text ? type.length === 0 : type instanceof Y.Map ? type.size === 0 : true;
      }
    });
    return { doc, log, origin, undo };
  });
  const lates: Y.Doc[] = [];
  return {
    replicas,
    send(from, to, only) {
      if (only !== undefined) { Y.applyUpdate(to.doc, from.log[only] as Uint8Array, ARRIVED); return; }
      const key = `${from.doc.clientID}>${to.doc.clientID}`;
      for (const update of from.log.slice(sent.get(key) ?? 0)) Y.applyUpdate(to.doc, update, ARRIVED);
      sent.set(key, from.log.length);
    },
    sync() {
      for (let round = 0; round < 4; round++) {
        for (const from of replicas) for (const to of replicas) if (from !== to) this.send(from, to);
      }
    },
    late() {
      const doc = new Y.Doc();
      doc.clientID = 999;
      const updates = [seedUpdate, ...replicas.flatMap(replica => replica.log)].reverse();
      for (const update of updates) Y.applyUpdate(doc, update, ARRIVED);
      lates.push(doc);
      return doc;
    },
    close() {
      for (const replica of replicas) { replica.undo.destroy(); replica.doc.destroy(); }
      for (const doc of lates) doc.destroy();
    }
  };
}

export function shown(text: Y.Text): string {
  return (text.toDelta() as { insert: unknown }[]).map(step => {
    if (typeof step.insert === "string") return step.insert;
    const embed = step.insert as Record<string, string>;
    return "b" in embed ? `|${embed.b}|` : `[${embed.k ?? "?"}]`;
  }).join("");
}

export function bold(text: Y.Text): string {
  return (text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]).filter(step => step.attributes?.b === true).map(step => typeof step.insert === "string" ? step.insert : "*").join("");
}

export function agreed(room: Room, read: (doc: Y.Doc) => string): string {
  room.sync();
  const all = [...room.replicas.map(replica => read(replica.doc)), read(room.late())];
  assert.equal(new Set(all).size, 1, `copies disagree: ${all.join(" | ")}`);
  return all[0] as string;
}

export const text = (doc: Y.Doc): Y.Text => doc.getText("t");
export const local = (replica: Replica, change: () => void): void => replica.doc.transact(change, replica.origin);
