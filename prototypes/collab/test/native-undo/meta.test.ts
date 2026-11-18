import assert from "node:assert/strict";
import test from "node:test";
import { changedDocument } from "../../src/native-undo/layer.ts";
import { settled, world } from "./kit.ts";

test("the caret kept with a step comes back where the step began, after another person's typing moved the text", () => {
  const w = world([{ id: "R1", audioText: "abcd" }]);
  w.type("A", "R1", "audioText", 2, "XY"); settled(w, "typed");
  w.type("B", "R1", "audioText", 0, "Q"); settled(w, "remote");
  w.undo("A");
  const caret = w.copy("A").layer.restored;
  assert.ok(caret);
  assert.equal(caret.index, 3);
  assert.equal(caret.text.toString().charAt(caret.index), "c");
  w.redo("A", { beat: "R1", field: "audioText", offset: 3 });
  w.undo("A");
  assert.equal(w.copy("A").layer.restored?.index, 3);
});

test("capturing the relative caret before erasing bc restores index 3 in abcd", () => {
  const w = world([{ id: "R1", audioText: "abcd" }]);
  w.erase("A", "R1", "audioText", 1, 3);
  assert.deepEqual(settled(w, "erased"), ["R1: ad (todo)"]);
  assert.ok(w.undo("A"));
  assert.deepEqual(settled(w, "undone"), ["R1: abcd (todo)"]);
  assert.equal(w.copy("A").layer.restored?.index, 3);
});

test("on an undo press the document observers and Yjs update event come before the caret is restored", () => {
  const w = world([{ id: "R1", audioText: "abcd" }]);
  w.type("A", "R1", "audioText", 2, "XY"); settled(w, "typed");
  const a = w.copy("A"), order: string[] = [];
  a.replica.segments.observeDeep(() => { order.push("observe"); });
  a.layer.manager.on("stack-item-added", event => { order.push(`added to ${event.type}`); });
  a.replica.doc.on("afterTransaction", transaction => { if (changedDocument(transaction)) order.push("after transaction"); });
  a.replica.doc.on("update", () => { order.push("update"); });
  a.layer.manager.on("stack-item-popped", () => { order.push("popped"); });
  w.undo("A");
  assert.deepEqual(order, ["observe", "added to redo", "after transaction", "update", "popped"]);
});
