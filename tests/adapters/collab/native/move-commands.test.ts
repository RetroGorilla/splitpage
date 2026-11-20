import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dom } from "../../../../src/test/_dom.mjs";
import { createNativeHeading, removeNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import type { NativeMoveBlock } from "../../../../src/adapters/collab/native/move-commands.ts";
import { closeNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { removeNativeRows } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { freshlyShown, shown } from "./helpers.ts";
import { caret, copiesOf, join, press, remove, rowsOf, split, stateOf, storedOf, structureScript } from "./structure-harness.ts";

after(() => { dom.window.close(); });

const beat = (id: string): NativeMoveBlock => ({ kind: "beat", id });
const heading = (id: string): NativeMoveBlock => ({ kind: "heading", id });

function one(rows: Record<string, string>, visuals: Record<string, string> = {}, sections: readonly { readonly id: string; readonly name: string; readonly before: string }[] = []): NativeScript {
  const { all: [copy] } = copiesOf(structureScript(rows, visuals, sections), [2]);
  assert.ok(copy);
  return copy;
}

function outlineIds(script: NativeScript): string[] {
  return script.reader.outline().map(entry => (entry.kind === "heading" ? "#" : "") + entry.id);
}

test("moving a single beat forward, backward, to the start and to the end writes only its rank in one transaction", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc", B: "def", C: "ghi", D: "jkl" }, { B: "wide" }));
  assert.ok(a && b);
  a.doc.transact(() => { a.roots.beats.get("B")?.set("status", JSON.stringify("ready")); });
  net.settle();
  const storedBefore = storedOf(a);
  let transactions = 0;
  a.doc.on("afterTransaction", () => { transactions++; });
  assert.deepEqual(moveNativeBlocks(a, [beat("B")], beat("D")), { kind: "written" });
  assert.equal(transactions, 1);
  assert.deepEqual(outlineIds(a), ["A", "C", "B", "D"]);
  assert.equal(storedOf(a), storedBefore);
  assert.equal(a.roots.beats.get("B")?.get("status"), JSON.stringify("ready"));
  assert.equal(a.roots.visuals.get("B")?.toString(), "wide");
  assert.deepEqual(moveNativeBlocks(a, [beat("D")], beat("A")), { kind: "written" });
  assert.deepEqual(outlineIds(a), ["D", "A", "C", "B"]);
  assert.deepEqual(moveNativeBlocks(a, [beat("A")], null), { kind: "written" });
  assert.deepEqual(outlineIds(a), ["D", "C", "B", "A"]);
  assert.deepEqual(moveNativeBlocks(a, [beat("C")], beat("D")), { kind: "written" });
  assert.deepEqual(outlineIds(a), ["C", "D", "B", "A"]);
  assert.equal(storedOf(a), storedBefore);
  net.settle();
  assert.deepEqual(net.agree(), ["C: ghi / ", "D: jkl / ", "B: def / wide", "A: abc / "]);
});

test("moving a heading, a whole scene or non-contiguous blocks places them in ascending moved order", () => {
  const { net, all: [a, b] } = copiesOf(structureScript(
    { A: "a", B: "b", C: "c", D: "d" }, {}, [{ id: "P", name: "One", before: "A" }, { id: "Q", name: "Two", before: "C" }]
  ));
  assert.ok(a && b);
  assert.deepEqual(moveNativeBlocks(a, [heading("Q"), beat("C"), beat("D")], heading("P")), { kind: "written" });
  assert.deepEqual(outlineIds(a), ["#Q", "C", "D", "#P", "A", "B"]);
  assert.deepEqual(moveNativeBlocks(a, [beat("D"), beat("B")], beat("C")), { kind: "written" });
  assert.deepEqual(outlineIds(a), ["#Q", "D", "B", "C", "#P", "A"]);
  assert.deepEqual(moveNativeBlocks(a, [heading("P")], null), { kind: "written" });
  assert.deepEqual(outlineIds(a), ["#Q", "D", "B", "C", "A", "#P"]);
  net.settle();
  net.agree();
});

test("a beat and a heading sharing the same id string are moved and targeted without ambiguity", () => {
  const copy = one({ X: "beat", Y: "other" }, {}, [{ id: "X", name: "Heading X", before: "Y" }]);
  assert.deepEqual(outlineIds(copy), ["X", "#X", "Y"]);
  assert.deepEqual(moveNativeBlocks(copy, [heading("X")], beat("X")), { kind: "written" });
  assert.deepEqual(outlineIds(copy), ["#X", "X", "Y"]);
  assert.deepEqual(moveNativeBlocks(copy, [beat("X"), heading("X")], null), { kind: "written" });
  assert.deepEqual(outlineIds(copy), ["Y", "X", "#X"]);
  assert.deepEqual(shown(copy), freshlyShown(copy));
});

test("dropping into a tied gap re-ranks every tied block on the right side in ascending order", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "a", B: "bcd", C: "e", D: "f" }));
  assert.ok(a && b);
  const s1 = split(a, "B", 1), s2 = split(a, s1, 1);
  assert.equal(a.roots.beats.get("B")?.get("rank"), a.roots.beats.get(s1)?.get("rank"));
  assert.equal(a.roots.beats.get("B")?.get("rank"), a.roots.beats.get(s2)?.get("rank"));
  const rankB = String(a.roots.beats.get("B")?.get("rank")), rankC = String(a.roots.beats.get("C")?.get("rank"));
  assert.deepEqual(moveNativeBlocks(a, [beat("D")], beat(s1)), { kind: "written" });
  assert.deepEqual(outlineIds(a), ["A", "B", "D", s1, s2, "C"]);
  const rankD = String(a.roots.beats.get("D")?.get("rank"));
  const rankS1 = String(a.roots.beats.get(s1)?.get("rank"));
  const rankS2 = String(a.roots.beats.get(s2)?.get("rank"));
  assert.ok(rankB < rankD && rankD < rankS1 && rankS1 < rankS2 && rankS2 < rankC);
  net.settle();
  net.agree();
});

