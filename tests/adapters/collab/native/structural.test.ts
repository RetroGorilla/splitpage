import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { NativeScriptReader } from "../../../../src/adapters/collab/native/reader.ts";
import { freshlyShown, shown } from "./helpers.ts";
import { LARGE_BEATS, largeState, loadedCopy, narrationText, splitUpdate } from "./structural.ts";

after(() => { dom.window.close(); });

const state = largeState();

for (const [name, beat, offset, segments] of [["inside a segment", "B451", 60, 1], ["at a segment's start", "B480", 0, 1]] as const) {
  test(`a split from another copy, ${name}, reparses only its own segment on a warm reader`, () => {
    const copy = loadedCopy(state, 2), before = copy.reader.counts(), update = splitUpdate(state, beat, offset, "N1");
    Y.applyUpdate(copy.doc, update, "remote");
    const changes = copy.reader.refresh(), after = copy.reader.counts();
    assert.equal(after.parses - before.parses, segments);
    assert.equal(after.structures - before.structures, 1);
    assert.deepEqual([...changes.rows].sort(), [beat, "N1"].sort());
    assert.deepEqual(changes.gone, []);
    assert.equal(changes.outline, true);
    assert.equal(after.rowsBuilt - before.rowsBuilt, 2);
    const outline = copy.reader.outline().flatMap(entry => entry.kind === "row" ? [entry.id] : []);
    assert.equal(outline.length, LARGE_BEATS + 1);
    assert.equal(outline[outline.indexOf(beat) + 1], "N1");
    assert.equal(copy.reader.row(beat)?.audioText, "n".repeat(offset));
    assert.equal(copy.reader.row("N1")?.audioText, "n".repeat(120 - offset));
    assert.deepEqual(shown(copy), freshlyShown(copy));
  });
}

test("control: a full rebuild reads the same split but reparses every segment", () => {
  const copy = loadedCopy(state, 2);
  Y.applyUpdate(copy.doc, splitUpdate(state, "B451", 60, "N1"), "remote");
  const fresh = new NativeScriptReader(copy.roots);
  try {
    fresh.rows();
    assert.equal(fresh.counts().parses, copy.roots.order.length);
    assert.ok(fresh.counts().parses > 1);
    assert.deepEqual(fresh.rows().map(row => row.audioText), copy.reader.rows().map(row => row.audioText));
  } finally { fresh.close(); }
});

test("a keystroke from another copy reparses one segment and rebuilds one row, with no structural pass", () => {
  const copy = loadedCopy(state, 2), writer = loadedCopy(state, 3), before = copy.reader.counts();
  const place = narrationText(writer, "B451"), vector = Y.encodeStateVector(writer.doc);
  writer.doc.transact(() => { place.text.insert(place.start + 5, "k", {}); }, writer.origin);
  Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(writer.doc, vector), "remote");
  const changes = copy.reader.refresh(), after = copy.reader.counts();
  assert.deepEqual(changes.rows, ["B451"]);
  assert.equal(changes.outline, false);
  assert.deepEqual([after.parses - before.parses, after.rowsBuilt - before.rowsBuilt, after.structures - before.structures], [1, 1, 0]);
});
