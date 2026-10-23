import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { saveChanges, unsavedChanges } from "../legacy/save-bridge.ts";

await bootApp();

const { cycleRowStatus } = await import("../js/01-scene-status.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { migrateRows } = await import("../js/02-state.js");
const { setSceneLength } = await import("../js/05r-read-time.js");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const doc = migrateRows({
  schema: 2,
  title: "Edit counts",
  rows: [
    { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
    { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
  ]
});
await openDocument({ kind: "file", file: new File([buildSplitpageFile(exportDocumentOf(doc))], "counts.splitpage", { lastModified: 1 }), handle: null, options: { skipSnapshot: true } });

test("the booted app holds the opened script, saved", () => {
  assert.equal(currentDocument().title, "Edit counts");
  assert.equal(unsavedChanges(), false);
});

test("a status click advances saveChanges() by exactly one and marks the document dirty", () => {
  const seq = saveChanges();
  cycleRowStatus("r2");
  assert.equal(saveChanges(), seq + 1);
  assert.equal(unsavedChanges(), true);
  cycleRowStatus("r2");
  assert.equal(saveChanges(), seq + 2, "and one more for the next click");
});

test("a scene length advances saveChanges() by exactly one; setting it again or clearing nothing adds none", () => {
  const seq = saveChanges();
  assert.equal(setSceneLength("r2", 90), true);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(setSceneLength("r2", 90), false);
  assert.equal(setSceneLength("r1", null), false);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(setSceneLength("r2", null), true);
  assert.equal(saveChanges(), seq + 2);
});

test("a status click on a scene that is gone adds none", () => {
  const seq = saveChanges();
  cycleRowStatus("gone");
  assert.equal(saveChanges(), seq);
});

test("in review mode a scene length is refused with a warning toast and has no other effect", async () => {
  const { liveSession } = await import("../legacy/session-bridge.ts");
  const { flushEdits, undoSizes } = await import("../js/12a-undo.js");
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  flushEdits();
  const host = document.getElementById("toast-host");
  host.textContent = "";
  const seq = saveChanges(), dirty = unsavedChanges(), generation = liveSession().generation(), sizes = undoSizes();
  const before = JSON.stringify(currentDocument());
  assert.equal(setSceneLength("r1", 30), false);
  const toasts = host.querySelectorAll(".toast");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].textContent, "This is a review copy — comment on a scene instead of changing its length.");
  assert.ok(toasts[0].classList.contains("warn"));
  await Promise.resolve();
  flushEdits();
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(saveChanges(), seq);
  assert.equal(unsavedChanges(), dirty);
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(undoSizes(), sizes);
});

test("in review mode a status click is refused with a warning toast and has no other effect", async () => {
  const { liveSession } = await import("../legacy/session-bridge.ts");
  const { flushEdits, undoSizes } = await import("../js/12a-undo.js");
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  flushEdits();
  const host = document.getElementById("toast-host");
  host.textContent = "";
  const seq = saveChanges(), dirty = unsavedChanges(), generation = liveSession().generation(), sizes = undoSizes();
  const before = JSON.stringify(currentDocument());
  cycleRowStatus("r1");
  const toasts = host.querySelectorAll(".toast");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].textContent, "This is a review copy — comment on a scene instead of changing its status.");
  assert.ok(toasts[0].classList.contains("warn"));
  await Promise.resolve();
  flushEdits();
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(saveChanges(), seq);
  assert.equal(unsavedChanges(), dirty);
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(undoSizes(), sizes);
});

async function reviewClick(selector, wording) {
  const { liveSession } = await import("../legacy/session-bridge.ts");
  const { flushEdits, undoSizes } = await import("../js/12a-undo.js");
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  flushEdits();
  const target = document.querySelector(selector);
  assert.ok(target, selector + " is on the page");
  const host = document.getElementById("toast-host");
  host.textContent = "";
  const seq = saveChanges(), dirty = unsavedChanges(), generation = liveSession().generation(), sizes = undoSizes();
  const before = JSON.stringify(currentDocument());
  target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const toasts = host.querySelectorAll(".toast");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].textContent, wording);
  assert.ok(toasts[0].classList.contains("warn"));
  await Promise.resolve();
  flushEdits();
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(saveChanges(), seq);
  assert.equal(unsavedChanges(), dirty);
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(undoSizes(), sizes);
}

test("in review mode a click on the status lamp a reviewer sees shows the status toast and changes nothing", async () => {
  await reviewClick('#rows .row[data-id="r1"] .status-btn.is-static .status-dot',
    "This is a review copy — comment on a scene instead of changing its status.");
  assert.equal(document.querySelectorAll('#rows [data-action="cycle-status"]').length, 0);
});

test("in review mode a click on a scene's length opens no editor and shows the length toast", async () => {
  await reviewClick('#rows .row[data-id="r1"] .row-read',
    "This is a review copy — comment on a scene instead of changing its length.");
  assert.equal(document.querySelector("#rows .row-read-input"), null);
});

function backToEditMode() {
  window.__hostedTest.setSession({ role: "edit", docId: null });
  const host = document.getElementById("toast-host");
  host.textContent = "";
  return host;
}

test("in edit mode a click on a scene's length opens the editor and shows no toast", async () => {
  const { flushEdits } = await import("../js/12a-undo.js");
  const host = backToEditMode();
  flushEdits();
  const target = document.querySelector('#rows .row[data-id="r1"] .row-read');
  assert.ok(target, "the length button is on the page");
  target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.ok(document.querySelector("#rows .row-read-input"), "the editor is open");
  assert.equal(host.querySelectorAll(".toast").length, 0);
  document.querySelector("#rows .row-read-input").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(document.querySelector("#rows .row-read-input"), null);
  assert.equal(host.querySelectorAll(".toast").length, 0);
});

test("in edit mode a click on the status button cycles the status and shows no toast", async () => {
  const { flushEdits } = await import("../js/12a-undo.js");
  const host = backToEditMode();
  flushEdits();
  const target = document.querySelector('#rows .row[data-id="r1"] [data-action="cycle-status"]');
  assert.ok(target, "the status button is on the page");
  const statusOf = () => currentDocument().rows.find(r => r.id === "r1").status;
  const before = statusOf(), seq = saveChanges();
  target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.notEqual(statusOf(), before);
  assert.equal(saveChanges(), seq + 1);
  assert.equal(host.querySelectorAll(".toast").length, 0);
});
