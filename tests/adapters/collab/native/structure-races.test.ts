import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText, replaceNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextRange, NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { Delivery, ScriptNet } from "./helpers.ts";
import { caret, copiesOf, join, press, remove, rowsOf, split, stateOf, storedOf, structureScript } from "./structure-harness.ts";

after(() => { dom.window.close(); });

const BASE = structureScript(
  { A: "abc", B: "def", C: "ghi", D: "jkl", E: "pqr" }, { A: "1", B: "2", C: "3", D: "4", E: "5" }, [{ id: "H", name: "Scene", before: "E" }]
);
const TAIL = ["D: jkl / 4", "# Scene", "E: pqr / 5"];
const ORDERS: readonly Delivery[] = ["forward", "reverse", "twice"];
const CLIENTS: readonly (readonly number[])[] = [[2, 3], [3, 2]];
const TAG = "t:prop:lamp";

interface World { readonly net: ScriptNet; readonly a: NativeScript; readonly b: NativeScript; readonly undoA: Y.UndoManager; readonly undoB: Y.UndoManager }

// why: every history runs in both client orders and three deliveries; each run must end with every copy, a fresh
// reader and a late joiner reading alike, and the history's own reading is compared across runs
function runs(history: (world: World, order: Delivery) => void): string[][] {
  const readings: string[][] = [];
  for (const clients of CLIENTS) for (const order of ORDERS) {
    const { net, all: [a, b], undo: [undoA, undoB] } = copiesOf(BASE, clients);
    assert.ok(a && b && undoA && undoB);
    history({ net, a, b, undoA, undoB }, order);
    net.settle(order);
    readings.push(net.agree().map(line => line.replace(/^r[0-9a-z]+-[0-9a-z]+:/, "N:")));
  }
  return readings;
}

function settled(history: (world: World, order: Delivery) => void): string[] {
  const readings = runs(history);
  for (const reading of readings) assert.deepEqual(reading, readings[0]);
  return readings[0] ?? [];
}

const narration = (beat: string): NativeTextTarget => ({ beat, cell: "narration" });
const visual = (beat: string): NativeTextTarget => ({ beat, cell: "visual" });

function typeIn(script: NativeScript, target: NativeTextTarget, at: number, text: string): void {
  const anchored = anchorNativeText(script, target, at);
  assert.ok(anchored.kind === "anchored");
  assert.equal(typeNativeText(script, anchored.range, text, {}).kind, "written");
}

function tag(script: NativeScript, target: NativeTextTarget, from: number, to: number): void {
  const anchored = anchorNativeText(script, target, from, to);
  assert.ok(anchored.kind === "anchored");
  assert.equal(formatNativeText(script, anchored.range, { kind: "tag", id: TAG, on: true }).kind, "written");
}

// why: slice 5 owns field commands and slice 4 moves; these write what the design gives them, so a removal can meet one
function setField(script: NativeScript, beat: string, key: string, value: string): void {
  script.doc.transact(() => { script.roots.beats.get(beat)?.set(key, value); }, script.origin);
}

test("E14: a split of a row another copy removes keeps the new boundary, record and cell; the removed record stays", () => {
  assert.deepEqual(settled(({ a, b }) => { remove(a, "B"); split(b, "B", 1); }), ["A: abc / 1", "N:  / ", "C: ghi / 3", ...TAIL]);
  assert.deepEqual(settled(({ a, b }) => { remove(a, "B"); split(b, "C", 1); }), ["A: abc / 1", "C: g / 3", "N: hi / ", ...TAIL]);
});

test("E9 and E14: letters typed unseen into a removed row stay stored: after an embedded row they read at the end of the row above", () => {
  assert.deepEqual(settled(({ a, b }) => { remove(a, "B"); typeIn(b, narration("B"), 1, "Ω"); }), ["A: abcΩ / 1", "C: ghi / 3", ...TAIL]);
  assert.deepEqual(settled(({ a, b }) => { remove(a, "C"); typeIn(b, narration("C"), 3, "Ω"); }), ["A: abc / 1", "B: defΩ / 2", ...TAIL]);
});

test("E9: a letter typed unseen into a removed segment head is stored with no head; rule (a), slice 3b, gives it to the next row", () => {
  const reading = settled(({ a, b }) => { remove(a, "A"); typeIn(b, narration("A"), 1, "Ω"); });
  assert.deepEqual(reading, ["B: def / 2", "C: ghi / 3", ...TAIL, "unplaced b:A no-head 1"]);
});

