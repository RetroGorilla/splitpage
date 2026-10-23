import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import { __init as mountCellClipboard, pasteIntoCell } from "../../../src/features/clipboard/cell-clipboard.js";
import type { CellClipboardPorts, SceneClipPorts, SceneSelectPorts } from "../../../src/features/clipboard/ports.ts";
import { __init as mountSceneClip, parseScenePayload } from "../../../src/features/clipboard/scene-clip.js";
import { __init as mountSceneSelect, selectScenes } from "../../../src/features/clipboard/scene-select.js";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeEdits, fakeNotices, fakePictures, fakeReview, fakeSaveState } from "../fakes.ts";

function scriptDoc() {
  return migrateRows({ title: "Scenes", rows: [
    { id: "r1", visualText: "One", audioText: "" },
    { id: "r2", visualText: "Two", audioText: "" },
    { id: "r3", visualText: "Three", audioText: "" }
  ] }, fakeMigration().ports);
}

function sceneSelect() {
  document.body.innerHTML = '<div id="rows"></div>';
  const edits = fakeEdits();
  const notices = fakeNotices();
  const review = fakeReview();
  const calls: string[] = [];
  const ports: SceneSelectPorts = {
    document: fakeDocument(scriptDoc()).document,
    edits: edits.edits,
    reviewRefusal: "review",
    undo: {
      breakCoalescing: () => { calls.push("break"); },
      flush: () => { calls.push("flush"); },
      last: () => null,
      undo: () => { calls.push("undo"); }
    },
    saves: fakeSaveState().saves,
    pictures: fakePictures().pictures,
    review: review.review,
    notices: notices.notices,
    cells: { sync: () => {} },
    rowDrag: { dragging: () => null },
    scriptCell: () => true,
    rows: { closeMenus: () => {} },
    production: { scheduleRefresh: () => { calls.push("refresh"); } },
    stampRow: () => {},
    onServer: () => false,
    writerOpen: () => false,
    startNewScript: () => false,
    nonce: () => "n1"
  };
  return { owner: mountSceneSelect(ports), edits, notices, review, calls };
}

function press(key: string): void {
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
}

test("scene selection: Delete removes the selected scenes through the edits port, between undo breaks, and says so", () => {
  const { owner, edits, notices, calls } = sceneSelect();
  selectScenes("r1", "r2");
  press("Delete");
  assert.equal(edits.ran.length, 1);
  assert.deepEqual(calls, ["break", "flush", "break"]);
  assert.deepEqual(notices.shown.map((n) => n.message), ["2 scenes deleted."]);
  owner.dispose();
});

test("scene selection: a review copy refuses the delete and runs nothing", () => {
  const { owner, edits, notices, review } = sceneSelect();
  review.setReviewing(true);
  selectScenes("r2");
  press("Delete");
  assert.equal(edits.ran.length, 0);
  assert.deepEqual(notices.shown.map((n) => n.message), ["This is a review copy — scenes can be copied from it, not deleted."]);
  owner.dispose();
});

test("scene selection: dispose removes its listeners and its highlight", () => {
  const { owner, edits } = sceneSelect();
  selectScenes("r1");
  assert.ok(document.getElementById("scene-selection-style"));
  owner.dispose();
  assert.equal(document.getElementById("scene-selection-style"), null);
  assert.equal(document.body.classList.contains("has-scene-selection"), false);
  press("Delete");
  assert.equal(edits.ran.length, 0);
});

test("scene clipboard: a pasted payload's pictures go through the picture port and its scenes through the migrate port", () => {
  const pictures = fakePictures();
  const migrated: object[] = [];
  const ports: SceneClipPorts = {
    document: fakeDocument(scriptDoc()).document,
    ids: { id: (prefix) => prefix + "1" },
    pictures: pictures.pictures,
    text: { cellOf: () => [], fromHtml: () => [], inertBody: (html) => { const body = document.createElement("body"); body.innerHTML = String(html); return body; } },
    migrate: (doc) => { migrated.push(doc); return migrateRows(doc, fakeMigration().ports); },
    tagsInRows: () => [],
    recordPastedBroll: () => {}
  };
  const owner = mountSceneClip(ports);
  const sha = "0".repeat(63) + "1";
  const clip = parseScenePayload(JSON.stringify({
    format: "splitpage-scenes", version: 1,
    rows: [{ id: "r9", visualText: "Hello", audioText: "" }],
    blobs: { [sha]: "data:image/png;base64,AQ==" }
  }));
  assert.ok(clip);
  assert.deepEqual(clip.carried, [sha]);
  assert.deepEqual(pictures.persisted, [sha]);
  assert.equal(migrated.length, 1);
  assert.deepEqual(clip.rows.map((r: { id: string }) => r.id), ["r9"]);
  owner.dispose();
});

test("cell clipboard: a pasted video link alone goes to the scene's gallery through the edits port, between undo breaks", () => {
  document.body.innerHTML = '<div id="rows"><div class="cell-editable" data-id="r2" data-field="visualText"></div></div>';
  const edits = fakeEdits();
  const calls: string[] = [];
  const ports: CellClipboardPorts = {
    document: fakeDocument(scriptDoc()).document,
    edits: { run: (command) => { calls.push("run"); return edits.edits.run(command); }, text: { ...edits.edits.stamps, cells: () => [] } },
    undo: { breakCoalescing: () => { calls.push("break"); }, flush: () => { calls.push("flush"); } },
    pictures: fakePictures().pictures,
    text: { cellOf: () => [], fromHtml: () => [], inertBody: () => document.createElement("body"), storedHtmlFromDom: (html) => html },
    imageRefOf: () => null,
    ids: { id: (prefix) => prefix + "1" },
    nonce: () => "n1",
    selection: () => null,
    cells: { open: () => null, close: (cell) => cell },
    paintGuard: { whileShown: (edit) => edit() },
    brollSeed: () => ({ audioRef: "", location: "" })
  };
  const owner = mountCellClipboard(ports);
  const cell = document.querySelector(".cell-editable");
  assert.ok(cell);
  const res = pasteIntoCell(cell, "", "https://youtu.be/abc", null);
  assert.equal(res.done, true);
  assert.equal(res.rowIndex, 1);
  assert.deepEqual(calls, ["break", "run", "flush", "break"]);
  owner.dispose();
});
