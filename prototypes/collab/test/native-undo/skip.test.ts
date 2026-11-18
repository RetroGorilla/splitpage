import assert from "node:assert/strict";
import test from "node:test";
import { field, narration, settled, stacks, world } from "./kit.ts";

const ROWS = [{ id: "R1", audioText: "abcd" }];
const ready = { do: "set", beat: "R1", key: "status", value: "ready" } as const;

test("skip 1: two people set the same status at once; the one whose write lost presses undo: the status stays, and that press undoes the step before", () => {
  const w = world(ROWS);
  w.type("A", "R1", "audioText", 0, "x"); settled(w, "x");
  w.command("A", [ready]); w.command("B", [ready]); settled(w, "both set ready");
  assert.ok(w.undo("A"));
  assert.deepEqual(settled(w, "undo"), ["R1: abcd (ready)"]);
  assert.deepEqual(stacks(w, "A"), [0, 1]);
});

test("skip 2: the same, pressed by the one whose write stands: the status is absent and reads as the default; redo brings it back", () => {
  const w = world(ROWS, { clients: [2, 1, 3] });
  w.command("A", [ready]); w.command("B", [ready]); settled(w, "both set ready");
  assert.ok(w.undo("A"));
  assert.deepEqual(settled(w, "undo"), ["R1: abcd (todo)"]);
  assert.equal(field(w, "R1", "status"), undefined);
  assert.ok(w.redo("A"));
  assert.deepEqual(settled(w, "redo"), ["R1: abcd (ready)"]);
});

test("skip 3: a typing step that deleted everything it typed has nothing to change; the press undoes the step before", () => {
  const w = world(ROWS);
  w.type("A", "R1", "audioText", 0, "x"); w.clock += 2000;
  w.type("A", "R1", "audioText", 5, "abc"); w.clock += 100;
  w.erase("A", "R1", "audioText", 5, 8);
  assert.deepEqual(settled(w, "typed and deleted"), ["R1: xabcd (todo)"]);
  assert.deepEqual(stacks(w, "A"), [2, 0]);
  assert.ok(w.undo("A"));
  assert.deepEqual(settled(w, "undo"), ["R1: abcd (todo)"]);
  assert.deepEqual(stacks(w, "A"), [0, 1]);
});

test("skip 4: the same bold made by two people at once: either undo removes only its own, the text stays bold until both have undone", () => {
  const w = world(ROWS);
  const bold = { do: "format", beat: "R1", field: "audioText", from: 0, to: 2, mark: "b", on: true } as const;
  w.command("A", [bold]); w.command("B", [bold]); settled(w, "both bold");
  assert.ok(w.undo("A"));
  assert.deepEqual(settled(w, "A undo"), ["R1: [ab|b]cd (todo)"]);
  assert.deepEqual(stacks(w, "A"), [0, 1]);
  assert.ok(w.undo("B"));
  assert.deepEqual(settled(w, "B undo"), ["R1: abcd (todo)"]);
});

test("skip 5: someone changed the status after seeing mine: my undo has nothing to change; the press undoes the step before", () => {
  const w = world(ROWS);
  w.type("A", "R1", "audioText", 0, "x");
  w.command("A", [ready]); settled(w, "ready");
  w.command("B", [{ ...ready, value: "shot" }]); settled(w, "shot");
  assert.ok(w.undo("A"));
  assert.deepEqual(settled(w, "undo"), ["R1: abcd (shot)"]);
  assert.deepEqual(stacks(w, "A"), [0, 1]);
});

for (const scheme of ["act", "name"] as const) test(`formatting skip with ${scheme} keys: unbolding b before undoing bold on bcd`, () => {
  const w = world(ROWS, { scheme });
  w.type("A", "R1", "audioText", 0, "x");
  w.command("A", [{ do: "format", beat: "R1", field: "audioText", from: 2, to: 5, mark: "b", on: true }]); settled(w, "bold");
  assert.equal(narration(w, "R1"), "xa[bcd|b]");
  w.command("B", [{ do: "format", beat: "R1", field: "audioText", from: 2, to: 3, mark: "b", on: false }]); settled(w, "B unbolds b");
  assert.ok(w.undo("A"));
  settled(w, "undo");
  assert.equal(narration(w, "R1"), scheme === "act" ? "ab[cd|b]" : "xab[cd|b]");
  assert.deepEqual(stacks(w, "A"), scheme === "act" ? [0, 1] : [1, 1]);
  assert.equal(w.stats.formatSkips, scheme === "act" ? 1 : 0);
});
