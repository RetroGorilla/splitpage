import assert from "node:assert/strict";
import { test } from "node:test";
import { libraryProbes } from "./probes.ts";

test("library probes: what the library's undo stack and main's status undo do on each limit's history", () => {
  assert.deepEqual(libraryProbes(), {
    "double restore": "abccd; abccd",
    "sequential status": "library undo: shot → ready → todo; main's undoStatus: shot → ready → ready",
    "later format": "abcd",
    "redone recovery": "edited characters per recovery entry: [1]",
    "redone mark, reversed delivery": "library undo and redo: a{b}b; library undo and redo, swapped ids: a{b}b; plain remove then add, no undo: a{b,c:C1}b{c:C1}; plain remove then add, no undo, swapped ids: a{b}b"
  });
});
