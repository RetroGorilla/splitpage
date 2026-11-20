import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeReplaceAllRange, NativeUndoSelectionInput } from "../../../../src/adapters/collab/native/text-commands.ts";
import { compoundSeed, settleCompound } from "./compound-harness.ts";
import { noticeCopy, noticeDeliver, noticeRange } from "./notice-harness.ts";

type Copy = ReturnType<typeof noticeCopy>;
const range = (row: string, start: number, end: number, cell: NativeReplaceAllRange["cell"] = "narration") =>
  ({ row, cell, start, end });
const seed = compoundSeed({ A: "abcdefghi", B: "jklmno", C: "pqrst" }, { A: "12345" });

function single(copy: Copy, hit: NativeReplaceAllRange, text: string): void {
  assert.equal(copy.commands.replaceText(noticeRange(copy, hit.row, hit.cell, hit.start, hit.end),
    text ? [{ text, marks: {} }] : []).kind, "written");
}

test("replace all handles unsorted ranges, adjacent matches and separate cells in one transaction and undo step", t => {
  const writer = noticeCopy(seed, 2), peer = noticeCopy(seed, 3);
  t.after(() => { writer.close(); peer.close(); });
  let transactions = 0;
  writer.ydoc.on("afterTransaction", () => { transactions++; });
  const first = noticeRange(writer, "A", "narration", 1, 3);
  const result = writer.commands.replaceAll.withSelection(first, [
    range("A", 5, 6), range("A", 3, 5), range("A", 1, 3), range("B", 1, 4), range("A", 0, 4, "visual")
  ], "XYZ");
  assert.deepEqual(result.result, { kind: "written" });
  assert.equal(transactions, 1);
  result.recordAfter(noticeRange(writer, "A", "narration", 4));
  settleCompound(writer, peer, ["aXYZXYZXYZghi", "jXYZno", "pqrst"]);
  assert.equal(writer.document().rows[0]?.visualText, "XYZ5");
  assert.equal(peer.commands.typeText(noticeRange(peer, "C", "narration", 5), "!", {}).kind, "written");
  noticeDeliver(peer, writer);
  const undo = writer.commands.undo();
  assert.equal(undo.kind, "written");
  const target = { beat: "A", cell: "narration" };
  assert.deepEqual(undo.selection, { anchor: { target, offset: 1 }, head: { target, offset: 3 } });
  settleCompound(peer, writer, ["abcdefghi", "jklmno", "pqrst!"]);
  assert.equal(writer.document().rows[0]?.visualText, "12345");
  assert.deepEqual(writer.commands.undo(), { kind: "unchanged" });
  const redo = writer.commands.redo();
  assert.equal(redo.kind, "written");
  assert.deepEqual(redo.selection, { anchor: { target, offset: 4 }, head: { target, offset: 4 } });
  settleCompound(writer, peer, ["aXYZXYZXYZghi", "jXYZno", "pqrst!"]);
  assert.equal(writer.document().rows[0]?.visualText, "XYZ5");
});

test("replacement text has the same formatting as single unmarked replacement", t => {
  const rich = compoundSeed({ A: "<strong>abc</strong><em>def</em><a href=\"https://example.com\">ghi</a>", B: "next" },
    { A: "<strong>1234</strong>" });
  const batch = noticeCopy(rich, 2), manual = noticeCopy(rich, 2);
  t.after(() => { batch.close(); manual.close(); });
  const hits = [range("A", 7, 8), range("A", 3, 5), range("A", 1, 2), range("A", 1, 3, "visual")];
  assert.deepEqual(batch.commands.replaceAll(hits, "X"), { kind: "written" });
  for (const hit of hits) single(manual, hit, "X");
  assert.deepEqual(batch.document(), manual.document());
  assert.match(batch.document().rows[0]?.audioText ?? "", /<strong>a<\/strong>X<strong>c<\/strong>/);
});

