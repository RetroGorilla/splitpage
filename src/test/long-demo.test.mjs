import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initSceneStatus, rowSeconds, hasSetLength } from "../js/01-scene-status.js";
import { STATE_FIELDS, migrateRows, missingStateFields } from "../js/02-state.js";
import { cellOf } from "../js/04c-doc-model.js";
import { TAG_CATEGORIES, collectTagsFromRows, __init as initTags } from "../js/07-production-tags.js";
import { brollInCell } from "../js/08c-broll.js";
import { buildSplitpageFile, parseSplitpageFile } from "../js/20d-formats.js";
import { LONG_DEMO, STARTERS, starterById } from "../js/_starters.js";
import { exportDocumentOf } from "../js/14b-export-kit.js";

initSceneStatus();
initTags();

const copy = (o) => JSON.parse(JSON.stringify(o));
const doc = LONG_DEMO.state;

test("the long demo is found by its id and is not one of the cards", () => {
  assert.equal(starterById("long-demo"), LONG_DEMO);
  assert.equal(STARTERS.some((s) => s.id === "long-demo"), false);
});

test("thirty scenes of one video, with a title of its own", () => {
  assert.equal(doc.rows.length, 30);
  assert.ok(doc.title && doc.title !== "Untitled Script");
  assert.equal(new Set(doc.rows.map((r) => r.id)).size, 30);
});

test("passes through migrateRows unchanged but for a docId of its own", () => {
  const migrated = migrateRows(copy(doc));
  assert.match(migrated.docId, /^d[0-9a-f]{32}$/);
  delete migrated.docId;
  assert.deepEqual(migrated, doc);
  assert.notEqual(migrateRows(copy(doc)).docId, migrateRows(copy(doc)).docId);
});

test("has no missing or unknown STATE_FIELDS and no docId", () => {
  assert.deepEqual(missingStateFields(doc), []);
  assert.equal("docId" in doc, false);
  const known = new Set(STATE_FIELDS.map((f) => f.key));
  assert.deepEqual(Object.keys(doc).filter((k) => !known.has(k)), []);
});

test("every scene status, in realistic proportions", () => {
  const n = { todo: 0, ready: 0, shot: 0 };
  doc.rows.forEach((r) => { n[r.status]++; });
  for (const k of Object.keys(n)) assert.ok(n[k] >= 5, k + ": " + n[k]);
});

test("tags in every category, repeated across scenes", () => {
  const tags = collectTagsFromRows(doc.rows);
  const cats = new Set(tags.map((t) => t.cat.id));
  TAG_CATEGORIES.forEach((c) => assert.ok(cats.has(c.id), "a " + c.id + " tag"));
  const scenesAt = {};
  doc.rows.forEach((r) => {
    collectTagsFromRows([r]).filter((t) => t.cat.id === "location")
      .forEach((t) => { (scenesAt[t.name.toLowerCase()] = scenesAt[t.name.toLowerCase()] || new Set()).add(r.id); });
  });
  assert.ok(Object.keys(scenesAt).length >= 3);
  Object.keys(scenesAt).forEach((l) => assert.ok(scenesAt[l].size >= 2, l + " in one scene only"));
  assert.ok(new Set(doc.productionTags.map((t) => t.status)).size >= 3);
  assert.ok(doc.productionTags.some((t) => t.owner) && doc.people.length >= 2);
});

test("every B-roll line has its record, some shot and some not", () => {
  const found = [];
  doc.rows.forEach((row) => brollInCell(cellOf(row.visualText)).forEach((f) => found.push(f)));
  assert.ok(found.length >= 6);
  assert.ok(found.every((f) => f.id));
  assert.deepEqual(found.map((f) => [f.id, f.name, f.desc]), doc.brollShots.map((r) => [r.id, r.name, r.desc]));
  assert.ok(doc.brollShots.some((r) => r.status === "shot"));
  assert.ok(doc.brollShots.some((r) => r.status === "unshot"));
});

test("a few comments anchored in the script, one resolved, one with a reply", () => {
  assert.ok(doc.comments.length >= 3);
  doc.comments.forEach((c) => {
    const row = doc.rows.find((r) => r.id === c.rowId);
    assert.ok(row && row[c.field].includes('data-cmt="' + c.anchorId + '"'), c.id + " anchored");
  });
  assert.equal(doc.comments.filter((c) => c.resolved).length, 1);
  assert.ok(doc.comments.some((c) => !c.resolved));
  assert.ok(doc.comments.some((c) => c.replies.length));
});

test("stage directions, set read times, a target it runs over, and scenes of very different lengths", () => {
  assert.ok(doc.rows.filter((r) => r.audioText.includes('class="stage-dir"')).length >= 3);
  assert.ok(doc.rows.some(hasSetLength));
  S.state = doc;
  const secs = doc.rows.map((r) => rowSeconds(r));
  const total = secs.reduce((a, b) => a + b, 0);
  assert.ok(total >= 8 * 60 && total <= 10 * 60, "8–10 minutes: " + total);
  assert.ok(doc.targetSeconds > 0 && Math.abs(doc.targetSeconds - total) <= 90 && doc.targetSeconds !== Math.round(total));
  assert.ok(secs.filter((s) => s < 3).length >= 2, "very short scenes");
  assert.ok(Math.max(...secs) >= 30);
});

test("a video link or two in a gallery, and no picture bytes", () => {
  assert.ok(doc.rows.filter((r) => Array.isArray(r.imageLinks) && r.imageLinks.length).length >= 1);
  assert.ok(doc.rows.every((r) => r.imageRef === null && !r.moreImages));
  assert.equal(JSON.stringify(doc).includes("data:image"), false);
});

test("survives a .splitpage round trip", () => {
  const opened = migrateRows(copy(doc));
  const round = migrateRows(parseSplitpageFile(buildSplitpageFile(exportDocumentOf(opened))));
  assert.deepEqual(round, opened);
});
