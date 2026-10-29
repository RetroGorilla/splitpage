import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { saveChanges, unsavedChanges } from "../legacy/save-bridge.ts";

await bootApp();

const { cycleRowStatus } = await import("../bootstrap/wiring/scene-status.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { setSceneLength } = await import("../features/rows/read-time.js");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");

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

function clearToasts() {
  const host = document.getElementById("toast-host");
  host.textContent = "";
  return host;
}

test("a click on a scene's length opens the editor and shows no toast", async () => {
  const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
  const flushEdits = () => undoOwner().flush();
  const host = clearToasts();
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

test("a click on the status button cycles the status and shows no toast", async () => {
  const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
  const flushEdits = () => undoOwner().flush();
  const host = clearToasts();
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
