/* The New Tab page's starter scripts (src/starters/, _starters.js, #144).
 *
 * A starter opens as a new document built by migrateRows from a copy of
 * the file, so the file has to be what migrateRows would make of it
 * already: otherwise the first thing a starter does is change itself —
 * a tag re-registered, an id re-minted, a cell re-serialised — and every
 * one of those is an edit nobody made, on a document the desktop shell
 * treats as pristine. The b-roll list is the other reader that heals what
 * it finds (08c-broll.js): a "B-roll:" line with no record gets one on
 * the list's first read, so every record has to be there, carrying the
 * name and description that read would give it.
 *
 * And like seed-state.json, no starter may carry a docId: every document
 * opened from one has to be a document of its own (invariant #35).
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { STATE_FIELDS, migrateRows, missingStateFields } from "../js/02-state.js";
import { cellOf } from "../js/04c-doc-model.js";
import { collectTagsFromRows } from "../js/07-production-tags.js";
import { brollInCell } from "../js/08c-broll.js";
import { buildSplitpageFile, parseSplitpageFile } from "../js/20d-formats.js";
import { STARTERS, starterById } from "../js/_starters.js";

const copy = (o) => JSON.parse(JSON.stringify(o));

test("there are three starters, with the ids, names and lines the page shows", () => {
  assert.deepEqual(STARTERS.map((s) => [s.id, s.name, s.desc]), [
    ["to-camera", "To-camera video", "Hook, intro, sections, call to action."],
    ["interview", "Interview", "Questions on the right, cutaways on the left."],
    ["spot-30", "30-second spot", "Six timed beats with a packshot."]
  ]);
  STARTERS.forEach((s) => assert.equal(starterById(s.id), s));
  assert.equal(starterById("nope"), null);
});

for (const starter of STARTERS) {
  const doc = starter.state;

  test(`${starter.id}: passes through migrateRows unchanged`, () => {
    const migrated = migrateRows(copy(doc));
    /* The one thing migration adds: an identity of its own. */
    assert.match(migrated.docId, /^d[0-9a-f]{32}$/);
    delete migrated.docId;
    assert.deepEqual(migrated, doc);
  });

  test(`${starter.id}: has no missing STATE_FIELDS and no docId`, () => {
    /* On the file itself, not on a migrated copy — a field the file lacks
       would be one migrateRows adds, which the test above also catches,
       but this names it. */
    assert.deepEqual(missingStateFields(doc), []);
    assert.equal("docId" in doc, false);
    const known = new Set(STATE_FIELDS.map((f) => f.key));
    assert.deepEqual(Object.keys(doc).filter((k) => !known.has(k)), []);
  });

  test(`${starter.id}: two documents opened from it are two documents`, () => {
    const a = migrateRows(copy(doc));
    const b = migrateRows(copy(doc));
    assert.notEqual(a.docId, b.docId);
    /* ...and neither reached back into the bundled original. */
    assert.equal("docId" in doc, false);
  });

  test(`${starter.id}: every B-roll line already has its record, as the list would read it`, () => {
    const found = [];
    doc.rows.forEach((row) => brollInCell(cellOf(row.visualText)).forEach((f) => found.push(f)));
    assert.ok(found.length >= 1, "at least one B-roll: line");
    assert.ok(found.every((f) => f.id), "every B-roll: line is a keyed marker");
    assert.deepEqual(
      found.map((f) => [f.id, f.name, f.desc]),
      doc.brollShots.map((r) => [r.id, r.name, r.desc]));
  });

  test(`${starter.id}: shows the features off — scenes, tags, a status`, () => {
    assert.ok(doc.rows.length >= 4, "a few scenes");
    assert.ok(doc.title && doc.title !== "Untitled Script", "a title of its own");
    const cats = new Set(collectTagsFromRows(doc.rows).map((t) => t.cat.id));
    for (const cat of ["prop", "location", "vfx"]) assert.ok(cats.has(cat), "a " + cat + " tag");
    assert.ok(doc.rows.some((r) => r.status !== "todo"), "a scene status");
    assert.ok(doc.rows.every((r) => r.visualText && r.audioText), "no empty column");
    assert.deepEqual(doc.comments, []);
    assert.ok(doc.rows.every((r) => r.imageRef === null && !r.updatedAt && r.updatedBy === null));
  });

  test(`${starter.id}: survives a .splitpage round trip`, () => {
    const opened = migrateRows(copy(doc));
    const round = migrateRows(parseSplitpageFile(buildSplitpageFile(opened)));
    assert.deepEqual(round, opened);
  });
}