test("E14: a removal's undo brings back the row with what another copy wrote unseen into its kept record and visual cell", () => {
  for (const seen of [false, true]) {
    const reading = settled(({ net, a, b, undoA }) => {
      remove(a, "B");
      typeIn(b, visual("B"), 1, "Ω"); setField(b, "B", "status", JSON.stringify("done")); tag(b, visual("B"), 0, 1);
      if (seen) net.settle();
      press(undoA, a);
    });
    assert.equal(reading.length, 1 + 1 + 1 + TAIL.length);
    assert.match(reading[1] ?? "", /^B: def \/ <span class="tag-anchor"[^>]*>2<\/span>Ω$/, `seen ${seen}`);
  }
  for (const clients of CLIENTS) {
    const { net, all: [a, b], undo: [undoA] } = copiesOf(BASE, clients);
    assert.ok(a && b && undoA);
    remove(a, "B"); setField(b, "B", "status", JSON.stringify("done"));
    net.settle();
    assert.equal(b.roots.beats.get("B")?.get("status"), JSON.stringify("done"));
    press(undoA, a); net.settle();
    assert.equal(a.reader.row("B")?.fields.status, "done");
  }
});

// why: runs go clients [2,3] then [3,2], each forward, reverse, twice; in one unseen run the restored letters all carry
// the tag, which formatting clean-up decides by delivery order (appendix H); the next test shows it on plain Yjs
test("E14: an unseen narration tag on a removed row is lost when the removal is undone, as plain Yjs restores new letters", () => {
  const outcomes = [false, true].map(seen => runs(({ net, a, b, undoA }) => {
    remove(a, "B"); tag(b, narration("B"), 0, 1);
    if (seen) net.settle();
    press(undoA, a);
  }).map(reading => (reading[1] ?? "").replace(/<span class="tag-anchor"[^>]*>([^<]*)<\/span>/g, "[$1]")));
  const lost = "B: def / 2";
  assert.deepEqual(outcomes, [[lost, lost, lost, lost, "B: [def] / 2", lost], Array(6).fill(lost)]);
});

test("plain Yjs: a mark on one letter of a range another copy deleted and restored by undo covers every restored letter in one delivery order", () => {
  const settle = (reverse: boolean): string => {
    const seed = new Y.Doc(), a = new Y.Doc(), b = new Y.Doc();
    seed.clientID = 1; a.clientID = 3; b.clientID = 2;
    const source = seed.getText("t");
    source.insert(0, "abc", {}); source.insertEmbed(3, { b: "B" }, {}); source.insert(4, "def", {}); source.insertEmbed(7, { b: "C" }, {}); source.insert(8, "ghi", {});
    for (const doc of [a, b]) { doc.getText("t"); Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), "remote"); }
    const logs = new Map<Y.Doc, Uint8Array[]>([[a, []], [b, []]]);
    for (const doc of [a, b]) doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") logs.get(doc)?.push(update); });
    const undo = new Y.UndoManager(a.getText("t"), { trackedOrigins: new Set(["a"]), captureTimeout: 0 });
    a.transact(() => { a.getText("t").delete(3, 4); }, "a");
    b.transact(() => { b.getText("t").format(4, 1, { k: true }); }, "b");
    undo.undo();
    for (const [from, to] of [[a, b], [b, a]] as const) for (const update of reverse ? [...logs.get(from) ?? []].reverse() : logs.get(from) ?? []) Y.applyUpdate(to, update, "remote");
    const views = [a, b].map(doc => JSON.stringify(doc.getText("t").toDelta()));
    assert.equal(views[0], views[1]);
    return views[0] ?? "";
  };
  assert.equal(settle(false), JSON.stringify([{ insert: "abc" }, { insert: { b: "B" } }, { insert: "def" }, { insert: { b: "C" } }, { insert: "ghi" }]));
  assert.equal(settle(true), JSON.stringify([{ insert: "abc" }, { insert: { b: "B" } }, { insert: "def", attributes: { k: true } }, { insert: { b: "C" } }, { insert: "ghi" }]));
});

test("E14: a move made unseen while a row is removed survives the removal's undo, and the row returns where it was moved", () => {
  const reading = settled(({ a, b, undoA }) => {
    const rank = String(a.roots.beats.get("E")?.get("rank")) + "V";
    remove(a, "B"); setField(b, "B", "rank", rank);
    press(undoA, a);
  });
  assert.deepEqual(reading, ["A: abc / 1", "C: ghi / 3", ...TAIL, "B: def / 2"]);
});

test("E10 and decision 9: a row split while another copy moves it leaves the split-off half at the old place", () => {
  const reading = settled(({ a, b }) => {
    const rank = String(a.roots.beats.get("E")?.get("rank")) + "V";
    setField(a, "B", "rank", rank); split(b, "B", 1);
  });
  assert.deepEqual(reading, ["A: abc / 1", "N: ef / ", "C: ghi / 3", ...TAIL, "B: d / 2"]);
});

