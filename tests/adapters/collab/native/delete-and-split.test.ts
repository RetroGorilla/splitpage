import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeTextRange } from "../../../../src/adapters/collab/native/text-commands.ts";
import { compoundSeed, settleCompound } from "./compound-harness.ts";
import { noticeCopy, noticeDeliver, noticeRange } from "./notice-harness.ts";

const compound = compoundSeed({ A: "abcdef", B: "next" }, { A: "visual" });
type Copy = ReturnType<typeof noticeCopy>;
const at = (copy: Copy, from: number, to = from) => noticeRange(copy, "A", "narration", from, to);

test("delete and split matches the two individual commands and replays selection in one undo step", t => {
  const writer = noticeCopy(compound, 2), sequential = noticeCopy(compound, 2), peer = noticeCopy(compound, 3);
  t.after(() => { writer.close(); sequential.close(); peer.close(); });
  let transactions = 0;
  writer.ydoc.on("afterTransaction", () => { transactions++; });
  const before = at(writer, 1, 4), command = writer.commands.deleteAndSplit.withSelection(before, before);
  assert.equal(command.result.kind, "written");
  assert.equal(transactions, 1);
  const { created } = command.result;
  command.recordAfter(noticeRange(writer, created, "narration", 0));
  assert.equal(sequential.commands.deleteText(at(sequential, 1, 4)).kind, "written");
  assert.deepEqual(sequential.commands.splitRow(at(sequential, 1)), command.result);
  assert.deepEqual(writer.document(), sequential.document());
  assert.deepEqual(writer.encodeState(), sequential.encodeState());
  settleCompound(writer, peer, ["a", "ef", "next"]);
  assert.equal(peer.commands.typeText(noticeRange(peer, "B", "narration", 4), "!", {}).kind, "written");
  noticeDeliver(peer, writer);
  const undo = writer.commands.undo();
  assert.equal(undo.kind, "written");
  assert.deepEqual(undo.selection, {
    anchor: { target: { beat: "A", cell: "narration" }, offset: 1 },
    head: { target: { beat: "A", cell: "narration" }, offset: 4 }
  });
  settleCompound(peer, writer, ["abcdef", "next!"]);
  assert.deepEqual(writer.commands.undo(), { kind: "unchanged" });
  const redo = writer.commands.redo();
  assert.equal(redo.kind, "written");
  const point = { target: { beat: created, cell: "narration" }, offset: 0 };
  assert.deepEqual(redo.selection, { anchor: point, head: point });
  settleCompound(writer, peer, ["a", "ef", "next!"]);
});

test("odd and stale selections refuse atomically, including the withSelection argument", t => {
  const copy = noticeCopy(compound, 2), peer = noticeCopy(compound, 3);
  t.after(() => { copy.close(); peer.close(); });
  const valid = at(copy, 1, 4), state = copy.encodeState();
  let reads = 0;
  const getter = { ...valid, get to() { reads++; copy.close(); return valid.to; } };
  for (const input of [undefined, null, 0, [], at(copy, 2), getter, { ...valid, seen: undefined },
    { ...valid, target: { ...valid.target, beat: undefined } }, { ...valid, from: { ...valid.from, item: undefined } },
    { ...valid, target: { ...valid.target, beat: "B" } }, noticeRange(copy, "A", "visual", 1, 2)]) {
    assert.deepEqual(copy.commands.deleteAndSplit(input as NativeTextRange), { kind: "refused", reason: "range" });
    assert.deepEqual(copy.encodeState(), state);
  }
  for (const input of [undefined, 0, getter, { anchor: valid, head: undefined }]) {
    assert.deepEqual(copy.commands.deleteAndSplit.withSelection(input as NativeTextRange, valid).result,
      { kind: "refused", reason: "range" });
  }
  assert.equal(reads, 0);
  assert.deepEqual(copy.encodeState(), state);
  assert.equal(peer.commands.splitRow(at(peer, 2)).kind, "written");
  noticeDeliver(peer, copy);
  const afterPeer = copy.encodeState();
  assert.deepEqual(copy.commands.deleteAndSplit(valid), { kind: "refused", reason: "range" });
  assert.deepEqual(copy.encodeState(), afterPeer);
  assert.deepEqual(copy.commands.undo(), { kind: "unchanged" });
});

test("a selection proxy that closes the session leaves the serialized state alone", t => {
  const copy = noticeCopy(compound, 2), valid = at(copy, 1, 4), state = copy.encodeState();
  t.after(copy.close);
  const closing = new Proxy(valid, { ownKeys(target) { copy.close(); return Reflect.ownKeys(target); } });
  assert.deepEqual(copy.commands.deleteAndSplit(closing), { kind: "refused", reason: "closed" });
  assert.deepEqual(copy.encodeState(), state);
});

for (const reverse of [false, true]) {
  for (const peerEdit of ["type", "split"] as const) {
    test(`delete and split against concurrent ${peerEdit}, ${reverse ? "peer" : "writer"} delivered first`, t => {
      const writer = noticeCopy(compound, 2), peer = noticeCopy(compound, 3);
      t.after(() => { writer.close(); peer.close(); });
      const result = writer.commands.deleteAndSplit(at(writer, 1, 4));
      assert.equal(result.kind, "written");
      const other = peerEdit === "type" ? peer.commands.typeText(at(peer, 2), "x", {}) : peer.commands.splitRow(at(peer, 2));
      assert.equal(other.kind, "written");
      const order = reverse ? [peer, writer] as const : [writer, peer] as const;
      const merged = peerEdit === "type" ? ["ax", "ef"] : ["a", "", "ef"];
      const undone = peerEdit === "type" ? ["abxcdef"] : ["ab", "cdef"];
      settleCompound(...order, [...merged, "next"]);
      assert.equal(writer.commands.undo().kind, "written");
      settleCompound(...order, [...undone, "next"]);
      assert.equal(peer.commands.typeText(noticeRange(peer, "B", "narration", 4), "!", {}).kind, "written");
      noticeDeliver(peer, writer);
      assert.equal(writer.commands.redo().kind, "written");
      settleCompound(...order, [...merged, "next!"]);
    });
  }
}

function generated(seed: number, mute = false): void {
  const writer = noticeCopy(compound, 2), peer = noticeCopy(compound, 3);
  const from = seed % 6, to = from + 1 + (Math.floor(seed / 6) % (6 - from));
  try {
    if (!mute) writer.commands.deleteAndSplit(at(writer, from, to));
    const retained = ["abcdef".slice(0, from), "abcdef".slice(to)];
    settleCompound(writer, peer, [...retained, "next"]);
    assert.equal(peer.commands.typeText(noticeRange(peer, "B", "narration", 0), "p", {}).kind, "written");
    noticeDeliver(peer, writer);
    assert.equal(writer.commands.undo().kind, "written");
    settleCompound(peer, writer, ["abcdef", "pnext"]);
    assert.equal(writer.commands.redo().kind, "written");
    settleCompound(writer, peer, [...retained, "pnext"]);
  } finally { writer.close(); peer.close(); }
}

test("generated delete and split histories model the removed selection and both retained slices", () => {
  for (let seed = 0; seed < 36; seed++) generated(seed);
});

test("control: omitting delete and split fails the issued narration check", () => {
  assert.throws(() => generated(0, true), /issued narration/);
});
