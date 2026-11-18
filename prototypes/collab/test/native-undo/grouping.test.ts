import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { NativeReplica, nativeCopy } from "../../src/native/variant.ts";
import { UndoLayer } from "../../src/native-undo/layer.ts";
import type { World } from "../../src/native-undo/harness.ts";
import { seen, settled, stacks, world } from "./kit.ts";

const ROWS = [{ id: "R1", audioText: "", visualText: "" }];

function keys(w: World, name: string, text: string, gap = 100, at = 0, field: "audioText" | "visualText" = "audioText"): void {
  [...text].forEach((char, index) => { w.clock += gap; w.type(name, "R1", field, at + index, char); });
}

test("typing groups into word-sized steps: a word typed after a space starts a new step", () => {
  const w = world(ROWS);
  keys(w, "A", "hello big world");
  assert.deepEqual(stacks(w, "A"), [3, 0]);
  w.undo("A");
  assert.deepEqual(settled(w, "undo"), ["R1: hello big  (todo)"]);
  w.undo("A");
  assert.deepEqual(settled(w, "undo"), ["R1: hello  (todo)"]);
});

test("a second without typing, another cell, a command, a selection replaced, or an undo each start a new step", () => {
  const w = world(ROWS);
  keys(w, "A", "ab"); keys(w, "A", "c", 1000, 2); keys(w, "A", "d", 100, 3);
  assert.deepEqual(stacks(w, "A"), [2, 0]);
  keys(w, "A", "x", 100, 0, "visualText");
  assert.deepEqual(stacks(w, "A"), [3, 0]);
  w.command("A", [{ do: "set", beat: "R1", key: "status", value: "ready" }]);
  keys(w, "A", "y", 100, 1, "visualText");
  assert.deepEqual(stacks(w, "A"), [5, 0]);
  w.clock += 100; w.replace("A", "R1", "audioText", 0, 2, "Z");
  w.clock += 100; w.type("A", "R1", "audioText", 1, "W");
  assert.deepEqual(stacks(w, "A"), [7, 0]);
  w.undo("A"); w.clock += 100; w.type("A", "R1", "audioText", 1, "V");
  assert.deepEqual(stacks(w, "A"), [7, 0]);
  settled(w, "end");
});

test("backspace within the group joins it, and another person's typing arriving between keystrokes does not split it", () => {
  const w = world([{ id: "R1", audioText: "--" }]);
  keys(w, "A", "abc", 100, 1);
  w.type("B", "R1", "audioText", 0, "Q"); w.settle();
  w.clock += 100; w.erase("A", "R1", "audioText", 4, 5);
  w.clock += 100; w.type("A", "R1", "audioText", 4, "d");
  assert.deepEqual(stacks(w, "A"), [1, 0]);
  assert.deepEqual(settled(w, "typed"), ["R1: Q-abd- (todo)"]);
  w.undo("A");
  assert.deepEqual(settled(w, "undo"), ["R1: Q-- (todo)"]);
});

test("the bound keeps the newest 200 steps; the oldest five cannot be undone", () => {
  const w = world(ROWS);
  for (let index = 0; index < 205; index++) w.command("A", [{ do: "set", beat: "R1", key: "lengthSeconds", value: index }]);
  assert.deepEqual(stacks(w, "A"), [200, 0]);
  assert.equal(w.copy("A").layer.dropped, 5);
  for (let index = 0; index < 200; index++) assert.ok(w.undo("A"));
  assert.equal(w.undo("A"), null);
  settled(w, "all undone");
  assert.equal(w.copy("A").replica.beats.get("R1")?.get("lengthSeconds"), 4);
  assert.deepEqual(seen(w), ["R1:  (todo)"]);
});

test("undo history keeps deleted text in the editing copy; the bound does not release it; a copy loaded from stored state does not hold it", () => {
  const sizes = [200, Number.POSITIVE_INFINITY].map(bound => {
    const seed = new NativeReplica(900, 0, "act");
    seed.hydrate({ rows: [{ id: "R1", audioText: "", visualText: "" }] });
    const replica = nativeCopy(seed, 1), layer = new UndoLayer(replica, { bound, now: () => 0 });
    for (let index = 0; index < 1000; index++) {
      layer.command(() => { replica.splice("R1", "audioText", 0, 0, [{ text: "abcdefghij", marks: {} }]); });
      layer.command(() => { replica.splice("R1", "audioText", 0, 10, []); });
    }
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(replica.doc));
    const result = { editing: Y.encodeStateAsUpdate(replica.doc).length, fresh: Y.encodeStateAsUpdate(fresh).length };
    replica.destroy(); seed.destroy(); fresh.destroy();
    return result;
  });
  const [bounded, unbounded] = sizes as [{ editing: number; fresh: number }, { editing: number; fresh: number }];
  assert.ok(bounded.editing > 10_000, `editing copy ${bounded.editing} bytes`);
  assert.ok(bounded.fresh < 1_000, `fresh copy ${bounded.fresh} bytes`);
  assert.equal(bounded.editing, unbounded.editing);
});
