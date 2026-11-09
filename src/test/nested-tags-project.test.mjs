import "./_dom.mjs";
import "./_preferences-started.mjs";
import "./_export-services-started.mjs";
import "./_project-file-services-started.mjs";
import "./_copy-paste-mounted.mjs";
import "./_merge-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { exportDocumentOf } from "../bootstrap/wiring/export-capture.ts";
import { buildSplitpageFile, buildMarkdownProject, parseMarkdownProject, applyMarkdownProject } from "../adapters/formats/project-file.ts";
import { parseSplitpageFile } from "../adapters/formats/splitpage-file.ts";
import { clipboardOfCell, cellFromClipboard } from "../features/clipboard/cell-clipboard.ts";
import { buildBeatPayload, parseBeatPayload, insertBeats } from "../features/clipboard/beat-clip.ts";
import { loadTestDocument } from "./_document.mjs";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { createUndoHistory, diffStates } from "../application/editing/undo/history.ts";
import { toHtml } from "../core/text/html.ts";
import { tagIds } from "../core/text/runs.ts";
import { retag } from "../core/text/edits.ts";
import { mergeStates } from "../bootstrap/wiring/document-merge.ts";

const tag = (cat, name, inner) => `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${inner}</span>`;
const nested = tag("sound", "Rain on umbrella", "rain on " + tag("prop", "Umbrella", "umbrella"));

function fixture() {
  return migrateRows({ schema: 2, docId: "d" + "1".repeat(32), title: "Nested",
    rows: [{ id: "r1", visualText: nested, audioText: nested }, { id: "r2", audioText: "End" }],
    people: [{ id: "p1", name: "Sam" }],
    productionTags: [
      { id: "t_rain", cat: "sound", name: "Rain on umbrella", status: "have", notes: "Record separately", owner: "p1" },
      { id: "t_umbrella", cat: "prop", name: "Umbrella", status: "sourcing", notes: "Blue", owner: "p1" }
    ] });
}

async function roundTrip(doc) {
  for (const write of [buildSplitpageFile, buildMarkdownProject]) {
    const bytes = write(exportDocumentOf(doc));
    const loaded = write === buildSplitpageFile ? migrateRows(parseSplitpageFile(bytes))
      : await applyMarkdownProject(parseMarkdownProject(bytes), { noAsk: true });
    assert.deepEqual(loaded, doc);
    assert.equal(write(exportDocumentOf(loaded)), bytes);
  }
}

test("both project formats preserve nested canonical HTML and independent record metadata byte for byte", async () => {
  const doc = fixture();
  assert.equal(doc.rows[0].visualText, nested);
  await roundTrip(doc);
  const unregistered = structuredClone(doc);
  unregistered.productionTags = [];
  assert.deepEqual(migrateRows(unregistered).productionTags.map(t => t.name), ["Rain on umbrella", "Umbrella"]);
});

test("a parent wholly covered by its child still heals and travels on the beat clipboard with its own record", () => {
  const doc = fixture();
  const html = tag("sound", "Rain on umbrella", tag("prop", "Umbrella", "umbrella"));
  doc.rows[0].visualText = html;
  doc.rows[0].audioText = html;
  const payload = buildBeatPayload(doc, ["r1"]);
  assert.deepEqual(parseBeatPayload(payload.json).productionTags, doc.productionTags);
  doc.productionTags = [];
  assert.deepEqual(migrateRows(doc).productionTags.map(t => t.name).sort(), ["Rain on umbrella", "Umbrella"]);
});

test("copies and cuts retain nested HTML; scene clipboard carries both records, notes, owners and status", () => {
  const cell = fromHtml(nested);
  for (const options of [{}, { keepComments: true, nonce: "abc123" }]) {
    const copied = clipboardOfCell(cell, options);
    assert.equal(copied.text, "rain on umbrella");
    const pasted = cellFromClipboard(copied.html, copied.text, options);
    assert.equal(toHtml(pasted.cell), nested);
  }
  const doc = fixture();
  const payload = buildBeatPayload(doc, ["r1"]);
  const pasted = parseBeatPayload(payload.json);
  assert.equal(pasted.rows[0].visualText, nested);
  assert.equal(pasted.rows[0].audioText, nested);
  assert.deepEqual(pasted.productionTags, doc.productionTags);
  assert.deepEqual(pasted.people, doc.people);
  loadTestDocument(migrateRows({ rows: [{ id: "target", audioText: "Target" }] }));
  insertBeats(pasted, { afterRowId: "target" });
  assert.equal(currentDocument().rows[1].visualText, nested);
  const metadata = records => records.map(t => [t.cat, t.name, t.status, t.notes, t.owner]);
  assert.deepEqual(metadata(currentDocument().productionTags), metadata(doc.productionTags));
  assert.equal(new Set(currentDocument().productionTags.map(t => t.id)).size, 2);
  assert.deepEqual(currentDocument().people, doc.people);
});

