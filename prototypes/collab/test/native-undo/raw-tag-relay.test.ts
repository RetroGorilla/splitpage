import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import * as Y from "yjs";

function rawCopy(client: number, start: Uint8Array, testContext: TestContext) {
  const doc = new Y.Doc();
  testContext.after(() => { doc.destroy(); });
  doc.clientID = client;
  Y.applyUpdate(doc, start);
  const updates: { update: Uint8Array; origin: unknown }[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => { updates.push({ update, origin }); });
  return { doc, text: doc.getText("t"), updates };
}

function settleRawCopies(docs: readonly Y.Doc[]): void {
  for (let round = 0; round < 6; round++) {
    const before = docs.map(doc => Buffer.from(Y.encodeStateAsUpdate(doc)));
    for (const from of docs) {
      for (const to of docs) {
        if (from !== to) Y.applyUpdate(to, Y.encodeStateAsUpdate(from), "remote");
      }
    }
    if (docs.every((doc, index) => before[index]?.equals(Y.encodeStateAsUpdate(doc)))) return;
  }
  assert.fail("Raw copies did not settle");
}

for (const scheme of ["plain", "per-application", "per-action"] as const) {
  test(`raw ${scheme} keys lose the tag when C receives redo before undo and relays the cleanup`, t => {
    const seed = new Y.Doc();
    t.after(() => { seed.destroy(); });
    seed.clientID = 900;
    seed.getText("t").insert(0, "vr");
    const start = Y.encodeStateAsUpdate(seed);
    for (const delivery of ["reverse", "forward", "merged", "reverse with C reading the event delta"] as const) {
      const a = rawCopy(1, start, t), b = rawCopy(2, start, t), c = rawCopy(3, start, t);
      const readsDelta = delivery === "reverse with C reading the event delta";
      if (readsDelta) c.text.observe(event => { void event.delta; });
      const manager = new Y.UndoManager(b.text, { trackedOrigins: new Set(["me"]), captureTimeout: 0 });
      const clock = Y.decodeStateVector(Y.encodeStateVector(b.doc)).get(b.doc.clientID) ?? 0;
      const key = scheme === "plain" ? "t:T1" : `t:T1\u001f${b.doc.clientID.toString(36)}.${clock.toString(36)}`;
      const tagged = [{ insert: "vr", attributes: { [key]: true } }], plain = [{ insert: "vr" }];
      const startMarker = (update: Uint8Array) => Y.decodeUpdate(update).structs.find(item =>
        item instanceof Y.Item && item.content instanceof Y.ContentFormat && item.content.key === key && item.content.value === true);

      b.doc.transact(() => { b.text.format(0, 2, { [key]: true }); }, "me");
      manager.stopCapturing();
      for (const copy of [a, c]) Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(b.doc), "remote");
      for (const { text } of [a, b, c]) assert.deepEqual(text.toDelta(), tagged, delivery);
      const originalStart = b.updates[0] && startMarker(b.updates[0].update);
      assert.ok(originalStart);
      const writerBaseline = b.updates.length;
      assert.ok(manager.undo());
      assert.ok(manager.redo());
      assert.deepEqual(b.text.toDelta(), tagged, delivery);
      const batch = b.updates.slice(writerBaseline).map(entry => entry.update);
      assert.equal(batch.length, 2, delivery);
      const redoStart = batch[1] && startMarker(batch[1]);
      assert.ok(redoStart);
      assert.notEqual(redoStart.id.clock, originalStart.id.clock);

      const relayBaseline = c.updates.length;
      if (delivery === "merged") Y.applyUpdate(c.doc, Y.mergeUpdates(batch), "remote");
      else for (const update of delivery === "forward" ? batch : [...batch].reverse()) Y.applyUpdate(c.doc, update, "remote");
      const cleanup = c.updates.slice(relayBaseline).filter(entry => entry.origin === null);
      const deletedStart = readsDelta ? originalStart : redoStart;
      const deletes = cleanup.map(({ update }) => [...Y.decodeUpdate(update).ds.clients].map(([client, ranges]) =>
        [client, ranges.map(({ clock, len }) => [clock, len])]));
      assert.deepEqual(deletes, delivery === "reverse" || readsDelta ? [[[deletedStart.id.client, [[deletedStart.id.clock, 1]]]]] : [], delivery);

      const expected = delivery === "reverse" ? plain : tagged;
      assert.deepEqual(c.text.toDelta(), expected, delivery);
      for (const { update } of cleanup) Y.applyUpdate(a.doc, update, "remote");
      for (const update of batch) Y.applyUpdate(a.doc, update, "remote");
      assert.deepEqual(a.text.toDelta(), expected, delivery);
      settleRawCopies([a.doc, b.doc, c.doc]);
      for (const { text } of [a, b, c]) assert.deepEqual(text.toDelta(), expected, delivery);
    }
  });
}
