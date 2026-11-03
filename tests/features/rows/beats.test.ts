import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { DeleteArea } from "../../../src/application/editing/delete-confirm.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import type { TextSpan } from "../../../src/core/text/edits.ts";
import type { BeatMediaPorts, BeatPorts } from "../../../src/features/rows/ports.ts";
import { startBeatMedia as mountBeatMedia } from "../../../src/features/rows/beat-media.ts";
import { startBeatRows as mountBeats } from "../../../src/features/rows/beats.ts";
import { cellOf, storedHtmlFromDom } from "../../../src/bootstrap/richtext.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeEdits, fakeNotices, fakeOwnership, fakePictures } from "../fakes.ts";

window.Element.prototype.scrollIntoView = function () {};

function rowHtml(id: string): string {
  return '<div class="row" data-id="' + id + '">' +
    '<div class="cell-editable" contenteditable="true" data-id="' + id + '" data-field="visualText">Picture</div>' +
    '<div class="cell-editable" contenteditable="true" data-id="' + id + '" data-field="audioText">Words</div>' +
    '<button class="gutter-btn danger"><span class="row-menu-label">Delete</span></button></div>';
}

function setup() {
  document.body.innerHTML = '<div id="rows">' + rowHtml("r1") + rowHtml("r2") + "</div>";
  const doc = migrateRows({ title: "Scenes", rows: [
    { id: "r1", visualText: "Picture", audioText: "Words", status: "todo" },
    { id: "r2", visualText: "", audioText: "", status: "todo" }
  ] }, fakeMigration().ports);
  const edits = fakeEdits({ kind: "applied", generation: 1, changes: changeSet({}) });
  const notices = fakeNotices();
  const calls: string[] = [];
  const armed = new Map<DeleteArea, string>();
  let minted = 0;
  const ports: BeatPorts = {
    document: fakeDocument(doc).document,
    edits: {
      ...edits.edits,
      text: { ...edits.edits.stamps, cells: (h: string) => deepFreeze(normalizeCell(h ? [{ text: h, marks: {} }] : [])) }
    },
    notices: notices.notices,
    ids: { id: (prefix) => prefix + "new" + (++minted) },
    text: { cellOf },
    cells: { sync: (cell) => { calls.push("sync " + cell.getAttribute("data-field")); } },
    undo: { breakCoalescing: () => { calls.push("break"); } },
    selection: { of: (): TextSpan => ({ from: 2, to: 2 }) },
    placeCaret: (cell, offset) => { calls.push("caret " + cell.getAttribute("data-field") + " " + offset); },
    rowDrag: { dragging: () => null },
    deletes: {
      armedId: (area) => armed.get(area) ?? null,
      arm: (area, id, _expired, show) => { armed.set(area, id); show?.(); },
      disarm: (area) => { armed.delete(area); }
    }
  };
  return { edits, notices, calls, owner: mountBeats(ports) };
}

test("scenes: adding a scene runs the add command with a fresh id, and a refused add adds nothing", () => {
  const { edits, notices, owner } = setup();
  assert.equal(owner.addRow("r1"), "rnew1");
  assert.deepEqual(edits.ran.map((c) => c.name), ["add-scene"]);
  edits.answer({ kind: "rejected", reason: "refused" });
  assert.equal(owner.addRow("r1"), null);
  assert.deepEqual(notices.shown, []);
  owner.dispose();
});

test("scenes: splitting a cell syncs it, breaks undo coalescing, runs the split and puts the caret at the start of the new scene", () => {
  const { edits, calls, owner } = setup();
  document.body.querySelector("#rows")?.insertAdjacentHTML("beforeend", rowHtml("rnew1"));
  const cell = document.querySelector('.row[data-id="r1"] [data-field="audioText"]');
  assert.ok(cell);
  owner.splitCellField(cell);
  assert.deepEqual(edits.ran.map((c) => c.name), ["split-scene"]);
  assert.deepEqual(calls, ["sync audioText", "break", "caret audioText 0"]);
  assert.equal(document.activeElement?.getAttribute("data-id"), "rnew1");
  owner.dispose();
});

test("scenes: a scene that is not in the document, or a cell that is not a script field, does not split", () => {
  const { edits, owner } = setup();
  const stray = document.createElement("div");
  stray.setAttribute("data-id", "gone");
  stray.setAttribute("data-field", "audioText");
  assert.equal(owner.splitField(stray), null);
  stray.setAttribute("data-id", "r1");
  stray.setAttribute("data-field", "notes");
  assert.equal(owner.splitField(stray), null);
  assert.deepEqual(edits.ran, []);
  owner.dispose();
});

test("scenes: a blank scene deletes at once; a scene with words arms first and deletes on the second press", () => {
  const { edits, owner } = setup();
  const blankBtn = document.querySelector('.row[data-id="r2"] .gutter-btn');
  const fullBtn = document.querySelector('.row[data-id="r1"] .gutter-btn');
  assert.ok(blankBtn && fullBtn);
  owner.armDelete(blankBtn, "r2");
  assert.deepEqual(edits.ran.map((c) => c.name), ["delete-scene"]);
  owner.armDelete(fullBtn, "r1");
  assert.equal(edits.ran.length, 1);
  assert.equal(fullBtn.querySelector(".row-menu-label")?.textContent, "Click again to delete");
  owner.armDelete(fullBtn, "r1");
  assert.deepEqual(edits.ran.map((c) => c.name), ["delete-scene", "delete-scene"]);
  owner.dispose();
});

test("scenes: moving a scene swaps it with its neighbour, and drop markers clear together", () => {
  const { edits, owner } = setup();
  assert.equal(owner.swapAdjacent("r2", -1), true);
  assert.deepEqual(edits.ran.map((c) => c.name), ["swap-scenes"]);
  const row = document.querySelector<HTMLElement>('.row[data-id="r2"]');
  assert.ok(row);
  owner.setDropMarkerForRow(row, 0);
  assert.equal(row.classList.contains("drop-before") || row.classList.contains("drop-after"), true);
  owner.clearDropMarkers();
  assert.equal(document.querySelectorAll(".drop-before, .drop-after").length, 0);
  owner.dispose();
});

test("scene media: a gallery change goes through the gallery edit, and a paste place restores the caret only when the cell did not change", () => {
  document.body.innerHTML = '<div class="cell-editable">Words</div>';
  const notices = fakeNotices();
  const edited: string[] = [];
  const placed: [number, number | undefined][] = [];
  const ports: BeatMediaPorts = {
    document: fakeDocument(null).document,
    notices: notices.notices,
    ownership: fakeOwnership().ownership,
    pictures: fakePictures().pictures,
    cells: { editGallery: (rowId, message) => { edited.push(rowId + ": " + message); return true; } },
    text: { storedHtmlFromDom },
    selection: { of: () => ({ from: 1, to: 3 }), set: (_cell, from, to) => { placed.push([from, to]); } }
  };
  const owner = mountBeatMedia(ports);
  owner.removePicture("r1", 0);
  owner.removeLink("r1", 0, "k");
  assert.deepEqual(edited, ["r1: Picture removed", "r1: Video link removed"]);
  const cell = document.querySelector(".cell-editable");
  assert.ok(cell);
  const place = owner.capturePastePlace(cell);
  owner.restorePastePlace(cell, place);
  cell.innerHTML = "Changed";
  owner.restorePastePlace(cell, place);
  assert.deepEqual(placed, [[1, 3], [Infinity, Infinity]]);
  owner.showPictureNotAdded();
  assert.equal(notices.shown[0]?.kind, "warn");
  owner.dispose();
});
