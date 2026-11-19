import assert from "node:assert/strict";
import test from "node:test";
import { raceThenUndo, seenThenUndo } from "../../src/native-rank-undo/mechanism.ts";

test("E15 mechanism: two writers set one key at once; the winner's plain undo leaves the key empty on every copy", () => {
  assert.deepEqual(raceThenUndo(false, "winner"), ["bob", undefined, undefined]);
  assert.deepEqual(raceThenUndo(false, "loser"), ["bob", "bob", "bob"]);
});

test("E15 mechanism: with ignoreRemoteMapChanges either undo brings back the value from before both writes", () => {
  assert.deepEqual(raceThenUndo(true, "winner"), ["bob", "start", "start"]);
  assert.deepEqual(raceThenUndo(true, "loser"), ["bob", "start", "start"]);
});

test("E15 mechanism: a seen later write by someone else; plain undo leaves it, ignoreRemoteMapChanges overwrites it", () => {
  assert.deepEqual(seenThenUndo(false), ["done", "done"]);
  assert.deepEqual(seenThenUndo(true), ["todo", "todo"]);
});

test("E15 mechanism: the same race on a key with no value before it; the winner's undo empties it in both modes", () => {
  for (const ignore of [false, true]) assert.deepEqual(raceThenUndo(ignore, "winner", null).slice(1), [undefined, undefined], String(ignore));
});
