import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dom } from "../../../../src/test/_dom.mjs";
import { createNativeHeading, removeNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import type { NativeMoveBlock } from "../../../../src/adapters/collab/native/move-commands.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { anchorNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { Delivery } from "./helpers.ts";
import { caret, copiesOf, join, press, remove, rowsOf, split, stateOf, storedOf, structureScript } from "./structure-harness.ts";

after(() => { dom.window.close(); });

const CLIENTS: readonly (readonly number[])[] = [[2, 3], [3, 2]];
const ORDERS: readonly Delivery[] = ["forward", "reverse", "twice"];
const beat = (id: string): NativeMoveBlock => ({ kind: "beat", id });
const heading = (id: string): NativeMoveBlock => ({ kind: "heading", id });

function move(script: NativeScript, blocks: readonly NativeMoveBlock[], drop: NativeMoveBlock | null): void {
  assert.deepEqual(moveNativeBlocks(script, blocks, drop), { kind: "written" });
  script.reader.refresh();
}

function outlineIds(script: NativeScript): string[] {
  return script.reader.outline().map(entry => (entry.kind === "heading" ? "#" : "") + entry.id);
}

function beatSegments(script: NativeScript): Map<string, Set<string>> {
  const byBeat = new Map<string, Set<string>>();
  for (const [key, seg] of script.roots.segments) {
    for (const span of nativeSegmentSpans(seg) ?? []) {
      if (!span.key?.startsWith("b:")) continue;
      const id = span.key.slice(2);
      const set = byBeat.get(id) ?? new Set<string>();
      set.add(key);
      byBeat.set(id, set);
    }
  }
  return byBeat;
}

test("decision 15 (E15 history 1): two same-moment moves of one row and winner's undo leave it rankless under rule (e)", () => {
  const source = structureScript({ A: "a", B: "b", C: "c" }, {}, [{ id: "H", name: "Scene", before: "C" }]);
  for (const clients of CLIENTS) for (const order of ORDERS) {
    const { net, all: [a, b], undo: [undoA, undoB] } = copiesOf(source, clients);
    assert.ok(a && b && undoA && undoB);
    move(a, [beat("A")], beat("C"));
    net.settle(order);
    // why: both copies move B concurrently; the higher client wins and its undo leaves B's rank key absent
    move(a, [beat("B")], beat("C"));
    move(b, [beat("B")], beat("A"));
    net.settle(order);
    const aWins = (clients[0] ?? 0) > (clients[1] ?? 0);
    assert.deepEqual(outlineIds(a), aWins ? ["#H", "A", "B", "C"] : ["#H", "B", "A", "C"]);
    press(aWins ? undoA : undoB, aWins ? a : b);
    net.settle(order);
    assert.equal(a.roots.beats.get("B")?.has("rank"), false);
    assert.equal(b.roots.beats.get("B")?.has("rank"), false);
    assert.deepEqual(outlineIds(a), ["#H", "A", "B", "C"]);
    net.agree();
    remove(a, "A");
    net.settle(order);
    assert.deepEqual(outlineIds(a), ["B", "#H", "C"]);
    net.agree();
    undoA.destroy(); undoB.destroy(); a.close(); b.close();
  }
});

test("decision 15: a move next to a rankless row pins its shown rank so removing its narration neighbour no longer shifts it", () => {
  const source = structureScript({ A: "a", B: "b", C: "c", D: "d" }, {}, [{ id: "H", name: "Scene", before: "C" }]);
  for (const side of ["after-rankless", "before-rankless"] as const) {
    const { net, all: [a, b], undo: [undoA, undoB] } = copiesOf(source, [2, 3]);
    assert.ok(a && b && undoA && undoB);
    move(a, [beat("A")], beat("C"));
    net.settle();
    move(a, [beat("B")], beat("C"));
    move(b, [beat("B")], beat("A"));
    net.settle();
    press(undoB, b);
    net.settle();
    assert.equal(a.roots.beats.get("B")?.has("rank"), false);
    assert.deepEqual(outlineIds(a), ["#H", "A", "B", "C", "D"]);
    move(a, [beat("D")], side === "after-rankless" ? beat("C") : beat("B"));
    net.settle();
    assert.equal(a.roots.beats.get("B")?.has("rank"), true);
    assert.deepEqual(outlineIds(a), side === "after-rankless" ? ["#H", "A", "B", "D", "C"] : ["#H", "A", "D", "B", "C"]);
    remove(a, "A");
    net.settle();
    assert.deepEqual(outlineIds(a), side === "after-rankless" ? ["#H", "B", "D", "C"] : ["#H", "D", "B", "C"]);
    net.agree();
    undoA.destroy(); undoB.destroy(); a.close(); b.close();
  }
});

test("decision 15 (E15 history 4): three same-moment moves of one row and winner's undo leave it rankless under rule (e)", () => {
  const source = structureScript({ A: "a", B: "b", C: "c", D: "d" });
  for (const clients of [[2, 3, 4], [4, 3, 2]] as const) for (const order of ORDERS) {
    const { net, all: [a, b, c], undo: [undoA, undoB, undoC] } = copiesOf(source, clients);
    assert.ok(a && b && c && undoA && undoB && undoC);
    move(a, [beat("B")], beat("D"));
    move(b, [beat("B")], null);
    move(c, [beat("B")], beat("A"));
    net.settle(order);
    const winner = clients[0] > clients[2] ? 0 : 2;
    press(winner === 0 ? undoA : undoC, winner === 0 ? a : c);
    net.settle(order);
    assert.equal(a.roots.beats.get("B")?.has("rank"), false);
    assert.deepEqual(outlineIds(a), ["A", "B", "C", "D"]);
    net.agree();
    undoA.destroy(); undoB.destroy(); undoC.destroy();
    a.close(); b.close(); c.close();
  }
});

test("decision 15 (E15 history 9): an older redo of a heading move does not overwrite another copy's later seen move", () => {
  const source = structureScript({ A: "a", B: "b", C: "c" }, {}, [{ id: "H", name: "H", before: "B" }, { id: "I", name: "I", before: "C" }]);
  for (const order of ORDERS) {
    const { net, all: [a, b], undo: [, undoB] } = copiesOf(source, [2, 3]);
    assert.ok(a && b && undoB);
    move(b, [heading("H")], null);
    press(undoB, b);
    net.settle(order);
    move(a, [heading("H")], beat("A"));
    net.settle(order);
    assert.deepEqual(outlineIds(b), ["#H", "A", "B", "#I", "C"]);
    const before = stateOf(b);
    assert.equal(undoB.redo(), null);
    assert.deepEqual(stateOf(b), before);
    net.settle(order);
    assert.deepEqual(outlineIds(a), ["#H", "A", "B", "#I", "C"]);
    net.agree();
    undoB.destroy(); a.close(); b.close();
  }
});

test("decision 15 (E15 history 15): undoing a move that pinned a rankless row settles cleanly with rule (e)", () => {
  const source = structureScript({ A: "a", B: "bc", C: "d", D: "e" });
  for (const order of ORDERS) {
    const { net, all: [a, b], undo: [undoA, undoB] } = copiesOf(source, [2, 3]);
    assert.ok(a && b && undoA && undoB);
    move(a, [beat("B")], beat("D"));
    move(b, [beat("B")], null);
    net.settle(order);
    press(undoB, b);
    net.settle(order);
    assert.equal(a.roots.beats.get("B")?.has("rank"), false);
    const n = split(a, "B", 1);
    net.settle(order);
    assert.equal(a.roots.beats.get(n)?.has("rank"), false);
    undoA.stopCapturing();
    move(a, [beat("D")], beat(n));
    net.settle(order);
    assert.deepEqual(outlineIds(a), ["A", "B", "D", n, "C"]);
    assert.deepEqual(createNativeHeading(b, caret(b, n, 0), "H", "Scene"), { kind: "written" });
    net.settle(order);
    assert.deepEqual(outlineIds(a), ["A", "B", "D", "#H", n, "C"]);
    press(undoA, a);
    net.settle(order);
    assert.deepEqual(outlineIds(a), ["A", "B", "#H", n, "C", "D"]);
    net.agree();
    undoA.destroy(); undoB.destroy(); a.close(); b.close();
  }
});

test("named race: move against split of the moved row leaves the second half behind (decision 9)", () => {
  const source = structureScript({ A: "ab", B: "cd", C: "ef", D: "gh" });
  for (const clients of CLIENTS) for (const order of ORDERS) {
    const { net, all: [a, b] } = copiesOf(source, clients);
    assert.ok(a && b);
    move(a, [beat("B")], null);
    const second = split(b, "B", 1);
    net.settle(order);
    assert.deepEqual(rowsOf(a), ["A: ab", `${second}: d`, "C: ef", "D: gh", "B: c"]);
    net.agree();
    a.close(); b.close();
  }
});

test("named race: move against removal of the moved row, left drop neighbour and right drop neighbour", () => {
  const source = structureScript({ A: "a", B: "b", C: "c", D: "d", E: "e" });
  for (const [victim, expected] of [
    ["B", ["A", "C", "D", "E"]],
    ["C", ["A", "B", "D", "E"]],
    ["D", ["A", "C", "B", "E"]]
  ] as const) {
    for (const clients of CLIENTS) for (const order of ORDERS) {
      const { net, all: [a, b] } = copiesOf(source, clients);
      assert.ok(a && b);
      move(a, [beat("B")], beat("D"));
      remove(b, victim);
      net.settle(order);
      assert.deepEqual(outlineIds(a), expected, `${victim}, ${clients.join(",")}, ${order}`);
      net.agree();
      a.close(); b.close();
    }
  }
});

test("named race: move against a join whose target moves (rule (d)), and moving back restores the join", () => {
  const source = structureScript({ A: "a", B: "b", C: "c", D: "d" });
  for (const clients of CLIENTS) for (const order of ORDERS) {
    const { net, all: [a, b] } = copiesOf(source, clients);
    assert.ok(a && b);
    move(a, [beat("A")], beat("D"));
    join(b, "B", "A", " ");
    net.settle(order);
    assert.deepEqual(rowsOf(a), ["B: b", "C: c", "A: a", "D: d"]);
    assert.ok(a.reader.problems().some(p => p.kind === "join-not-read" && p.where === "beats/B"));
    net.agree();
    move(a, [beat("B")], beat("D"));
    net.settle(order);
    assert.deepEqual(rowsOf(a), ["C: c", "A: a b", "D: d"]);
    assert.deepEqual(a.reader.row("A")?.members, ["A", "B"]);
    assert.deepEqual(a.reader.problems(), []);
    net.agree();
    a.close(); b.close();
  }
});

test("named race: two moves into the same gap share a rank in stored tie order and a later drop between them opens the tie", () => {
  const source = structureScript({ A: "a", B: "b", C: "c", D: "d", E: "e" });
  for (const clients of CLIENTS) for (const order of ORDERS) {
    const { net, all: [a, b] } = copiesOf(source, clients);
    assert.ok(a && b);
    move(a, [beat("A")], beat("D"));
    move(b, [beat("E")], beat("D"));
    net.settle(order);
    // why: nativeRankBetween is deterministic without a client suffix, so A and E tie and sort by stored order (A < E)
    assert.equal(a.roots.beats.get("A")?.get("rank"), a.roots.beats.get("E")?.get("rank"));
    assert.deepEqual(outlineIds(a), ["B", "C", "A", "E", "D"]);
    net.agree();
    move(a, [beat("B")], beat("E"));
    net.settle(order);
    assert.deepEqual(outlineIds(a), ["C", "A", "B", "E", "D"]);
    assert.ok(String(a.roots.beats.get("A")?.get("rank")) < String(a.roots.beats.get("B")?.get("rank")));
    assert.ok(String(a.roots.beats.get("B")?.get("rank")) < String(a.roots.beats.get("E")?.get("rank")));
    net.agree();
    a.close(); b.close();
  }
});

test("named race: two people dropping into each other's spot settle identically across client orders and deliveries", () => {
  const source = structureScript({ A: "a", B: "b", C: "c", D: "d", E: "e" });
  for (const clients of CLIENTS) for (const order of ORDERS) {
    const { net, all: [a, b] } = copiesOf(source, clients);
    assert.ok(a && b);
    move(a, [beat("B")], beat("E"));
    move(b, [beat("D")], beat("C"));
    net.settle(order);
    assert.deepEqual(outlineIds(a), ["A", "D", "C", "B", "E"]);
    net.agree();
    a.close(); b.close();
  }
});

test("named race: move against heading creation in the same gap keeps both in deterministic stored tie order", () => {
  const source = structureScript({ A: "a", B: "b", C: "c", D: "d", E: "e" });
  for (const [moved, expected] of [
    ["A", ["B", "C", "A", "#H", "D", "E"]],
    ["E", ["A", "B", "C", "#H", "E", "D"]]
  ] as const) {
    for (const clients of CLIENTS) for (const order of ORDERS) {
      const { net, all: [a, b] } = copiesOf(source, clients);
      assert.ok(a && b);
      move(a, [beat(moved)], beat("D"));
      assert.deepEqual(createNativeHeading(b, caret(b, "D", 0), "H", "Scene"), { kind: "written" });
      net.settle(order);
      assert.equal(a.roots.beats.get(moved)?.get("rank"), a.roots.headings.get("H")?.get("rank"));
      assert.deepEqual(outlineIds(a), expected, `${moved}, ${clients.join(",")}, ${order}`);
      net.agree();
      a.close(); b.close();
    }
  }
});

test("gate 7 (slice 3 carried): doubled boundary after split and move stays in one segment so removal clears both cleanly", () => {
  const source = structureScript({ A: "abc", B: "def", C: "ghi", D: "jkl" }, {}, [{ id: "H", name: "Scene", before: "D" }]);
  for (const moveWhich of ["split", "original"] as const) {
    const { net, all: [a, b], undo: [undoA, undoB] } = copiesOf(source, [2, 3]);
    assert.ok(a && b && undoA && undoB);
    remove(a, "B"); remove(b, "B");
    net.settle();
    press(undoA, a); press(undoB, b);
    net.settle();
    assert.equal(storedOf(a), "[A]abc[B][B]defdef[C]ghi | [#H][D]jkl");
    const n = split(a, "B", 1);
    net.settle();
    assert.equal(storedOf(a), `[A]abc[B][${n}][B]defdef[C]ghi | [#H][D]jkl`);
    move(a, [beat(moveWhich === "split" ? n : "B")], null);
    net.settle();
    for (const [id, segs] of beatSegments(a)) assert.equal(segs.size, 1, `beat ${id} in multiple segments`);
    remove(a, "B");
    net.settle();
    assert.equal(storedOf(b), `[A]abc[${n}]defdef[C]ghi | [#H][D]jkl`);
    assert.equal(b.reader.row("B"), null);
    assert.equal(b.reader.row(n)?.audioText, "defdef");
    assert.deepEqual(b.reader.problems(), []);
    net.agree();
    undoA.destroy(); undoB.destroy(); a.close(); b.close();
  }
});

test("gate 7 (slice 3 carried): no sequence of native commands including moves, splits, headings and undo places a beat in two segments", () => {
  const source = structureScript(
    { A: "abc", B: "def", C: "ghi", D: "jkl", E: "mno", F: "pqr" }, {},
    [{ id: "H1", name: "One", before: "A" }, { id: "H2", name: "Two", before: "D" }]
  );
  const { net, all: [a, b, c], undo: [undoA, undoB, undoC] } = copiesOf(source, [2, 3, 4]);
  assert.ok(a && b && c && undoA && undoB && undoC);
  const s1 = split(a, "B", 1);
  const s2 = split(b, "E", 2);
  move(c, [beat("B")], beat("F"));
  move(a, [beat(s1)], beat("D"));
  assert.deepEqual(createNativeHeading(b, caret(b, "C", 0), "H3", "Three"), { kind: "written" });
  net.settle();
  remove(a, "B"); remove(b, "B");
  net.settle();
  press(undoA, a); press(undoB, b);
  net.settle();
  const s3 = split(a, "B", 1);
  net.settle();
  move(c, [beat("B"), beat(s3)], beat("A"));
  assert.deepEqual(createNativeHeading(a, caret(a, "A", 0), "H4", "Top"), { kind: "written" });
  assert.deepEqual(removeNativeHeading(b, "H2"), { kind: "written" });
  const anchored = anchorNativeText(c, { beat: s2, cell: "narration" }, 0);
  assert.equal(anchored.kind, "anchored");
  if (anchored.kind === "anchored") assert.equal(typeNativeText(c, anchored.range, "x", {}).kind, "written");
  net.settle();
  net.agree();
  for (const copy of [a, b, c]) {
    for (const [id, segs] of beatSegments(copy)) {
      assert.equal(segs.size, 1, `beat ${id} appeared in ${segs.size} segments: ${[...segs].join(",")}`);
    }
  }
  undoA.destroy(); undoB.destroy(); undoC.destroy();
  a.close(); b.close(); c.close();
});