test("moving one half of a tied split past the other half opens the tie cleanly", () => {
  const copy = one({ A: "a", B: "bc", C: "d" });
  const created = split(copy, "B", 1);
  assert.deepEqual(moveNativeBlocks(copy, [beat("B")], beat("C")), { kind: "written" });
  assert.deepEqual(outlineIds(copy), ["A", created, "B", "C"]);
  assert.deepEqual(moveNativeBlocks(copy, [beat("B")], beat(created)), { kind: "written" });
  assert.deepEqual(outlineIds(copy), ["A", "B", created, "C"]);
  assert.deepEqual(shown(copy), freshlyShown(copy));
});

test("a move writes the shown rank of a rankless drop neighbour (rule (e)), on either side and at the leading end", () => {
  const leftSide = one({ A: "a", B: "b", C: "c", D: "d" });
  leftSide.doc.transact(() => { leftSide.roots.beats.get("B")?.delete("rank"); });
  const rankA = String(leftSide.roots.beats.get("A")?.get("rank"));
  assert.deepEqual(moveNativeBlocks(leftSide, [beat("A")], beat("C")), { kind: "written" });
  assert.equal(leftSide.roots.beats.get("B")?.get("rank"), rankA);
  assert.deepEqual(outlineIds(leftSide), ["B", "A", "C", "D"]);

  const rightSide = one({ A: "a", B: "b", C: "c" }, {}, [{ id: "H", name: "Hidden", before: "B" }]);
  assert.equal(removeNativeHeading(rightSide, "H").kind, "written");
  rightSide.doc.transact(() => { rightSide.roots.beats.get("B")?.delete("rank"); });
  const rankH = String(rightSide.roots.headings.get("H")?.get("rank"));
  assert.deepEqual(moveNativeBlocks(rightSide, [beat("C")], beat("B")), { kind: "written" });
  assert.equal(rightSide.roots.beats.get("B")?.get("rank"), rankH);
  assert.deepEqual(outlineIds(rightSide), ["A", "C", "B"]);

  const leadingLeft = one({ A: "a", B: "b", C: "c", D: "d" });
  leadingLeft.doc.transact(() => {
    leadingLeft.roots.beats.get("A")?.delete("rank");
    leadingLeft.roots.beats.get("B")?.delete("rank");
  });
  assert.deepEqual(moveNativeBlocks(leadingLeft, [beat("D")], beat("C")), { kind: "written" });
  assert.equal(leadingLeft.roots.beats.get("A")?.has("rank"), false);
  assert.equal(leadingLeft.roots.beats.get("B")?.has("rank"), true);
  assert.deepEqual(outlineIds(leadingLeft), ["A", "B", "D", "C"]);

  const leadingRight = one({ A: "a", B: "b", C: "c" });
  leadingRight.doc.transact(() => { leadingRight.roots.beats.get("A")?.delete("rank"); });
  assert.deepEqual(moveNativeBlocks(leadingRight, [beat("C")], beat("A")), { kind: "written" });
  assert.equal(leadingRight.roots.beats.get("A")?.has("rank"), true);
  assert.deepEqual(outlineIds(leadingRight), ["C", "A", "B"]);

  const moveRankless = one({ A: "a", B: "b", C: "c" });
  moveRankless.doc.transact(() => { moveRankless.roots.beats.get("B")?.delete("rank"); });
  assert.deepEqual(moveNativeBlocks(moveRankless, [beat("B")], beat("A")), { kind: "written" });
  assert.equal(moveRankless.roots.beats.get("B")?.has("rank"), true);
  assert.deepEqual(outlineIds(moveRankless), ["B", "A", "C"]);
});