test("E9: both copies removing a row remove it once; both removing and both undoing store its narration twice (rule (c), slice 3b)", () => {
  assert.deepEqual(settled(({ a, b }) => { remove(a, "B"); remove(b, "B"); }), ["A: abc / 1", "C: ghi / 3", ...TAIL]);
  assert.deepEqual(settled(({ net, a, b, undoA, undoB }) => { remove(a, "B"); remove(b, "B"); net.settle(); press(undoA, a); press(undoB, b); }), [
    "A: abc / 1", "B:  / 2", "C: ghi / 3", ...TAIL, "unplaced b:A repeated 6"
  ]);
});

test("E14: a join or unjoin made unseen on a removed row is stored in its kept record and takes effect if the removal is undone", () => {
  assert.deepEqual(settled(({ a, b }) => { remove(a, "B"); join(b, "B", "A"); }), ["A: abc / 1", "C: ghi / 3", ...TAIL]);
  assert.deepEqual(settled(({ a, b, undoA }) => { remove(a, "B"); join(b, "B", "A"); press(undoA, a); }), ["A: abc / 1", "B: def / 2", "C: ghi / 3", ...TAIL, "problem join-not-read beats/B"]);
  assert.deepEqual(settled(({ a, b }) => { remove(a, "B"); join(b, "C", "B"); }), ["A: abc / 1", "C: ghi / 3", ...TAIL, "problem join-not-read beats/C"]);
  assert.deepEqual(settled(({ net, a, b, undoA }) => { join(a, "B", "A"); net.settle(); remove(a, "B"); unjoinNativeRow(b, "B"); press(undoA, a); }), ["A: abc / 1", "B: def / 2", "C: ghi / 3", ...TAIL]);
});

