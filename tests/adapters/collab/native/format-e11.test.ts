import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dom } from "../../../../src/test/_dom.mjs";
import type { NativeMarkChange } from "../../../../src/adapters/collab/native/format-commands.ts";
import type { NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { RaceWorld, deleteRange, deltaOf, formatRange, printCell, readCell } from "./format-harness.ts";
import type { RaceWriter } from "./format-harness.ts";

after(() => { dom.window.close(); });

const CELL: NativeTextTarget = { beat: "one", cell: "narration" };
const TAG: NativeMarkChange = { kind: "tag", id: "t_prop", on: true }, KEY = "t:t_prop";

function settled(clients: readonly number[], history: (world: RaceWorld, a: RaceWriter, b: RaceWriter) => void): string {
  const world = new RaceWorld({ one: { audioText: "abcdef", visualText: "" } }, clients);
  try {
    const [a, b] = world.writers as [RaceWriter, RaceWriter];
    history(world, a, b);
    world.pullAll(); world.pullAll();
    const views = world.writers.map(writer => printCell(readCell(deltaOf(writer.script, CELL))));
    assert.ok(views.every(view => view === views[0]), views.join(" | "));
    for (const writer of world.writers) assert.ok(world.lateAgrees(writer, [CELL]));
    return views[0] ?? "";
  } finally { world.close(); }
}

const undo = (writer: RaceWriter): void => { assert.ok(writer.undo.undo()); writer.script.reader.refresh(); };

// why: design section 5a, first cause: the undo restores new copies of the letters and the tag stays on the deleted
// originals; whether the tagger's letters are the deleted ones depends on the client order
test("E11 tag loss, first cause: letters deleted and brought back by an undo the tagger had not seen come back untagged", () => {
  const history = (seen: boolean) => (world: RaceWorld, a: RaceWriter, b: RaceWriter): void => {
    assert.equal(deleteRange(a, CELL, 1, 4), "written");
    undo(a);
    if (seen) world.pullAll();
    assert.equal(formatRange(b, CELL, 1, 4, TAG), "written");
  };
  assert.equal(settled([1, 2], history(false)), "abcdef", "the remover's client id is lower: the tag is lost");
  assert.equal(settled([2, 1], history(false)), `a[bcd|${KEY}]ef`, "the remover's client id is higher: the tag is kept");
  for (const clients of [[1, 2], [2, 1]]) assert.equal(settled(clients, history(true)), `a[bcd|${KEY}]ef`, "control: a tagger who saw the undo keeps the tag");
});

// why: design section 5a, second cause: two people delete the same letter and both undo, so it shows twice; a tag
// put on the copy one of them restored is on one of the two in one client order
test("E11 tag loss, second cause: after a double delete and a double undo the letter shows twice, with the tag on one copy", () => {
  const history = (seen: boolean) => (world: RaceWorld, a: RaceWriter, b: RaceWriter): void => {
    assert.equal(deleteRange(a, CELL, 2, 3), "written");
    assert.equal(deleteRange(b, CELL, 2, 3), "written");
    world.pullAll();
    undo(a);
    undo(b);
    if (seen) world.pullAll();
    assert.equal(formatRange(a, CELL, 2, 3, TAG), "written");
  };
  assert.equal(settled([2, 1], history(false)), `abc[c|${KEY}]def`, "the tagger's client id is higher: one of the two is tagged");
  assert.equal(settled([1, 2], history(false)), `ab[cc|${KEY}]def`, "the tagger's client id is lower: both are tagged");
  for (const clients of [[1, 2], [2, 1]]) {
    assert.equal(settled(clients, history(true)), `ab[c|${KEY}]cdef`, "control: a tagger who saw both undos tags the copy chosen");
  }
});
