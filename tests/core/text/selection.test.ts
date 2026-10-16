import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellKeys,
  keptUnits,
  mapThroughCell,
  resolveSelection,
  takeSnapshot
} from "../../../src/core/text/selection.ts";
import type { CellPoints, ModelSelection, SelectionField, SelectionWorld } from "../../../src/core/text/selection.ts";
import { B, GRIN, NBSP, T } from "./cells.ts";

const keys = (text: string): string[] => cellKeys([T(text)]);

function caret(pos: number, affinity: "backward" | "forward" = "backward"): CellPoints {
  return { anchor: pos, head: pos, affinity: affinity };
}

function range(anchor: number, head: number): CellPoints {
  return { anchor: anchor, head: head, affinity: "backward" };
}

function through(sel: CellPoints, before: string, after: string): CellPoints {
  return mapThroughCell(sel, keys(before), keys(after));
}

test("a cell's keys are one per position: each UTF-16 unit, a line break, and one per b-roll key carrying its id", () => {
  const cell = [T("ab\nc"), B("bs1"), T(GRIN)];
  assert.deepEqual(cellKeys(cell), ["a", "b", "\n", "c", "\u{FFFC}bs1", GRIN.charAt(0), GRIN.charAt(1)]);
  assert.deepEqual(cellKeys([T("a" + NBSP + "b")]), ["a", " ", "b"], "a no-break space is the same position as a space");
});

test("a caret maps through an edit before it, after it, and around it, by the text it sits next to and not its offset", () => {
  assert.deepEqual(through(caret(5), "Mine one.", "Ours: Mine one."), caret(11), "text inserted before the caret moves it along");
  assert.deepEqual(through(caret(5), "Mine one.", "Mine one. More."), caret(5), "text added after the caret leaves it");
  assert.deepEqual(through(caret(9), "Mine one.", "Mine, then one."), caret(15), "a word inserted in between moves a caret after it");
  assert.deepEqual(through(caret(5), "Mine one.", "one."), caret(0), "a deleted word before the caret takes its place with it");
  assert.deepEqual(through(caret(5), "Mine one.", "Theirs one."), caret(7), "a replaced word before the caret moves it by the difference");
});

test("a caret where a collaborator inserted text stays on the side its affinity binds it to", () => {
  assert.deepEqual(through(caret(4, "backward"), "Mine one.", "Mine new one."), caret(4, "backward"), "bound to the word before it");
  assert.deepEqual(through(caret(5, "forward"), "Mine one.", "Mine new one."), caret(9, "forward"), "bound to the word after it");
});

test("a caret inside or at the end of a word that was replaced lands at that word's place", () => {
  assert.deepEqual(through(caret(4), "Mine two.", "Theirs two."), caret(6), "the end of the word maps to the end of its replacement");
  assert.deepEqual(through(caret(2), "Mine two.", "Theirs two."), caret(6, "backward"));
  assert.deepEqual(through(caret(2, "forward"), "Mine two.", "Theirs two."), caret(0, "forward"), "bound forward: the start of the replacement");
  assert.deepEqual(through(caret(0, "forward"), "Mine two.", "Theirs two."), caret(0, "forward"), "the start of the cell stays the start");
  assert.deepEqual(through(caret(9), "Mine two.", "Mine three"), caret(10), "the end of the cell stays the end");
});

test("line breaks and b-roll keys are positions of their own, so one added before the caret moves it by one", () => {
  const before = cellKeys([T("Wide shot. Then close.")]);
  const withBreak = cellKeys([T("Wide shot.\nThen close.")]);
  assert.deepEqual(mapThroughCell(caret(15), before, withBreak), caret(15), "a space became a line break: same position");
  const added = cellKeys([T("Intro\nWide shot. Then close.")]);
  assert.deepEqual(mapThroughCell(caret(15), before, added), caret(21));
  const withKey = cellKeys([B("bs1"), T(" Wide shot. Then close.")]);
  assert.deepEqual(mapThroughCell(caret(15), before, withKey), caret(17), "the key and its space");
});

test("a caret next to a b-roll key keeps to its side of the key when the key moves", () => {
  const before = cellKeys([T("ab"), B("bs1"), T("cd")]);
  const after = cellKeys([T("xx ab"), B("bs1"), T("cd")]);
  assert.deepEqual(mapThroughCell(caret(2, "forward"), before, after), caret(5, "forward"), "before the key");
  assert.deepEqual(mapThroughCell(caret(3, "backward"), before, after), caret(6, "backward"), "after the key");
  const keyGone = cellKeys([T("abcd")]);
  assert.deepEqual(mapThroughCell(caret(3, "backward"), before, keyGone), caret(2, "backward"), "the key was removed: the caret falls back to the text before it");
});

test("a selection keeps its direction and its words when nothing inside it changed", () => {
  assert.deepEqual(through(range(5, 8), "Mine one two.", "Ours: Mine one two."), range(11, 14), "forward");
  assert.deepEqual(through(range(8, 5), "Mine one two.", "Ours: Mine one two."), range(14, 11), "backward");
  assert.deepEqual(through(range(5, 8), "Mine one two.", "Mine one two, three."), range(5, 8));
});

test("a selection whose words a collaborator changed collapses to its head, so the next keystroke cannot type over their words", () => {
  assert.deepEqual(through(range(5, 12), "Mine one two.", "Mine one and two."), caret(16, "backward"), "a word inserted inside it");
  assert.deepEqual(through(range(12, 5), "Mine one two.", "Mine uno two."), caret(5, "forward"), "a word inside it replaced, backward selection");
  assert.deepEqual(through(range(5, 9), "Mine one two.", "Mine two."), caret(5, "backward"), "every selected word deleted");
});

