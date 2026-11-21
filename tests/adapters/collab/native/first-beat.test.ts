import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { declareNativeRoots } from "../../../../src/adapters/collab/native/roots.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeUndoSelectionInput } from "../../../../src/adapters/collab/native/text-commands.ts";
import { compoundSeed, settleCompound } from "./compound-harness.ts";
import { noticeCopy, noticeDeliver, noticeRange } from "./notice-harness.ts";

test("first beat without narration uses one update and one undo step", t => {
  const copy = openNativeSession({ kind: "empty" }, { actor: "writer", sanitize: String });
  t.after(copy.close);
  const { commands } = copy, before = copy.encodeState();
  let updates = 0;
  copy.ydoc.on("update", () => { updates++; });
  for (const invalid of [null, 1, [], { toString() { assert.fail("unexpected coercion"); } }, "\u0000"]) {
    assert.deepEqual(commands.createFirstBeat(invalid as string), { kind: "refused", reason: "text" });
    assert.deepEqual(copy.encodeState(), before);
  }
  const oddSelection = { get anchor() { copy.close(); return undefined; }, head: undefined };
  assert.deepEqual(commands.createFirstBeat.withSelection(oddSelection as unknown as NativeUndoSelectionInput).result,
    { kind: "refused", reason: "range" });
  assert.deepEqual(copy.encodeState(), before);
  const first = commands.createFirstBeat();
  assert.equal(first.kind, "written");
  assert.equal(updates, 1);
  assert.deepEqual(copy.document().rows.map(row => [row.id, row.audioText]), [[first.created, ""]]);
  assert.deepEqual(commands.createFirstBeat("ignored"), { kind: "unchanged" });
  assert.equal(updates, 1);
  assert.equal(commands.undo().kind, "written");
  assert.deepEqual(copy.document().rows, []);
  assert.deepEqual(commands.undo(), { kind: "unchanged" });
  assert.equal(commands.redo().kind, "written");
  assert.equal(copy.document().rows[0]?.id, first.created);
});

test("first beat adopts rule (b) narration without moving the stored letters", t => {
  const seed = compoundSeed({ A: "old" }), writer = noticeCopy(seed, 2), peer = noticeCopy(seed, 3);
  t.after(() => { writer.close(); peer.close(); });
  assert.equal(writer.commands.removeRows(["A"]).kind, "written");
  assert.equal(peer.commands.typeText(noticeRange(peer, "A", "narration", 1), "stray", {}).kind, "written");
  settleCompound(writer, peer, ["stray"]);
  const roots = declareNativeRoots(writer.ydoc), segment = roots.order.get(0);
  const original = roots.segments.get(segment)?.get("text");
  assert.ok(original instanceof Y.Text);
  const first = writer.commands.createFirstBeat("new");
  assert.equal(first.kind, "written");
  settleCompound(peer, writer, ["straynew"]);
  assert.equal(writer.document().rows[0]?.id, first.created);
  assert.equal(roots.segments.get(segment)?.get("text"), original);
  assert.equal(original.toString(), "stray");
  assert.equal(writer.commands.undo().kind, "written");
  settleCompound(writer, peer, ["stray"]);
  assert.equal(writer.commands.redo().kind, "written");
  settleCompound(peer, writer, ["straynew"]);
});

function history(seed: number, mute = false): void {
  const state = compoundSeed({}), writer = noticeCopy(state, 2), peer = noticeCopy(state, 3);
  try {
    const a = `left${seed}`, b = `right${seed}`;
    if (!mute) writer.commands.createFirstBeat(a);
    const second = peer.commands.createFirstBeat(b);
    assert.equal(second.kind, "written");
    const order = seed % 2 ? [writer, peer] as const : [peer, writer] as const;
    settleCompound(...order, [a, b]);
    assert.equal(peer.commands.typeText(noticeRange(peer, second.created, "narration", b.length), "!", {}).kind, "written");
    noticeDeliver(peer, writer);
    assert.equal(writer.commands.undo().kind, "written");
    settleCompound(...order, [b + "!"]);
    assert.equal(writer.commands.redo().kind, "written");
    settleCompound(...order, [a, b + "!"]);
  } finally { writer.close(); peer.close(); }
}

test("generated first-beat races keep both texts in both delivery orders", () => {
  for (let seed = 0; seed < 12; seed++) history(seed);
});

test("control: omitting the first create fails the issued narration check", () => {
  assert.throws(() => history(0, true), /issued narration/);
});