test("moving a joined row's head carries all its members' ranks and leaves `joined` untouched; non-head members refuse", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "a", B: "b", C: "c", D: "d", E: "e" }));
  assert.ok(a && b);
  join(a, "B", "A", " ");
  join(a, "C", "B", "-");
  const joinedB = a.roots.beats.get("B")?.get("joined"), joinedC = a.roots.beats.get("C")?.get("joined");
  const held = stateOf(a);
  assert.deepEqual(moveNativeBlocks(a, [beat("B")], beat("E")), { kind: "refused", reason: "missing" });
  assert.deepEqual(moveNativeBlocks(a, [beat("E")], beat("B")), { kind: "refused", reason: "missing" });
  assert.deepEqual(moveNativeBlocks(a, [beat("A"), beat("B")], beat("E")), { kind: "refused", reason: "missing" });
  assert.deepEqual(stateOf(a), held);

  assert.deepEqual(moveNativeBlocks(a, [beat("A")], beat("E")), { kind: "written" });
  assert.deepEqual(a.roots.beats.get("B")?.get("joined"), joinedB);
  assert.deepEqual(a.roots.beats.get("C")?.get("joined"), joinedC);
  assert.deepEqual(outlineIds(a), ["D", "A", "E"]);
  assert.deepEqual(a.reader.row("A")?.members, ["A", "B", "C"]);
  assert.equal(a.reader.row("A")?.audioText, "a b-c");

  assert.deepEqual(moveNativeBlocks(a, [beat("D")], beat("E")), { kind: "written" });
  assert.deepEqual(outlineIds(a), ["A", "D", "E"]);
  assert.deepEqual(a.reader.row("A")?.members, ["A", "B", "C"]);
  net.settle();
  assert.deepEqual(net.agree(), ["A: a b-c / ", "D: d / ", "E: e / "]);
});

test("gate 2: a move including or targeting a row without its record or visual cell is refused unwritten; B alone moves", () => {
  const { net, all: [a, b], undo: [undoA, undoB] } = copiesOf(structureScript({ A: "abc", B: "def", C: "ghi" }, { A: "1", B: "2", C: "3" }));
  assert.ok(a && b && undoA && undoB);
  const n = split(a, "B", 0);
  net.settle();
  remove(b, n); net.settle();
  press(undoA, a); net.settle();
  press(undoB, b); net.settle();
  assert.equal(a.roots.beats.has(n), false);
  assert.equal(a.roots.visuals.has(n), false);
  const before = stateOf(a);
  assert.deepEqual(moveNativeBlocks(a, [beat(n)], beat("A")), { kind: "refused", reason: "missing" });
  assert.deepEqual(moveNativeBlocks(a, [beat("B"), beat(n)], null), { kind: "refused", reason: "missing" });
  assert.deepEqual(moveNativeBlocks(a, [beat("A")], beat(n)), { kind: "refused", reason: "missing" });
  assert.deepEqual(stateOf(a), before);

  assert.deepEqual(moveNativeBlocks(a, [beat("B")], null), { kind: "written" });
  net.settle();
  assert.deepEqual(rowsOf(a), ["A: abc", "C: ghi", "B: def"]);
  net.agree();
});