test("E11: a row removed while another copy types in it, then two same-moment splits at the next row's start, store the letter once", () => {
  const copies: NativeScript[] = [];
  const readings = runs(({ net, a, b }) => {
    copies.push(a);
    remove(a, "A"); typeIn(b, narration("A"), 1, "Ψ"); net.settle();
    split(a, "B", 0); split(b, "B", 0);
  });
  for (const copy of copies) {
    const head = copy.roots.segments.get("b:A")?.get("text");
    assert.ok(head instanceof Y.Text);
    assert.equal(head.toString().charAt(0), "Ψ");
    assert.match(storedOf(copy), /^Ψ\[/);
    assert.equal(storedOf(copy).split("Ψ").length - 1, 1, storedOf(copy));
  }
  for (const reading of readings) {
    assert.equal(reading.join(" ").split("Ψ").length - 1, 0, "the letter reads only as unplaced text before slice 3b's rule (a)");
    assert.ok(reading.includes("unplaced b:A no-head 1"), reading.join(" | "));
    assert.equal(reading.filter(line => /^N: (def)? \/ $/.test(line)).length, 2, reading.join(" | "));
  }
});

// why: design section 10 and appendix N: Alice splits B at its start, Bob removes the new row, Alice undoes her split
// and Bob undoes his removal, which brings back N's boundary and narration without its record or visual cell
function fourSteps(world: World, whileLive?: (created: string) => void): string {
  const { net, a, b, undoA, undoB } = world;
  const created = split(a, "B", 0);
  whileLive?.(created);
  net.settle();
  remove(b, created); net.settle();
  press(undoA, a); net.settle();
  press(undoB, b); net.settle();
  return created;
}

test("E17's four steps: the row's boundary returns without its record; the reader shows its text unplaced until slice 3b's rule (g)", () => {
  const readings = runs(world => { fourSteps(world); });
  for (const reading of readings) {
    assert.deepEqual(reading.filter(line => !line.startsWith("unplaced")), ["A: abc / 1", "B:  / 2", "C: ghi / 3", ...TAIL]);
    assert.deepEqual(reading.filter(line => line.startsWith("unplaced")), ["unplaced b:A no-record 3"]);
  }
});

test("E17's command table on the four-step state: every command aimed at the hidden row refuses and writes nothing; commands on B work", () => {
  for (const clients of CLIENTS) {
    const { net, all: [a, b], undo: [undoA, undoB] } = copiesOf(BASE, clients);
    assert.ok(a && b && undoA && undoB);
    const inB = { caret: caret(a, "B", 1), range: anchorNativeText(a, narration("B"), 1, 2) };
    assert.ok(inB.range.kind === "anchored");
    let inN: { caret: NativeTextRange; range: NativeTextRange } | null = null;
    const n = fourSteps({ net, a, b, undoA, undoB }, created => {
      const range = anchorNativeText(a, narration(created), 0, 2);
      assert.ok(range.kind === "anchored");
      inN = { caret: caret(a, created, 1), range: range.range };
    });
    const live = inN as { caret: NativeTextRange; range: NativeTextRange } | null;
    assert.ok(live);
    assert.match(storedOf(a), new RegExp(`^\\[A\\]abc\\[B\\]\\[${n}\\]def\\[C\\]`));
    const before = stateOf(a), aimed: Record<string, unknown> = {
      "split with a caret anchored in B before the steps": splitNativeRow(a, inB.caret),
      "split with a caret anchored in N while it was live": splitNativeRow(a, live.caret),
      "anchor in N": anchorNativeText(a, narration(n), 0).kind, "anchor in N's visual": anchorNativeText(a, visual(n), 0).kind,
      "type with a range anchored in B before the steps": replaceNativeText(a, inB.range.range, [{ text: "x", marks: {} }]).kind,
      "type with a range anchored in N while it was live": replaceNativeText(a, live.range, [{ text: "x", marks: {} }]).kind,
      "bold with a range anchored in B before the steps": formatNativeText(a, inB.range.range, { kind: "plain", mark: "b", on: true }),
      "bold with a range anchored in N while it was live": formatNativeText(a, live.range, { kind: "plain", mark: "b", on: true }),
      "join N up to B": joinNativeRow(a, n, "B", " "), "join C up to N": joinNativeRow(a, "C", n, " "), "unjoin N": unjoinNativeRow(a, n), "remove N": removeNativeRows(a, [n]),
      "remove B and N": removeNativeRows(a, ["B", n])
    };
    assert.deepEqual(aimed, {
      "split with a caret anchored in B before the steps": { kind: "refused", reason: "range" },
      "split with a caret anchored in N while it was live": { kind: "refused", reason: "missing" },
      "anchor in N": "refused", "anchor in N's visual": "refused",
      "type with a range anchored in B before the steps": "recovery", "type with a range anchored in N while it was live": "recovery",
      "bold with a range anchored in B before the steps": { kind: "refused", reason: "range" },
      "bold with a range anchored in N while it was live": { kind: "refused", reason: "missing" },
      "join N up to B": { kind: "refused", reason: "missing" }, "join C up to N": { kind: "refused", reason: "missing" },
      "unjoin N": { kind: "refused", reason: "missing" }, "remove N": { kind: "refused", reason: "missing" }, "remove B and N": { kind: "refused", reason: "missing" }
    }, `clients ${clients.join(",")}`);
    assert.deepEqual(stateOf(a), before);
    typeIn(a, narration("B"), 0, "y");
    const m = split(a, "B", 1);
    join(a, "B", "A"); assert.deepEqual(unjoinNativeRow(a, "B"), { kind: "written" });
    net.settle();
    assert.deepEqual(rowsOf(b), ["A: abc", "B: y", `${m}: `, "C: ghi", "D: jkl", "E: pqr"]);
    assert.match(storedOf(b), new RegExp(`^\\[A\\]abc\\[B\\]y\\[${m}\\]\\[${n}\\]def\\[C\\]`));
    remove(a, "B", m); net.settle();
    assert.deepEqual(net.agree().filter(line => !line.startsWith("#") && !/^[A-E]:/.test(line)), ["unplaced b:A no-record 3"]);
  }
});

test("undo of a split takes back its boundary, record and cell; redo brings them back; undo and redo of a removal keep the same record", () => {
  const { net, all: [a, b], undo: [undoA] } = copiesOf(BASE);
  assert.ok(a && b && undoA);
  const created = split(a, "B", 1), record = a.roots.beats.get(created);
  press(undoA, a);
  assert.deepEqual([a.roots.beats.has(created), a.roots.visuals.has(created), storedOf(a).startsWith("[A]abc[B]def[C]")], [false, false, true]);
  press(undoA, a, true);
  assert.deepEqual(rowsOf(a).slice(0, 3), ["A: abc", "B: d", `${created}: ef`]);
  assert.notEqual(a.roots.beats.get(created), record);
  undoA.stopCapturing();
  const kept = a.roots.beats.get("C");
  remove(a, "C"); press(undoA, a);
  assert.equal(a.roots.beats.get("C"), kept);
  press(undoA, a, true);
  net.settle();
  assert.deepEqual(net.agree(), ["A: abc / 1", "B: d / 2", `${created}: ef / `, ...TAIL]);
  assert.equal(b.roots.visuals.get("C")?.toString(), "3");
});
