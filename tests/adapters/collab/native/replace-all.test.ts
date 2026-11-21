import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { deleteRange, replaceText, sliceCell } from "../../../../src/core/text/edits.ts";
import { cellLength } from "../../../../src/core/text/runs.ts";
import { scriptCellOf } from "../../../../src/bootstrap/richtext.ts";
import type { NativeReplaceAllRange, NativeUndoSelectionInput } from "../../../../src/adapters/collab/native/text-commands.ts";
import { compoundSeed, settleCompound } from "./compound-harness.ts";
import { noticeCopy, noticeDeliver, noticeRange } from "./notice-harness.ts";

type Copy = ReturnType<typeof noticeCopy>;
const range = (row: string, start: number, end: number, cell: NativeReplaceAllRange["cell"] = "narration") =>
  ({ row, cell, start, end });
const seed = compoundSeed({ A: "abcdefghi", B: "jklmno", C: "pqrst" }, { A: "12345" });

function single(copy: Copy, hit: NativeReplaceAllRange, text: string): void {
  const { row, cell, start, end } = hit;
  const current = copy.document().rows.find(item => item.id === row);
  const source = scriptCellOf(cell === "visual" ? current?.visualText : current?.audioText);
  const next = replaceText(source, start, end, text);
  const length = cellLength(next) - cellLength(deleteRange(source, start, end));
  assert.equal(copy.commands.replaceText(noticeRange(copy, row, cell, start, end),
    sliceCell(next, start, start + length)).kind, "written");
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

test("replacement keeps the marks of each match's first character, as single Find Replace does", t => {
  const tag = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="mug" contenteditable="false">';
  const link = '<a href="https://example.com/" target="_blank" rel="noopener">';
  const rich = compoundSeed({
    A: "<strong>cup</strong><em>cup</em>",
    B: "<strong>cu</strong>p c<strong>up</strong>",
    C: link + "scups</a>",
    D: tag + "scups</span>",
    E: '<span class="cmt-anchor" data-cmt="c1"><u><em>cu</em></u></span>p',
    F: link + "cu</a>p c" + link + "up</a>",
    G: tag + "cu</span>p c" + tag + "up</span>"
  }, { A: "<strong>1234</strong>" });
  const batch = noticeCopy(rich, 2), manual = noticeCopy(rich, 2), peer = noticeCopy(rich, 3);
  t.after(() => { batch.close(); manual.close(); peer.close(); });
  const before = batch.document();
  const hits = [range("A", 3, 6), range("A", 0, 3), range("B", 4, 7), range("B", 0, 3),
    range("C", 1, 4), range("D", 1, 4), range("E", 0, 3), range("F", 4, 7), range("F", 0, 3),
    range("G", 4, 7), range("G", 0, 3), range("A", 1, 3, "visual")];
  let updates = 0;
  batch.ydoc.on("update", () => { updates++; });
  assert.deepEqual(batch.commands.replaceAll(hits, "teacup"), { kind: "written" });
  assert.equal(updates, 1);
  for (const hit of hits) single(manual, hit, "teacup");
  const expected = ["<strong>teacup</strong><em>teacup</em>", "<strong>teacup</strong> teacup",
    link + "steacups</a>", tag + "steacups</span>", '<span class="cmt-anchor" data-cmt="c1"><em><u>teacup</u></em></span>',
    link + "teacup</a> teacup", tag + "teacup</span> teacup"];
  settleCompound(batch, peer, expected);
  assert.deepEqual(batch.document(), manual.document());
  assert.equal(batch.document().rows[0]?.visualText, "<strong>1teacup4</strong>");
  assert.equal(batch.commands.undo().kind, "written");
  settleCompound(batch, peer, before.rows.map(row => row.audioText ?? ""));
  assert.deepEqual(batch.document(), before);
  assert.deepEqual(batch.commands.undo(), { kind: "unchanged" });
  assert.equal(batch.commands.redo().kind, "written");
  settleCompound(batch, peer, expected);
  assert.deepEqual(batch.document(), manual.document());
});

test("invalid inputs refuse before writing any valid range", t => {
  const copy = noticeCopy(seed, 2), original = copy.encodeState();
  t.after(copy.close);
  const one = range("A", 1, 3);
  let called = 0;
  const getter = { ...one, get end() { called++; copy.close(); return 4; } };
  const listGetter = [one];
  Object.defineProperty(listGetter, "1", { get() { called++; return range("B", 1, 2); } });
  const nonplainList = Object.setPrototypeOf([one], {}), nonplainRange = Object.setPrototypeOf({ ...one }, {});
  for (const ranges of [undefined, null, 1, {}, nonplainList, [nonplainRange], [one, null], [one, {}],
    [one, { ...one, extra: 1 }], [one, { ...one, row: 3 }],
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

test("replace all validates the single snapshot when a range list grows or shrinks during its length read", t => {
  const first = range("A", 1, 3), second = range("B", 1, 3);
  for (const change of ["grow", "grow with original length", "shrink"] as const) {
    const copy = noticeCopy(seed, 2), state = copy.encodeState();
    t.after(copy.close);
    const list = change === "shrink" ? [first, second] : [first];
    let changed = false;
    const changing = new Proxy(list, {
      getOwnPropertyDescriptor(source, key) {
        if (key === "length" && !changed) {
          changed = true;
          const original = Reflect.getOwnPropertyDescriptor(source, key);
          if (change === "shrink") source.length = 0;
          else source.push(second);
          if (change === "grow with original length") return original;
        }
        return Reflect.getOwnPropertyDescriptor(source, key);
      }
    });
    const result = copy.commands.replaceAll(changing, "X");
    assert.equal(changed, true);
    if (change === "grow with original length") {
      assert.deepEqual(result, { kind: "written" });
      assert.deepEqual(copy.document().rows.map(row => row.audioText), ["aXdefghi", "jklmno", "pqrst"]);
      assert.equal(copy.commands.undo().kind, "written");
      assert.deepEqual(copy.document().rows.map(row => row.audioText), ["abcdefghi", "jklmno", "pqrst"]);
    } else {
      assert.deepEqual(result, { kind: "refused", reason: "range" });
      assert.deepEqual(copy.encodeState(), state);
      assert.deepEqual(copy.commands.undo(), { kind: "unchanged" });
    }
  }
});

for (const growing of [true, false]) {
  test(`replace all reads the range-list keys once when another read would ${growing ? "grow" : "shrink"} it`, t => {
    const copy = noticeCopy(seed, 2), first = range("A", 1, 3), second = range("B", 1, 3);
    t.after(copy.close);
    let reads = 0;
    const list = new Proxy(growing ? [first] : [first, second], {
      ownKeys(source) {
        const keys = Reflect.ownKeys(source);
        if (++reads === 2) {
          if (growing) source.push(second); else source.pop();
        }
        return keys;
      }
    });
    assert.deepEqual(copy.commands.replaceAll(list, "X"), { kind: "written" });
    assert.equal(reads, 1);
    assert.deepEqual(copy.document().rows.map(row => row.audioText), ["aXdefghi", growing ? "jklmno" : "jXmno", "pqrst"]);
  });
}

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
  for (const on of [true, false]) {
    test(`replace all and concurrent ${on ? "bold" : "unbold"} converge, ${reverse ? "peer" : "writer"} delivered first`, t => {
      const source = compoundSeed({ A: on ? "cup <em>cup</em>" : "<strong>cup</strong> <em>cup</em>" });
      const writer = noticeCopy(source, 2), peer = noticeCopy(source, 3);
      t.after(() => { writer.close(); peer.close(); });
      assert.equal(writer.commands.replaceAll([range("A", 0, 3), range("A", 4, 7)], "mug").kind, "written");
      assert.equal(peer.commands.formatText(noticeRange(peer, "A", "narration", 0, 3),
        { kind: "plain", mark: "b", on }).kind, "written");
      const order = reverse ? [peer, writer] as const : [writer, peer] as const;
      settleCompound(...order, ["mug <em>mug</em>"]);
    });
  }

  test(`a peer insertion invalidates only the edited formatted match, ${reverse ? "replacement" : "typing"} delivered first to a third copy`, t => {
    const source = compoundSeed({ A: "<strong>cup</strong> <em>cup</em>" });
    const writer = noticeCopy(source, 2), peer = noticeCopy(source, 3), observer = noticeCopy(source, 4);
    t.after(() => { writer.close(); peer.close(); observer.close(); });
    const hits = [range("A", 0, 3), range("A", 4, 7)].map(hit => {
      const anchor = noticeRange(writer, hit.row, hit.cell, hit.start, hit.end);
      const intact = writer.captureTextIdentity(anchor);
      assert.ok(intact);
      return { hit, anchor, intact };
    });
    const updates: Uint8Array[] = [];
    peer.ydoc.once("update", (update: Uint8Array) => updates.push(update));
    assert.equal(peer.commands.typeText(noticeRange(peer, "A", "narration", 1), "X", { b: true }).kind, "written");
    noticeDeliver(peer, writer);
    assert.deepEqual(hits.map(({ intact }) => intact()), [false, true]);
    const remaining = hits.flatMap(({ hit, anchor, intact }) => {
      if (!intact()) return [];
      const selection = writer.resolveTextSelection(anchor);
      assert.ok(selection);
      return [{ ...hit, start: selection.anchor.offset, end: selection.head.offset }];
    });
    writer.ydoc.once("update", (update: Uint8Array) => updates.push(update));
    assert.equal(writer.commands.replaceAll(remaining, "mug").kind, "written");
    assert.equal(updates.length, 2);
    for (const update of reverse ? updates.toReversed() : updates) Y.applyUpdate(observer.ydoc, update, "peer");
    const expected = ["<strong>cXup</strong> <em>mug</em>"];
    settleCompound(writer, peer, expected);
    assert.deepEqual(observer.document(), writer.document());
  });

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