test("invalid inputs refuse before writing any valid range", t => {
  const copy = noticeCopy(seed, 2), original = copy.encodeState();
  t.after(copy.close);
  const one = range("A", 1, 3);
  let called = 0;
  const getter = { ...one, get end() { called++; copy.close(); return 4; } };
  const listGetter = [one];
  Object.defineProperty(listGetter, "1", { get() { called++; return range("B", 1, 2); } });
  for (const ranges of [undefined, null, 1, {}, [one, null], [one, {}], [one, { ...one, row: 3 }],
    [one, { ...one, cell: "name" }], [one, { ...one, start: undefined }], [one, { ...one, end: undefined }],
    [one, { ...one, start: 1.5 }], [one, range("B", 3, 2)], [one, range("B", -1, 3)],
    [one, range("B", 0, 7)], [one, one], [one, range("A", 2, 5)], [one, getter], listGetter, new Array(2)]) {
    assert.deepEqual(copy.commands.replaceAll(ranges as NativeReplaceAllRange[], "X"), { kind: "refused", reason: "range" });
    assert.deepEqual(copy.encodeState(), original);
  }
  assert.deepEqual(copy.commands.replaceAll([one, range("absent", 0, 1)], "X"), { kind: "refused", reason: "missing" });
  for (const text of [undefined, null, 1, [], "\u0000", { get toString() { called++; return String; } }]) {
    assert.deepEqual(copy.commands.replaceAll([one], text as string), { kind: "refused", reason: "text" });
  }
  const oddSelection = { anchor: undefined, head: undefined } as unknown as NativeUndoSelectionInput;
  assert.deepEqual(copy.commands.replaceAll.withSelection(oddSelection, [one], "X").result,
    { kind: "refused", reason: "range" });
  assert.equal(called, 0);
  assert.deepEqual(copy.commands.replaceAll([], "X"), { kind: "unchanged" });
  assert.deepEqual(copy.commands.replaceAll([range("A", 1, 1)], ""), { kind: "unchanged" });
  assert.deepEqual(copy.encodeState(), original);
  assert.deepEqual(copy.commands.undo(), { kind: "unchanged" });
  const proxy = new Proxy([one], { ownKeys(source) { copy.close(); return Reflect.ownKeys(source); } });
  assert.deepEqual(copy.commands.replaceAll(proxy, "X"), { kind: "refused", reason: "closed" });
  assert.deepEqual(copy.encodeState(), original);
});

test("a batch uses shown offsets inside an assembled cell and refuses a split surrogate", t => {
  const source = compoundSeed({ A: "abc", B: "def", C: "g😀hi" });
  const writer = noticeCopy(source, 2), peer = noticeCopy(source, 3);
  t.after(() => { writer.close(); peer.close(); });
  assert.equal(writer.commands.removeRows(["A"]).kind, "written");
  assert.equal(peer.commands.typeText(noticeRange(peer, "A", "narration", 1), "uvw", {}).kind, "written");
  settleCompound(writer, peer, ["uvwdef", "g😀hi"]);
  const before = writer.encodeState();
  assert.deepEqual(writer.commands.replaceAll([range("B", 2, 4), range("C", 2, 3)], "X"), { kind: "refused", reason: "range" });
  assert.deepEqual(writer.encodeState(), before);
  assert.deepEqual(writer.commands.replaceAll([range("B", 2, 4), range("B", 5, 6)], "X"), { kind: "written" });
  settleCompound(peer, writer, ["uvXeX", "g😀hi"]);
});