test("gate 2: direct missing beat record, visual cell, heading record or name cell refuses unwritten", () => {
  for (const broken of ["beat-record", "visual", "heading-record", "name"] as const) {
    const copy = one({ A: "a", B: "b", C: "c" }, {}, [{ id: "H", name: "Scene", before: "B" }]);
    copy.doc.transact(() => {
      if (broken === "beat-record") copy.roots.beats.delete("B");
      else if (broken === "visual") copy.roots.visuals.delete("B");
      else if (broken === "heading-record") copy.roots.headings.delete("H");
      else copy.roots.names.delete("H");
    });
    const target = broken === "beat-record" || broken === "visual" ? beat("B") : heading("H");
    const before = stateOf(copy);
    assert.deepEqual(moveNativeBlocks(copy, [target], beat("A")), { kind: "refused", reason: "missing" }, broken);
    assert.deepEqual(moveNativeBlocks(copy, [beat("C")], target), { kind: "refused", reason: "missing" }, broken);
    assert.deepEqual(stateOf(copy), before, broken);
  }
});

test("stray narration-only row without a record is refused unwritten", () => {
  const { net, all: [a, b] } = copiesOf(structureScript({ A: "abc" }));
  assert.ok(a && b);
  remove(a, "A");
  const anchored = anchorNativeText(b, { beat: "A", cell: "narration" }, 1);
  assert.ok(anchored.kind === "anchored");
  assert.equal(typeNativeText(b, anchored.range, "x", {}).kind, "written");
  net.settle();
  const stray = a.reader.outline()[0];
  assert.ok(stray && stray.kind === "row");
  const before = stateOf(a);
  assert.deepEqual(moveNativeBlocks(a, [beat(stray.id)], null), { kind: "refused", reason: "missing" });
  assert.deepEqual(stateOf(a), before);
});

test("unknown, removed or hidden blocks, repeated ids, odd lists and bad drops refuse unwritten", () => {
  const copy = one({ A: "a", B: "b", C: "c" }, {}, [{ id: "H", name: "Scene", before: "B" }]);
  remove(copy, "C");
  assert.equal(removeNativeHeading(copy, "H").kind, "written");
  const before = stateOf(copy);
  const sparse: NativeMoveBlock[] = [];
  sparse.length = 2;
  sparse[0] = beat("A");
  for (const [blocks, drop, reason] of [
    [[beat("Q")], beat("A"), "missing"],
    [[heading("Q")], beat("A"), "missing"],
    [[beat("C")], beat("A"), "missing"],
    [[heading("H")], beat("A"), "missing"],
    [[beat("A")], beat("C"), "missing"],
    [[beat("A")], heading("H"), "missing"],
    [[beat("A")], beat("Q"), "missing"],
    [[], beat("Q"), "missing"],
    [[beat("A"), beat("A")], beat("B"), "list"],
    [null, beat("A"), "list"],
    [undefined, beat("A"), "list"],
    ["A", beat("A"), "list"],
    [{ 0: beat("A"), length: 1 }, beat("B"), "list"],
    [sparse, beat("B"), "list"],
    [[null], beat("A"), "list"],
    [[7], beat("A"), "list"],
    [[{ kind: "other", id: "A" }], beat("B"), "list"],
    [[{ kind: "beat", id: "" }], beat("B"), "list"],
    [[{ kind: "beat", id: "\ud800" }], beat("B"), "list"],
    [[beat("A")], undefined, "drop"],
    [[beat("A")], "B", "drop"],
    [[beat("A")], { kind: "other", id: "B" }, "drop"],
    [[beat("A")], { kind: "beat", id: "" }, "drop"],
    [[beat("A")], { kind: "beat", id: "\ud800" }, "drop"],
    [[beat("A")], beat("A"), "drop"],
    [[beat("A"), beat("B")], beat("B"), "drop"]
  ] as const) {
    assert.deepEqual(
      moveNativeBlocks(copy, blocks as unknown as NativeMoveBlock[], drop as unknown as NativeMoveBlock | null),
      { kind: "refused", reason },
      `${JSON.stringify(blocks)} -> ${JSON.stringify(drop)}`
    );
  }
  assert.deepEqual(stateOf(copy), before);
});

