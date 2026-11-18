import assert from "node:assert/strict";
import test from "node:test";
import type { Part, World } from "../../src/native-undo/harness.ts";
import { field, narration, records, settled, stacks, world } from "./kit.ts";

const ROWS = [{ id: "R1", audioText: "abcdef", visualText: "vw" }, { id: "R2", audioText: "ghij" }];
const COMPOUND: readonly Part[] = [
  { do: "set", beat: "R1", key: "paragraphStart", value: true },
  { do: "format", beat: "R1", field: "audioText", from: 1, to: 4, mark: "b", on: true },
  { do: "record", root: "tags", id: "T1", fields: { name: "Alpha", colour: "red" } },
  { do: "insert", beat: "R1", field: "audioText", at: 2, text: "XY", marks: ["b"] }
];

interface State { text: string; flag: unknown; removed: boolean; tags: unknown; stacks: Record<string, [number, number]> }

function state(w: World): State {
  return {
    text: narration(w, "R1"), flag: field(w, "R1", "paragraphStart"), removed: field(w, "R1", "removed") !== undefined, tags: records(w).tags,
    stacks: Object.fromEntries(w.copies.map(copy => [copy.name, [copy.layer.manager.undoStack.length, copy.layer.manager.redoStack.length]]))
  };
}

function press(w: World, name: string, kind: "undo" | "redo", expected: Omit<State, "stacks">, after: [number, number]): void {
  const updates = w.copy(name).layer.updates;
  assert.ok(kind === "undo" ? w.undo(name) : w.redo(name), `${name} ${kind} applied`);
  assert.equal(w.copy(name).layer.updates - updates, 1, `${name} ${kind}: one Yjs update event`);
  settled(w, `${name} ${kind}`);
  const got = state(w);
  assert.deepEqual({ ...got, stacks: undefined }, { ...expected, stacks: undefined }, `${name} ${kind}`);
  assert.deepEqual(got.stacks[name], after, `${name} ${kind} stacks`);
}

test("a compound command with remote changes made after seeing it: undo, redo, undo on each copy in turn", () => {
  const w = world(ROWS);
  w.command("A", COMPOUND);
  assert.deepEqual(stacks(w, "A"), [1, 0]);
  settled(w, "compound");
  w.type("B", "R1", "audioText", 4, "Q", ["b"]); settled(w, "B types in the same cell");
  w.command("C", [{ do: "format", beat: "R1", field: "audioText", from: 1, to: 4, mark: "b", on: true }]); settled(w, "C formats over the same range");
  w.command("B", [{ do: "field", root: "tags", id: "T1", key: "colour", value: "blue" }, { do: "field", root: "tags", id: "T1", key: "note", value: "from B" }]); settled(w, "B edits the record");
  w.command("C", [{ do: "set", beat: "R1", key: "removed", value: w.removal("C", "C") }]); settled(w, "C removes the beat");
  const full = { text: "a[bXYQcd|b]ef", flag: true, removed: true, tags: { T1: { name: "Alpha", colour: "blue", note: "from B" } } };
  assert.deepEqual({ ...state(w), stacks: undefined }, { ...full, stacks: undefined });
  const undone = { text: "a[b|b]Qcdef", flag: undefined, removed: true, tags: { T1: { colour: "blue", note: "from B" } } };
  const a = w.copy("A").replica, observed = new Set<string>();
  for (const root of ["segments", "beats", "tags"]) a.doc.getMap(root).observeDeep(() => { observed.add(root); });
  press(w, "A", "undo", undone, [0, 1]);
  assert.deepEqual(observed, new Set(["segments", "beats", "tags"]));
  press(w, "A", "redo", full, [1, 0]);
  press(w, "A", "undo", undone, [0, 1]);
  const recoloured = { ...undone, tags: { T1: { colour: "red" } } };
  press(w, "B", "undo", recoloured, [1, 1]);
  press(w, "B", "redo", undone, [2, 0]);
  press(w, "B", "undo", recoloured, [1, 1]);
  press(w, "C", "undo", { ...recoloured, removed: false }, [1, 1]);
  press(w, "C", "redo", recoloured, [2, 0]);
  press(w, "C", "undo", { ...recoloured, removed: false }, [1, 1]);
});

test("a compound command with remote changes made at the same time, unseen: undo, redo, undo on each copy in turn", () => {
  const w = world(ROWS);
  w.command("A", COMPOUND);
  w.type("B", "R1", "audioText", 2, "Q");
  w.command("C", [{ do: "format", beat: "R1", field: "audioText", from: 1, to: 4, mark: "b", on: true }]);
  w.command("C", [{ do: "set", beat: "R1", key: "removed", value: w.removal("C", "C") }]);
  settled(w, "all delivered");
  const full = { text: "a[bXYQcd|b]ef", flag: true, removed: true, tags: { T1: { name: "Alpha", colour: "red" } } };
  assert.deepEqual({ ...state(w), stacks: undefined }, { ...full, stacks: undefined });
  const undone = { text: "a[bQcd|b]ef", flag: undefined, removed: true, tags: {} };
  press(w, "A", "undo", undone, [0, 1]);
  press(w, "A", "redo", full, [1, 0]);
  press(w, "A", "undo", undone, [0, 1]);
  const typed = { ...undone, text: "a[bcd|b]ef" };
  press(w, "B", "undo", typed, [0, 1]);
  press(w, "B", "redo", undone, [1, 0]);
  press(w, "B", "undo", typed, [0, 1]);
  press(w, "C", "undo", { ...typed, removed: false }, [1, 1]);
  press(w, "C", "redo", typed, [2, 0]);
  press(w, "C", "undo", { ...typed, removed: false }, [1, 1]);
});

test("a compound command undone while another copy's edit of the created record is still in flight keeps that edit", () => {
  const w = world(ROWS);
  w.command("A", COMPOUND); settled(w, "compound");
  w.command("B", [{ do: "field", root: "tags", id: "T1", key: "note", value: "late" }]);
  w.type("B", "R1", "visualText", 2, "Z");
  w.undo("A");
  settled(w, "crossing delivered");
  assert.deepEqual(records(w).tags, { T1: { note: "late" } });
  assert.equal(narration(w, "R1"), "abcdef");
  w.redo("A"); settled(w, "redo");
  assert.deepEqual(records(w).tags, { T1: { name: "Alpha", colour: "red", note: "late" } });
});
