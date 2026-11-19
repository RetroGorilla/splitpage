import * as Y from "yjs";

const swap = (from: Y.Doc, to: Y.Doc): void => { Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "remote"); };
const set = (doc: Y.Doc, value: string): void => { doc.transact(() => { doc.getMap("record").set("key", value); }, "local"); };
const read = (doc: Y.Doc): unknown => doc.getMap("record").get("key");

// why: one map key in a bare document, with the stock undo manager; Alice is client 1 and Bob client 2, so Bob's
// write wins when both set the key at once
function pair(ignoreRemoteMapChanges: boolean, start: string | null): { alice: Y.Doc; bob: Y.Doc; undoAlice: Y.UndoManager; undoBob: Y.UndoManager; both: () => void } {
  const alice = new Y.Doc(), bob = new Y.Doc();
  alice.clientID = 1; bob.clientID = 2;
  alice.transact(() => { const record = alice.getMap("record"); if (start !== null) record.set("key", start); }, "seed");
  swap(alice, bob);
  const manager = (doc: Y.Doc): Y.UndoManager => new Y.UndoManager(doc.getMap("record"), { trackedOrigins: new Set(["local"]), captureTimeout: 0, ignoreRemoteMapChanges });
  return { alice, bob, undoAlice: manager(alice), undoBob: manager(bob), both: () => { swap(alice, bob); swap(bob, alice); } };
}

export function raceThenUndo(ignoreRemoteMapChanges: boolean, undoer: "winner" | "loser", start: string | null = "start"): unknown[] {
  const p = pair(ignoreRemoteMapChanges, start);
  set(p.alice, "alice"); set(p.bob, "bob"); p.both();
  const settled = read(p.alice);
  (undoer === "winner" ? p.undoBob : p.undoAlice).undo();
  p.both();
  return [settled, read(p.alice), read(p.bob)];
}

export function seenThenUndo(ignoreRemoteMapChanges: boolean): unknown[] {
  const p = pair(ignoreRemoteMapChanges, "todo");
  set(p.alice, "ready"); p.both();
  set(p.bob, "done"); p.both();
  p.undoAlice.undo(); p.both();
  return [read(p.alice), read(p.bob)];
}