test("unchanged moves (empty list or already in that gap) write nothing", () => {
  const copy = one({ A: "a", B: "b", C: "c" }, {}, [{ id: "H", name: "Scene", before: "B" }]);
  join(copy, "C", "B", " ");
  const before = stateOf(copy);
  assert.deepEqual(moveNativeBlocks(copy, [], null), { kind: "unchanged" });
  assert.deepEqual(moveNativeBlocks(copy, [], beat("A")), { kind: "unchanged" });
  assert.deepEqual(moveNativeBlocks(copy, [beat("A")], heading("H")), { kind: "unchanged" });
  assert.deepEqual(moveNativeBlocks(copy, [heading("H"), beat("B")], null), { kind: "unchanged" });
  assert.deepEqual(moveNativeBlocks(copy, [beat("B")], null), { kind: "unchanged" });
  assert.deepEqual(stateOf(copy), before);
});

test("a stored rank that is present but not a well-formed rank string refuses as stored, unwritten", () => {
  for (const bad of ["", "0", "a0", "0000100", "bad!", "a\ud800", 7, null, { a: 1 }] as const) {
    const movedBad = one({ A: "a", B: "b", C: "c" });
    movedBad.doc.transact(() => { movedBad.roots.beats.get("A")?.set("rank", bad); });
    const afterA = outlineIds(movedBad);
    const dropForA = afterA[0] === "A" ? null : beat(afterA[0] as string);
    const s1 = stateOf(movedBad);
    assert.deepEqual(moveNativeBlocks(movedBad, [beat("A")], dropForA), { kind: "refused", reason: "stored" }, `moved ${JSON.stringify(bad)}`);
    assert.deepEqual(stateOf(movedBad), s1);

    const neighbourBad = one({ A: "a", B: "b", C: "c", D: "d" });
    neighbourBad.doc.transact(() => { neighbourBad.roots.beats.get("B")?.set("rank", bad); });
    const ids = outlineIds(neighbourBad), posB = ids.indexOf("B");
    const mover = ids.find(id => id !== "B" && ids.indexOf(id) !== posB - 1 && ids.indexOf(id) !== posB + 1) ?? "D";
    const rightOfB = ids[posB + 1] ? beat(ids[posB + 1] as string) : null;
    const s2 = stateOf(neighbourBad);
    assert.deepEqual(moveNativeBlocks(neighbourBad, [beat(mover)], rightOfB), { kind: "refused", reason: "stored" }, `left ${JSON.stringify(bad)}`);
    assert.deepEqual(moveNativeBlocks(neighbourBad, [beat(mover)], beat("B")), { kind: "refused", reason: "stored" }, `right ${JSON.stringify(bad)}`);
    assert.deepEqual(stateOf(neighbourBad), s2);
  }

  const { net, all: [a, b] } = copiesOf(structureScript({ A: "a", B: "b", C: "c" }));
  assert.ok(a && b);
  a.doc.transact(() => { a.roots.beats.get("B")?.set("rank", undefined); });
  net.settle();
  assert.deepEqual([b.roots.beats.get("B")?.has("rank"), b.roots.beats.get("B")?.get("rank")], [true, undefined]);
  const before = stateOf(b);
  assert.deepEqual(moveNativeBlocks(b, [beat("B")], beat("A")), { kind: "refused", reason: "stored" });
  assert.deepEqual(moveNativeBlocks(b, [beat("C")], beat("B")), { kind: "refused", reason: "stored" });
  assert.deepEqual(stateOf(b), before);
});

test("a rankless drop neighbour inheriting a malformed stored rank refuses as stored, unwritten", () => {
  const copy = one({ A: "a", B: "b", C: "c" }, {}, [{ id: "H", name: "Hidden", before: "B" }]);
  assert.equal(removeNativeHeading(copy, "H").kind, "written");
  copy.doc.transact(() => {
    copy.roots.headings.get("H")?.set("rank", "bad!");
    copy.roots.beats.get("B")?.delete("rank");
  });
  const before = stateOf(copy);
  assert.deepEqual(moveNativeBlocks(copy, [beat("A")], beat("B")), { kind: "refused", reason: "stored" });
  assert.deepEqual(moveNativeBlocks(copy, [beat("A")], null), { kind: "refused", reason: "stored" });
  assert.deepEqual(stateOf(copy), before);
});