for (const reverse of [false, true]) {
  for (const peerEdit of ["type", "remove"] as const) {
    test(`replace all against concurrent ${peerEdit}, ${reverse ? "peer" : "writer"} delivered first`, t => {
      const writer = noticeCopy(seed, 2), peer = noticeCopy(seed, 3);
      t.after(() => { writer.close(); peer.close(); });
      assert.deepEqual(writer.commands.replaceAll([range("A", 1, 4), range("B", 3, 5)], "X"), { kind: "written" });
      const other = peerEdit === "type" ? peer.commands.typeText(noticeRange(peer, "A", "narration", 2), "y", {})
        : peer.commands.removeRows(["A"]);
      assert.equal(other.kind, "written");
      const order = reverse ? [peer, writer] as const : [writer, peer] as const;
      const merged = peerEdit === "type" ? ["aXyefghi", "jklXo"] : ["XjklXo"];
      const undone = peerEdit === "type" ? ["abycdefghi", "jklmno"] : ["bcdjklmno"];
      settleCompound(...order, [...merged, "pqrst"]);
      assert.equal(writer.commands.undo().kind, "written");
      settleCompound(...order, [...undone, "pqrst"]);
      assert.equal(peer.commands.typeText(noticeRange(peer, "C", "narration", 5), "!", {}).kind, "written");
      noticeDeliver(peer, writer);
      assert.equal(writer.commands.redo().kind, "written");
      settleCompound(...order, [...merged, "pqrst!"]);
    });
  }
}

function generated(seedNumber: number, mute = false): void {
  const writer = noticeCopy(seed, 2), peer = noticeCopy(seed, 3);
  const start = seedNumber % 3, end = start + 1 + Math.floor(seedNumber / 3) % 3, other = 5 + seedNumber % 3;
  const word = seedNumber % 5 ? "X".repeat(seedNumber % 4 + 1) : "";
  const expectedA = "abcdefghi".slice(0, start) + word + "abcdefghi".slice(end, other) + word + "abcdefghi".slice(other + 1);
  const expectedB = word + "lmno";
  try {
    if (!mute) writer.commands.replaceAll([range("A", other, other + 1), range("B", 0, 2), range("A", start, end)], word);
    settleCompound(writer, peer, [expectedA, expectedB, "pqrst"]);
    assert.equal(peer.commands.typeText(noticeRange(peer, "C", "narration", 0), "p", {}).kind, "written");
    noticeDeliver(peer, writer);
    assert.equal(writer.commands.undo().kind, "written");
    settleCompound(peer, writer, ["abcdefghi", "jklmno", "ppqrst"]);
    assert.equal(writer.commands.redo().kind, "written");
    settleCompound(writer, peer, [expectedA, expectedB, "ppqrst"]);
  } finally { writer.close(); peer.close(); }
}

test("generated replace-all histories derive the changed cells from the issued ranges", () => {
  for (let seedNumber = 0; seedNumber < 36; seedNumber++) generated(seedNumber);
});

test("control: omitting replace all fails the issued narration check", () => {
  assert.throws(() => generated(0, true), /issued narration/);
});

test("generated mixed histories give each compound command its own undo step", () => {
  const empty = compoundSeed({});
  for (let turn = 0; turn < 12; turn++) {
    const writer = noticeCopy(empty, 2), peer = noticeCopy(empty, 3);
    try {
      const tail = String(turn), word = "X".repeat(1 + turn % 4);
      const first = writer.commands.createFirstBeat("abc" + tail);
      assert.equal(first.kind, "written");
      settleCompound(writer, peer, ["abc" + tail]);
      assert.equal(writer.commands.replaceAll([range(first.created, 0, 1), range(first.created, 2, 3)], word).kind, "written");
      settleCompound(peer, writer, [word + "b" + word + tail]);
      const selection = noticeRange(writer, first.created, "narration", word.length, word.length + 1);
      assert.equal(writer.commands.deleteAndSplit(selection).kind, "written");
      settleCompound(writer, peer, [word, word + tail]);
      for (const expected of [[word + "b" + word + tail], ["abc" + tail], []]) {
        assert.equal(writer.commands.undo().kind, "written");
        settleCompound(peer, writer, expected);
      }
      for (const expected of [["abc" + tail], [word + "b" + word + tail], [word, word + tail]]) {
        assert.equal(writer.commands.redo().kind, "written");
        settleCompound(writer, peer, expected);
      }
    } finally { writer.close(); peer.close(); }
  }
});
