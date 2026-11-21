import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as Y from "yjs";
import { attachNativeLocalStore } from "../../../../src/adapters/collab/native/local-store.ts";
import { applyNativePeerUpdate } from "../../../../src/adapters/collab/native/peer-update.ts";
import { hasNativeFormat, openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { cells } from "./helpers.ts";
import { structureScript } from "./structure-harness.ts";

const options = { actor: "Writer", sanitize: String };
const target = { beat: "A", cell: "narration" } as const;
const refusal = { message: "The stored state is missing a Yjs update" };
type Session = ReturnType<typeof openNativeSession>;

function seed(t: TestContext): Session {
  const session = openNativeSession({
    kind: "document", document: structureScript({ A: "Hello", B: "World" }),
    conversion: { cells, creation: "seed", at: "2026-01-01", by: options.actor }
  }, options);
  t.after(session.close);
  return session;
}

function open(t: TestContext, state: Uint8Array): Session {
  const session = openNativeSession({ kind: "stored-script", state }, options);
  t.after(session.close);
  return session;
}

function range(session: Session, from: number, to = from) {
  const anchored = session.commands.anchorText(target, from, to);
  assert.equal(anchored.kind, "anchored");
  return anchored.range;
}

function append(session: Session, text: string): Uint8Array {
  const vector = Y.encodeStateVector(session.ydoc);
  const end = session.document().rows[0]?.audioText?.length;
  assert(typeof end === "number");
  assert.equal(session.commands.typeText(range(session, end), text, {}).kind, "written");
  return Y.encodeStateAsUpdate(session.ydoc, vector);
}

test("stored entry refuses an update missing the same writer's middle edit", t => {
  const writer = seed(t);
  const base = writer.encodeState();
  const middle = append(writer, "?");
  const tail = append(writer, "!");
  const gapped = Y.mergeUpdates([base, tail]);
  const complete = Y.mergeUpdates([base, tail, middle]);
  assert.equal(hasNativeFormat(gapped), false);
  assert.throws(() => open(t, gapped), refusal);
  assert.equal(hasNativeFormat(complete), true);
  assert.deepEqual(open(t, complete).document(), writer.document());
});

test("stored entry refuses a gap for a second writer and accepts both writers with the gap filled", t => {
  const writer = seed(t);
  const base = writer.encodeState();
  const peer = open(t, base);
  const middle = append(peer, "?");
  const tail = append(peer, "!");
  const local = append(writer, ".");
  assert.throws(() => open(t, Y.mergeUpdates([base, local, tail])), refusal);
  assert.equal(applyNativePeerUpdate(writer, Y.mergeUpdates([middle, tail])), true);
  assert.deepEqual(open(t, Y.mergeUpdates([base, tail, local, middle])).document(), writer.document());
});

test("stored entry applies deletions in a complete merged update", t => {
  const writer = seed(t);
  const base = writer.encodeState();
  const inserted = append(writer, "?");
  const vector = Y.encodeStateVector(writer.ydoc);
  assert.equal(writer.commands.deleteText(range(writer, 0, 1)).kind, "written");
  const deletion = Y.encodeStateAsUpdate(writer.ydoc, vector);
  assert.deepEqual(open(t, Y.mergeUpdates([base, inserted, deletion])).document(), writer.document());
});

test("stored entry refuses a delete set referencing a missing insert", t => {
  const writer = seed(t);
  const base = writer.encodeState();
  const inserted = append(writer, "?");
  const end = writer.document().rows[0]?.audioText?.length;
  assert(typeof end === "number");
  const vector = Y.encodeStateVector(writer.ydoc);
  assert.equal(writer.commands.deleteText(range(writer, end - 1, end)).kind, "written");
  const deletion = Y.encodeStateAsUpdate(writer.ydoc, vector);
  assert.throws(() => open(t, Y.mergeUpdates([base, deletion])), refusal);
  assert.deepEqual(open(t, Y.mergeUpdates([base, inserted, deletion])).document(), writer.document());
});

test("a reopened replica stays editable until its waiting peer update can integrate", async t => {
  const writer = seed(t);
  const base = writer.encodeState();
  const peer = open(t, base);
  const middle = append(peer, "?");
  const tail = append(peer, "!");
  const entries = [
    { generation: 1, checkpoint: true, bytes: base },
    { generation: 2, checkpoint: false, bytes: tail }
  ];
  const reopened = await attachNativeLocalStore({
    read: async () => entries, write: async entry => { entries.push(entry); },
    release: async () => {}, persistent: async () => true
  }, options);
  assert.equal(reopened.kind, "opened");
  t.after(async () => { reopened.session.close(); await reopened.closed; });
  assert.deepEqual(reopened.session.document(), writer.document());
  const local = append(reopened.session, " local");
  assert.equal(applyNativePeerUpdate(writer, local), true);
  assert.deepEqual(reopened.session.document(), writer.document());
  assert.deepEqual(await reopened.flush(), { kind: "stored", generation: 3 });
  assert.equal(applyNativePeerUpdate(reopened.session, middle), true);
  assert.equal(applyNativePeerUpdate(peer, local), true);
  assert.deepEqual(reopened.session.document(), peer.document());
  assert.deepEqual(await reopened.flush(), { kind: "stored", generation: 4 });
});

test("live peers and in-memory handoffs integrate a waiting edit when its missing update arrives", t => {
  const writer = seed(t);
  const receiver = open(t, writer.encodeState());
  const before = receiver.document();
  const middle = append(writer, "?");
  const tail = append(writer, "!");
  assert.equal(applyNativePeerUpdate(receiver, tail), true);
  assert.deepEqual(receiver.document(), before);
  const handoff = openNativeSession({ kind: "state", state: receiver.encodeState() }, options);
  t.after(handoff.close);
  for (const peer of [receiver, handoff]) {
    assert.equal(applyNativePeerUpdate(peer, middle), true);
    assert.deepEqual(peer.document(), writer.document());
  }
});
