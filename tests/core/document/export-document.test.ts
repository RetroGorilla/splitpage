import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import type { ExportReadModels, ExportShotEntry } from "../../../src/core/document/export-document.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration, jsonCopy } from "../migrate-ports.ts";

const SOURCE = {
  schema: 5, title: "Export", docId: "d" + "2".repeat(32), rev: 3,
  people: [{ id: "p1", name: "Ana" }],
  productionTags: [{ id: "t1", cat: "prop", name: "Lamp", owner: "p1", notes: "", status: "have" }],
  brollShots: [{ id: "bs1", name: "Steam", status: "shot", props: [] }],
  rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo", imageRef: { sha256: "a".repeat(64), mime: "image/png", width: 1, height: 1 } }],
  comments: [{ id: "c1", rowId: "r1", field: "audioText", body: "Hm", replies: [] }]
};

const migratedDoc = (raw: object) => migrateRows(jsonCopy(raw), fakeMigration().ports);

const shot = { id: "bs1", name: "Steam", desc: "", rowId: null, rowIndex: -1, ordinal: 0, status: "shot", reshoot: false, notes: "",
  owner: "", audioRef: "", location: "", props: [], rec: { id: "bs1" } } as ExportShotEntry;

const MODELS: ExportReadModels = { production: [], commentNumbers: { c1: 1 }, broll: [shot] };

test("the export document copies the validated document, names its parts, and freezes all of it", () => {
  const source = migratedDoc(SOURCE);
  const doc = buildExportDocument(source, "2026-10-13T17:30:00.000Z", MODELS);
  assert.notEqual(doc.document, source);
  assert.deepEqual(doc.document, JSON.parse(JSON.stringify(source)));
  assert.equal(doc.title, "Export");
  assert.equal(doc.scenes, doc.document.rows);
  assert.equal(doc.people, doc.document.people);
  assert.equal(doc.tags, doc.document.productionTags);
  assert.equal(doc.shots, doc.document.brollShots);
  assert.equal(doc.comments, doc.document.comments);
  assert.equal(doc.capturedAt, "2026-10-13T17:30:00.000Z");
  assert.equal(doc.scenes[0]?.imageRef && (doc.scenes[0].imageRef as { sha256: string }).sha256, "a".repeat(64));
  [doc, doc.document, doc.scenes, doc.scenes[0], doc.comments[0], doc.broll, doc.broll[0], doc.commentNumbers]
    .forEach((part) => assert.ok(Object.isFrozen(part)));
});

test("the read models are copied: a shot entry keeps no reference into the live shot list", () => {
  const doc = buildExportDocument(migratedDoc(SOURCE), "2026-10-13T17:30:00.000Z", MODELS);
  assert.equal("rec" in (doc.broll[0] as object), false);
  assert.notEqual(doc.broll[0], shot);
  assert.equal(Object.getPrototypeOf(doc.commentNumbers), null);
  assert.equal(doc.commentNumbers["c1"], 1);
});

test("a new document id replaces the copy's, never the source's", () => {
  const source = migratedDoc(SOURCE);
  const doc = buildExportDocument(source, "2026-10-13T17:30:00.000Z", MODELS, { docId: "d" + "3".repeat(32) });
  assert.equal(doc.document.docId, "d" + "3".repeat(32));
  assert.equal(source.docId, "d" + "2".repeat(32));
});

test("a stamp puts rev and the last-edited fields on the copy and leaves the source alone", () => {
  const source = migratedDoc(SOURCE);
  const stamp = { rev: 4, lastEditedBy: "Ana", lastEditedAt: "2026-10-14T17:00:00.000Z" };
  const doc = buildExportDocument(source, "2026-10-14T17:00:00.000Z", MODELS, { docId: "d" + "3".repeat(32), stamp: stamp });
  assert.equal(doc.document.rev, 4);
  assert.equal(doc.document.lastEditedBy, "Ana");
  assert.equal(doc.document.lastEditedAt, "2026-10-14T17:00:00.000Z");
  assert.equal(doc.document.docId, "d" + "3".repeat(32));
  assert.equal(source.rev, 3);
  assert.equal(Object.isFrozen(doc.document), true);
});
