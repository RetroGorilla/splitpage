import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileConflicts, saveDoc, setAutoSaveEnabled, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
import { createHeldFileHandle, mockClock } from "./_m4-matrix.mjs";
import * as homeModule from "../bootstrap/wiring/location-owner.ts";
import { currentDocument, noteSessionEdit } from "../bootstrap/wiring/session-owner.ts";

localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { confirmSavedNow } = await import("../bootstrap/wiring/save-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");

after(closeApp);

function script(title) {
  return migrateRows({
    schema: 5, title: title, docId: "d" + "7".repeat(32),
    rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo" }]
  });
}

const toasts = (kind) => [...document.querySelectorAll("#toast-host .toast" + (kind ? "." + kind : ""))].map((node) => node.textContent);

test("a handle whose permission was withdrawn fails the save with an error and no conflict dialog, and saves once it is granted again", async (t) => {
  mockClock(t);
  setAutoSaveEnabled(false);
  const target = createHeldFileHandle({ name: "locked.splitpage", text: buildSplitpageFile(exportDocumentOf(script("Locked"))), lastModified: 1000 });
  try {
    loadTestDocument(script("Placeholder"));
    undoOwner().flush();
    confirmSavedNow();
    await openDocument({ kind: "file", file: await target.handle.getFile(), handle: target.handle, options: { skipSnapshot: true, silent: true } });
    currentDocument().rows[0].audioText = "Typed before the save.";
    noteSessionEdit();
    const home = homeModule.currentHome();

    target.setPermission("prompt");
    await saveDoc();
    assert.equal(fileConflicts().current(), null, "no file conflict is opened for a permission problem");
    assert.equal(toasts("error").length, 1, "an error is shown");
    assert.match(toasts("error")[0], /^Could not save — permission to change locked\.splitpage was withdrawn\./);
    assert.equal(target.commits.length, 0, "nothing was written");
    assert.equal(unsavedChanges(), true, "the document is still unsaved");
    assert.equal(homeModule.currentHome(), home, "the home is the same record");
    assert.equal(currentDocument().rows[0].audioText, "Typed before the save.", "the work is still in the document");

    target.setPermission("granted");
    document.getElementById("toast-host").replaceChildren();
    await saveDoc();
    assert.equal(target.commits.length, 1, "the next save wrote the file");
    assert.ok(target.text().includes("Typed before the save."), "with the work kept through the failure");
    assert.equal(unsavedChanges(), false, "and the document is clean");
    assert.equal(fileConflicts().current(), null, "and still no conflict");
    assert.equal(toasts("error").length, 0, "and no error");
  } finally {
    fileConflicts().close();
    document.getElementById("toast-host").replaceChildren();
    homeModule.setHome("none");
  }
});
