import assert from "node:assert/strict";
import test from "node:test";
import { NativeReplica, nativeCopy } from "../../src/native/variant.ts";
import { UndoLayer } from "../../src/native-undo/layer.ts";
import { settled, world } from "./kit.ts";

test("a hydrated person has independently undoable fields", () => {
  const seed = new NativeReplica(900, 0, "act");
  seed.hydrate({ rows: [], people: [{ id: "P1", name: "First", role: "Reader" }] });
  const a = nativeCopy(seed, 1), layer = new UndoLayer(a);
  layer.setRecordField("people", "P1", "name", "Second");
  assert.deepEqual(layer.records().people, { P1: { id: "P1", name: "Second", role: "Reader", rank: 0 } });
  assert.ok(layer.undo());
  assert.deepEqual(layer.records().people, { P1: { id: "P1", name: "First", role: "Reader", rank: 0 } });
  assert.ok(layer.redo());
  assert.deepEqual(layer.records().people, { P1: { id: "P1", name: "Second", role: "Reader", rank: 0 } });
  a.destroy(); seed.destroy();
});

test("one emoji occupies two Yjs identities and survives typing, erase, undo and redo", () => {
  const w = world([{ id: "R1", audioText: "ab", visualText: "🙂" }]);
  w.type("A", "R1", "audioText", 1, "🙂");
  assert.deepEqual(settled(w, "typed"), ["R1: a🙂b / 🙂 (todo)"]);
  assert.ok(w.undo("A"));
  assert.deepEqual(settled(w, "undid typing"), ["R1: ab / 🙂 (todo)"]);
  assert.ok(w.redo("A"));
  assert.deepEqual(settled(w, "redid typing"), ["R1: a🙂b / 🙂 (todo)"]);
  w.erase("B", "R1", "audioText", 1, 3);
  assert.deepEqual(settled(w, "erased"), ["R1: ab / 🙂 (todo)"]);
  assert.ok(w.undo("B"));
  assert.deepEqual(settled(w, "undid erase"), ["R1: a🙂b / 🙂 (todo)"]);
});
