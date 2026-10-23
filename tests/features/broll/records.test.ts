import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CellEdit } from "../../../src/application/editing/cell-editing.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import type { BrollRecordsPorts } from "../../../src/features/broll/ports.ts";
import { brollStatus, createBrollRecords } from "../../../src/features/broll/records.ts";
import { productionReaders } from "../../../src/legacy/document-ports.ts";
import { htmlToPlainText } from "../../../src/legacy/plain-text.ts";
import { cellOf, inertBody, sanitizeHtml } from "../../../src/legacy/richtext.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeEdits } from "../fakes.ts";

function setup(doc: ValidatedDocument | null) {
  const edits = fakeEdits({ kind: "applied", generation: 1, changes: { whole: false, cells: [], rowsInserted: [], rowsRemoved: [], rowsMoved: false, runsMoved: false, docFields: [], derive: [], saveNow: false } });
  const cellEdits: CellEdit[] = [];
  const refreshes: string[] = [];
  const anchored: string[] = [];
  let next = 0;
  const ports: BrollRecordsPorts = {
    document: { current: () => doc, read: (select) => select(doc) },
    edits: { ...edits.edits, text: { ...edits.edits.stamps, cells: (html: string) => cellOf(html) } },
    cells: { edit: (cell, change) => { cellEdits.push(change); return cell; } },
    paint: { whileShown: (edit) => edit() },
    text: { cellOf, inertBody, sanitizeHtml, htmlToPlainText, productionReaders },
    scriptCellOf: cellOf,
    ids: { id: (prefix) => prefix + (++next), docId: () => "doc" },
    caretSpot: () => {},
    position: () => 0,
    anchors: { inRows: (rows) => { anchored.push(...rows.map((r) => r.id)); return 0; }, htmlLines: () => [], keyHtml: (id, text) => id + text },
    refresh: (job) => { refreshes.push(job); }
  };
  return { edits, cellEdits, refreshes, anchored, owner: createBrollRecords(ports) };
}

function doc(shots: unknown[], visualText = ""): ValidatedDocument {
  return migrateRows({ title: "B-roll", rows: [{ id: "r1", visualText, audioText: "Over the harbour." }], brollShots: shots }, fakeMigration().ports);
}

test("b-roll records: statuses look up by id, and anything else is none", () => {
  assert.equal(brollStatus("shot")?.label, "Shot");
  assert.equal(brollStatus("unshot")?.label, "To shoot");
  assert.equal(brollStatus("bogus"), null);
});

test("b-roll records: the badge counts shots still to shoot, and hides at none", () => {
  document.body.innerHTML = '<span id="broll-badge" hidden></span>';
  const badge = document.getElementById("broll-badge");
  assert.ok(badge);
  setup(doc([{ id: "bs1", name: "Gulls" }, { id: "bs2", name: "Pier", status: "shot" }])).owner.updateBrollBadge();
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "1");
  setup(doc([{ id: "bs2", name: "Pier", status: "shot" }])).owner.updateBrollBadge();
  assert.equal(badge.hidden, true);
});

test("b-roll records: adding a prop runs the prop command, and refreshes go to the b-roll job", () => {
  const { edits, refreshes, owner } = setup(doc([{ id: "bs1", name: "Gulls" }]));
  owner.addBrollProp("bs1", "Kite");
  owner.scheduleBrollRefresh();
  assert.deepEqual(edits.ran.map((c) => c.name), ["add-broll-prop"]);
  assert.deepEqual(refreshes, ["broll"]);
});

test("b-roll records: typing that does not close a marker at a line start captures nothing", () => {
  document.body.innerHTML = '<div class="cell-editable" data-field="visualText" data-id="r1">B-roll</div>';
  const cell = document.querySelector(".cell-editable");
  assert.ok(cell);
  const { cellEdits, refreshes, owner } = setup(doc([]));
  owner.maybeCaptureBroll({ inputType: "insertText", data: "l" } as InputEvent, cell);
  owner.maybeCaptureBroll({ inputType: "deleteContentBackward", data: null } as InputEvent, cell);
  cell.setAttribute("data-field", "audioText");
  owner.maybeCaptureBroll({ inputType: "insertText", data: ":" } as InputEvent, cell);
  assert.deepEqual(cellEdits, []);
  assert.deepEqual(refreshes, []);
});

test("b-roll records: anchoring a left cell with no unkeyed markers changes nothing", () => {
  document.body.innerHTML = '<div class="cell-editable" data-field="visualText" data-id="r1"></div>';
  const cell = document.querySelector(".cell-editable");
  assert.ok(cell);
  const { edits, anchored, owner } = setup(doc([]));
  assert.equal(owner.anchorBrollInLeftCell(cell), 0);
  assert.deepEqual(anchored, ["r1"]);
  assert.deepEqual(edits.ran, []);
  assert.equal(setup(null).owner.anchorBrollInLeftCell(cell), 0);
});

test("b-roll records: with no document there are no entries and nothing by prop", () => {
  const { owner } = setup(null);
  assert.deepEqual(owner.brollEntries(), []);
  assert.deepEqual(Object.keys(owner.brollShotsByProp()), []);
});