test("a mapped position never cuts an emoji in two", () => {
  const before = keys("a" + GRIN + "b");
  const after = keys("xa" + GRIN + "b");
  assert.deepEqual(mapThroughCell(caret(3), before, after), caret(4));
  assert.deepEqual(mapThroughCell(caret(2), before, keys("a" + GRIN + GRIN + "b")).head % 2, 1, "never between the halves of a pair");
});

test("kept units pair every unchanged position with its new place and mark the rest -1", () => {
  assert.deepEqual(Array.from(keptUnits(keys("ab cd"), keys("ab XY cd"))), [0, 1, 2, 6, 7]);
  assert.deepEqual(Array.from(keptUnits(keys("one"), keys("two"))), [-1, -1, -1]);
  assert.deepEqual(Array.from(keptUnits([], keys("new"))), []);
});

test("a long cell rewritten end to end still maps without the diff running away", () => {
  const before = keys(Array.from({ length: 3000 }, (_, i) => "w" + i).join(" "));
  const after = keys(Array.from({ length: 3000 }, (_, i) => "v" + i).join(" "));
  const got = mapThroughCell(caret(before.length), before, after);
  assert.ok(got.head >= 0 && got.head <= after.length);
});

interface Row { id: string; visualText: string[]; audioText: string[] }

function world(epoch: number, rows: Row[]): SelectionWorld {
  return {
    epoch: epoch,
    order: rows.map((r) => r.id),
    keys: (id: string, field: SelectionField) => {
      const row = rows.find((r) => r.id === id);
      return row ? row[field] : null;
    }
  };
}

function row(id: string, audio: string, visual = ""): Row {
  return { id: id, visualText: keys(visual), audioText: keys(audio) };
}

function sel(rowId: string, anchor: number, head = anchor, affinity: "backward" | "forward" = "backward", epoch = 1): ModelSelection {
  return { epoch: epoch, rowId: rowId, field: "audioText", anchor: anchor, head: head, affinity: affinity };
}

function at(rowId: string, anchor: number, head = anchor, affinity: "backward" | "forward" = "backward"): ModelSelection {
  return sel(rowId, anchor, head, affinity);
}

const START = [row("r1", "First one."), row("r2", "Second two."), row("r3", "Third three.")];

function snapAt(selection: ModelSelection, rows: Row[] = START) {
  const r = rows.find((x) => x.id === selection.rowId) as Row;
  return takeSnapshot(selection, r[selection.field], rows.map((x) => x.id));
}

test("a selection in another document epoch resolves to nothing: a replaced document never receives the old caret", () => {
  assert.equal(resolveSelection(snapAt(at("r2", 3)), world(2, START)), null);
  assert.equal(resolveSelection(null, world(1, START)), null);
});

test("a selection resolves in its own cell through the change, keeping epoch, scene and field", () => {
  const got = resolveSelection(snapAt(at("r2", 7)), world(1, [row("r1", "First one."), row("r2", "Now Second two."), row("r3", "Third three.")]));
  assert.deepEqual(got, at("r2", 11));
});

test("when the selected scene is gone, the selection moves to the end of the same field of the scene before it", () => {
  const got = resolveSelection(snapAt(at("r2", 3)), world(1, [row("r1", "First one."), row("r3", "Third three.")]));
  assert.deepEqual(got, at("r1", "First one.".length));
});

test("when the selected first scene is gone, the selection moves to the start of the next scene that is left; with no scenes, there is none", () => {
  assert.deepEqual(resolveSelection(snapAt(at("r1", 3)), world(1, [row("r3", "Third three.")])), at("r3", 0, 0, "forward"));
  assert.equal(resolveSelection(snapAt(at("r1", 3)), world(1, [])), null);
  assert.deepEqual(resolveSelection(snapAt(at("r1", 3)), world(1, [row("r9", "New.")])), at("r9", 0, 0, "forward"), "only new scenes: the first of them");
});

test("a scene joined into the one before it carries the selection into the joined text", () => {
  const joined = [row("r1", "First one. Second two."), row("r3", "Third three.")];
  assert.deepEqual(resolveSelection(snapAt(at("r2", 3)), world(1, joined)), at("r1", "First one. ".length + 3));
  assert.deepEqual(resolveSelection(snapAt(at("r2", 6, 0)), world(1, joined)), at("r1", 17, 11), "a backward selection keeps its direction");
});

test("a scene split after the selection keeps it; one split before it moves it into the new scene", () => {
  const split = [row("r1", "First one."), row("r2", "Second "), row("r9", "two."), row("r3", "Third three.")];
  assert.deepEqual(resolveSelection(snapAt(at("r2", 3)), world(1, split)), at("r2", 3));
  assert.deepEqual(resolveSelection(snapAt(at("r2", 9)), world(1, split)), at("r9", 2));
  assert.deepEqual(resolveSelection(snapAt(at("r2", 7, 7, "forward")), world(1, split)), at("r9", 0, 0, "forward"), "at the cut, bound forward");
  assert.deepEqual(resolveSelection(snapAt(at("r2", 7, 7, "backward")), world(1, split)), at("r2", 7), "at the cut, bound backward");
  assert.deepEqual(resolveSelection(snapAt(at("r2", 2, 9)), world(1, split)), at("r9", 2), "across the cut: the head");
});

test("a snapshot clamps what it is given to the cell it was taken against", () => {
  const snap = takeSnapshot(at("r1", -4, 99), keys("abc"), ["r1"]);
  assert.deepEqual([snap.selection.anchor, snap.selection.head], [0, 3]);
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.keys) && Object.isFrozen(snap.selection));
});
