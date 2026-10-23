import "./_dom.mjs";
import "./_preferences-started.mjs";
import "./_export-services-started.mjs";
import "./_project-file-services-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { STATE_FIELDS, migrateRows, missingStateFields } from "../js/02-state.js";
import { cellOf } from "../js/04c-doc-model.js";
import { collectTagsFromRows } from "../js/07-production-tags.js";
import { brollInCell } from "../js/08c-broll.js";
import { buildSplitpageFile } from "../adapters/formats/project-file.ts";
import { STARTERS, starterById } from "../js/_starters.js";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { parseSplitpageFile } from "../adapters/formats/splitpage-file.ts";

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
    assert.match(migrated.docId, /^d[0-9a-f]{32}$/);
    delete migrated.docId;
    assert.deepEqual(migrated, doc);
  });

  test(`${starter.id}: has no missing STATE_FIELDS and no docId`, () => {
    assert.deepEqual(missingStateFields(doc), []);
    assert.equal("docId" in doc, false);
    const known = new Set(STATE_FIELDS.map((f) => f.key));
    assert.deepEqual(Object.keys(doc).filter((k) => !known.has(k)), []);
  });

  test(`${starter.id}: two documents opened from it are two documents`, () => {
    const a = migrateRows(copy(doc));
    const b = migrateRows(copy(doc));
    assert.notEqual(a.docId, b.docId);
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
    const round = migrateRows(parseSplitpageFile(buildSplitpageFile(exportDocumentOf(opened))));
    assert.deepEqual(round, opened);
  });
}