test("move refuses busy inside an open transaction and closed on a closed script, writing nothing", () => {
  const copy = one({ A: "a", B: "b" }), outcomes: unknown[] = [], open = stateOf(copy);
  copy.doc.transact(() => {
    outcomes.push(moveNativeBlocks(copy, [beat("B")], beat("A")));
  });
  assert.deepEqual(outcomes, [{ kind: "refused", reason: "busy" }]);
  assert.deepEqual(stateOf(copy), open);
  assert.deepEqual(moveNativeBlocks(copy, [beat("B")], beat("A")), { kind: "written" });
  closeNativeScript(copy);
  const closed = stateOf(copy);
  assert.deepEqual(moveNativeBlocks(copy, [beat("A")], beat("B")), { kind: "refused", reason: "closed" });
  assert.deepEqual(moveNativeBlocks(copy, [], null), { kind: "refused", reason: "closed" });
  assert.deepEqual(stateOf(copy), closed);
});

test("caller inputs are copied once by index without running iterators; throwing getters refuse plainly", () => {
  const copy = one({ A: "a", B: "b", C: "c" }), before = stateOf(copy);
  const withIter = [beat("C")];
  let iterated = false;
  withIter[Symbol.iterator] = function* (): Generator<NativeMoveBlock> { iterated = true; yield beat("A"); };
  assert.deepEqual(moveNativeBlocks(copy, withIter, beat("A")), { kind: "written" });
  assert.equal(iterated, false);
  assert.deepEqual(outlineIds(copy), ["C", "A", "B"]);

  const held = stateOf(copy);
  const throwingIndex: NativeMoveBlock[] = [beat("A")];
  Object.defineProperty(throwingIndex, 1, { get: () => { throw new Error("boom"); }, enumerable: true });
  const throwingKind = [{ get kind(): "beat" { throw new Error("boom"); }, id: "A" }];
  const throwingDrop = { kind: "beat" as const, get id(): string { throw new Error("boom"); } };
  assert.deepEqual(moveNativeBlocks(copy, throwingIndex, beat("B")), { kind: "refused", reason: "list" });
  assert.deepEqual(moveNativeBlocks(copy, throwingKind, beat("B")), { kind: "refused", reason: "list" });
  assert.deepEqual(moveNativeBlocks(copy, [beat("A")], throwingDrop), { kind: "refused", reason: "drop" });
  assert.deepEqual(stateOf(copy), held);
  assert.ok(before.update.length > 0);
});

test("a caller getter that closes the script or runs a nested command is handled cleanly without partial writes", () => {
  const closing = one({ A: "a", B: "b" }), list = [beat("B")], before = stateOf(closing);
  Object.defineProperty(list, 0, { get: () => { closeNativeScript(closing); return beat("B"); }, enumerable: true });
  assert.deepEqual(moveNativeBlocks(closing, list, beat("A")), { kind: "refused", reason: "closed" });
  assert.deepEqual(stateOf(closing), before);

  const nested = one({ A: "a", B: "b", C: "c" });
  let writes = 0, innerState: ReturnType<typeof stateOf> | null = null;
  const mutating = [beat("C")];
  Object.defineProperty(mutating, 0, {
    get: () => {
      assert.equal(removeNativeRows(nested, ["C"]).kind, "written");
      innerState = stateOf(nested);
      return beat("C");
    },
    enumerable: true
  });
  nested.doc.on("update", () => { writes++; });
  assert.deepEqual(moveNativeBlocks(nested, mutating, beat("A")), { kind: "refused", reason: "missing" });
  assert.equal(writes, 1);
  assert.ok(innerState);
  assert.deepEqual(stateOf(nested), innerState);
  assert.deepEqual(outlineIds(nested), ["A", "B"]);
});

test("heading creation above a beat remains unchanged: a tie still refuses with reason rank", () => {
  const copy = one({ A: "a", B: "bc" });
  const created = split(copy, "B", 1);
  const before = stateOf(copy);
  assert.deepEqual(createNativeHeading(copy, caret(copy, created, 0), "H", "Tie"), { kind: "refused", reason: "rank" });
  assert.deepEqual(stateOf(copy), before);
});