test("nested label removal is an undo step; undo and redo survive an independent remote text edit", () => {
  const before = fixture(), doc = structuredClone(before);
  const history = createUndoHistory(fromHtml);
  doc.rows[0].visualText = toHtml(retag(fromHtml(nested), "t:prop:Umbrella", null));
  history.record(diffStates(before, doc), 1000);
  doc.rows[0].visualText += " remotely extended";
  doc.rows[1].audioText = "Remote end";
  assert.equal(history.undo(doc).ok, true);
  assert.equal(doc.rows[0].visualText, nested + " remotely extended");
  assert.equal(doc.rows[1].audioText, "Remote end");
  assert.equal(history.redo(doc).ok, true);
  assert.equal(doc.rows[0].visualText, tag("sound", "Rain on umbrella", "rain on umbrella") + " remotely extended");
  assert.equal(doc.rows[1].audioText, "Remote end");
});

test("merge preserves nested records when one is renamed and other words change independently", async () => {
  const base = fixture(), mine = structuredClone(base), theirs = structuredClone(base);
  mine.productionTags[1].name = "Blue umbrella";
  mine.rows[0].visualText = tag("sound", "Rain on umbrella", "rain on " + tag("prop", "Blue umbrella", "umbrella"));
  theirs.rows[1].audioText = "Changed end";
  const { merged, conflicts } = mergeStates(base, mine, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.rows[0].visualText, mine.rows[0].visualText);
  assert.equal(merged.rows[0].audioText, mine.rows[0].visualText);
  assert.equal(merged.rows[1].audioText, "Changed end");
  assert.deepEqual(merged.productionTags.find(t => t.id === "t_umbrella"), mine.productionTags[1]);
  await roundTrip(merged);
});

test("real v0.3.0 seed and tagged starter keep old cell bytes, records and editing behaviour", async () => {
  for (const name of ["seed", "spot"]) {
    const bytes = readFileSync(new URL(`./fixtures/splitpage-0.3.0-${name}.splitpage`, import.meta.url), "utf8");
    const raw = parseSplitpageFile(bytes), doc = migrateRows(structuredClone(raw));
    assert.deepEqual(doc.rows.map(r => [r.visualText, r.audioText]), raw.rows.map(r => [r.visualText, r.audioText]));
    for (const record of raw.productionTags || []) assert.deepEqual(doc.productionTags.find(t => t.id === record.id), record);
    for (const row of doc.rows) for (const field of ["visualText", "audioText"]) {
      const cell = fromHtml(row[field]);
      assert.ok(cell.every(r => !r.marks.innerTags));
      assert.deepEqual(fromHtml(toHtml(cell)), cell);
      for (const id of tagIds(cell)) assert.ok(!toHtml(retag(cell, id, null)).includes(`data-tag-name="${id.slice(id.lastIndexOf(":") + 1)}"`));
    }
    await roundTrip(doc);
    const edited = structuredClone(doc);
    edited.rows[0].audioText += " Added";
    const history = createUndoHistory(fromHtml);
    history.record(diffStates(doc, edited), 1000);
    assert.equal(history.undo(edited).ok, true);
    assert.deepEqual(edited.rows.map(r => r.audioText), doc.rows.map(r => r.audioText));
    assert.equal(history.redo(edited).ok, true);
    const { merged, conflicts } = mergeStates(doc, edited, structuredClone(doc));
    assert.equal(conflicts.length, 0);
    assert.equal(merged.rows[0].audioText, edited.rows[0].audioText);
  }
});

test("a nested merge conflict retains the other complete path and the local HTML for review", () => {
  const base = fixture(), mine = structuredClone(base), theirs = structuredClone(base);
  mine.rows[0].visualText = tag("sound", "Rain on umbrella", "rain on " + tag("prop", "Red umbrella", "umbrella"));
  theirs.rows[0].visualText = tag("sound", "Rain on umbrella", "rain on " + tag("gear", "Parasol", "umbrella"));
  const { merged, conflicts } = mergeStates(base, mine, theirs);
  assert.equal(merged.rows[0].visualText, theirs.rows[0].visualText);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].mine, mine.rows[0].visualText);
  assert.equal(conflicts[0].theirs, theirs.rows[0].visualText);
});
