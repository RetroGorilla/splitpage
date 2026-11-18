import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { Composition } from "../../../src/native-e1/fold.ts";
import { agreed, local, room, shown, text } from "./replicas.ts";
import type { Replica } from "./replicas.ts";

const shownText = (doc: Y.Doc): string => shown(text(doc));
const start = (base: string, captureTimeout = 0) => {
  const shared = room([1, 2, 3], doc => { text(doc).insert(0, base); }, doc => [text(doc), doc.getMap("beats"), doc.getMap("visuals")], captureTimeout);
  const [a, b, c] = shared.replicas as [Replica, Replica, Replica];
  return { shared, a, b, c };
};
const commit = (a: Replica, edit: Composition): void => {
  a.undo.stopCapturing();
  assert.equal(edit.commit(a.origin), true);
};

test("A composes Y over bc while B types Q after d; C deletes a after the commit; undo and redo keep both others' changes", () => {
  const { shared, a, b, c } = start("abcd");
  const edit = new Composition(text(a.doc));
  edit.replace(1, 3, "Y");
  local(b, () => text(b.doc).insert(4, "Q"));
  shared.send(b, a);
  commit(a, edit);
  assert.equal(agreed(shared, shownText), "aYdQ");
  local(c, () => text(c.doc).delete(0, 1));
  assert.equal(agreed(shared, shownText), "YdQ");
  assert.notEqual(a.undo.undo(), null);
  assert.equal(agreed(shared, shownText), "bcdQ");
  assert.notEqual(a.undo.redo(), null);
  assert.equal(agreed(shared, shownText), "YdQ");
  shared.close();
});

test("A composes Y between b and c while B deletes c; B types Z after the commit; undo and redo", () => {
  const { shared, a, b } = start("abcd");
  const edit = new Composition(text(a.doc));
  edit.insert(2, "Y");
  local(b, () => text(b.doc).delete(2, 1));
  shared.send(b, a);
  commit(a, edit);
  assert.equal(agreed(shared, shownText), "abYd");
  local(b, () => text(b.doc).insert(4, "Z"));
  assert.equal(agreed(shared, shownText), "abYdZ");
  a.undo.undo();
  assert.equal(agreed(shared, shownText), "abdZ");
  a.undo.redo();
  assert.equal(agreed(shared, shownText), "abYdZ");
  shared.close();
});

test("B types Q inside A's committed XY; undo takes back X and Y only, redo puts them back around Q", () => {
  const { shared, a, b } = start("ab");
  const edit = new Composition(text(a.doc));
  edit.insert(1, "XY");
  commit(a, edit);
  shared.sync();
  local(b, () => text(b.doc).insert(2, "Q"));
  assert.equal(agreed(shared, shownText), "aXQYb");
  a.undo.undo();
  assert.equal(agreed(shared, shownText), "aQb");
  a.undo.redo();
  assert.equal(agreed(shared, shownText), "aXQYb");
  shared.close();
});

test("A's undo restores b although B deleted b too without seeing A's commit (library selective undo)", () => {
  const { shared, a, b } = start("abc");
  const edit = new Composition(text(a.doc));
  edit.delete(1, 2);
  commit(a, edit);
  local(b, () => text(b.doc).delete(1, 1));
  local(b, () => text(b.doc).insert(2, "Z"));
  assert.equal(agreed(shared, shownText), "acZ");
  a.undo.undo();
  assert.equal(agreed(shared, shownText), "abcZ");
  a.undo.redo();
  assert.equal(agreed(shared, shownText), "acZ");
  shared.close();
});

test("B splits between b and c while A composes Y over bc; undo restores b before the boundary and c after it", () => {
  const { shared, a, b } = start("abcd");
  const edit = new Composition(text(a.doc));
  edit.replace(1, 3, "Y");
  local(b, () => {
    text(b.doc).insertEmbed(2, { b: "2" });
    b.doc.getMap("beats").set("2", new Y.Map());
    b.doc.getMap("visuals").set("2", new Y.Text());
  });
  shared.send(b, a);
  commit(a, edit);
  assert.equal(agreed(shared, shownText), "aY|2|d");
  a.undo.undo();
  assert.equal(agreed(shared, shownText), "ab|2|cd");
  a.undo.redo();
  assert.equal(agreed(shared, shownText), "aY|2|d");
  shared.close();
});

test("a committed composition another copy deleted entirely is passed over: undo finds nothing, or the step before", () => {
  for (const older of [false, true]) {
    const { shared, a, b } = start("ab");
    if (older) local(a, () => text(a.doc).insert(0, "Q"));
    const edit = new Composition(text(a.doc));
    edit.insert(text(a.doc).length, "Y");
    commit(a, edit);
    shared.sync();
    local(b, () => text(b.doc).delete(text(b.doc).length - 1, 1));
    assert.equal(agreed(shared, shownText), older ? "Qab" : "ab");
    assert.equal(a.undo.undo() === null, !older);
    assert.equal(agreed(shared, shownText), "ab");
    shared.close();
  }
});

test("the composition is its own undo step inside the grouping time only because stopCapturing runs before the commit", () => {
  for (const stop of [true, false]) {
    const { shared, a } = start("ab", 60_000);
    local(a, () => text(a.doc).insert(0, "Q"));
    const edit = new Composition(text(a.doc));
    edit.insert(3, "Y");
    if (stop) a.undo.stopCapturing();
    edit.commit(a.origin);
    a.undo.undo();
    assert.equal(agreed(shared, shownText), stop ? "Qab" : "ab");
    shared.close();
  }
});
