import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { confirmSavedNow, fileConflicts, saveDoc, setAutoSaveEnabled, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
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
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");

after(closeApp);

function script(title) {
  return migrateRows({
    schema: 5, title: title, docId: "d" + "8".repeat(32),
    rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo" }]
  });
}

function edit(text) {
  currentDocument().rows[0].audioText = text;
  noteSessionEdit();
}

test("a write that lands but cannot be read back leaves no stale timestamp, so the next save is not refused as a change on disk", async (t) => {
  mockClock(t);
  setAutoSaveEnabled(false);
  const target = createHeldFileHandle({ name: "unread.splitpage", text: buildSplitpageFile(exportDocumentOf(script("Unread"))), lastModified: 1000 });
  try {
    loadTestDocument(script("Placeholder"));
    undoOwner().flush();
    confirmSavedNow();
    await openDocument({ kind: "file", file: await target.handle.getFile(), handle: target.handle, options: { skipSnapshot: true, silent: true } });
    edit("First.");

    target.holdOp("close");
    const first = saveDoc();
    await target.arrivedAt("close");
    target.failNext("getFile", new DOMException("The file could not be read.", "NotReadableError"));
    target.releaseOp("close");
    await first;
    assert.equal(target.commits.length, 1, "the first save wrote the file");
    assert.equal(unsavedChanges(), false, "and the document is clean");
    assert.equal(homeModule.currentHome().lastModified, null, "the home holds no timestamp it cannot vouch for");

    edit("Second.");
    await saveDoc();
    assert.equal(fileConflicts().current(), null, "the next save is not refused as a change on disk");
    assert.equal(target.commits.length, 2, "it wrote the file again");
    assert.ok(target.text().includes("Second."), "with the new work");
    assert.equal(unsavedChanges(), false, "and the document is clean");
    assert.equal(homeModule.currentHome().lastModified, target.lastModified(), "the home holds that write's timestamp again");
  } finally {
    fileConflicts().close();
    document.getElementById("toast-host").replaceChildren();
    homeModule.setHome("none");
  }
});

test("after a landed write with no timestamp the next save does not look at the disk, so a change made meanwhile is overwritten", async (t) => {
  mockClock(t);
  setAutoSaveEnabled(false);
  const target = createHeldFileHandle({ name: "blind.splitpage", text: buildSplitpageFile(exportDocumentOf(script("Blind"))), lastModified: 1000 });
  try {
    loadTestDocument(script("Placeholder"));
    undoOwner().flush();
    confirmSavedNow();
    await openDocument({ kind: "file", file: await target.handle.getFile(), handle: target.handle, options: { skipSnapshot: true, silent: true } });
    edit("First.");

    target.holdOp("close");
    const first = saveDoc();
    await target.arrivedAt("close");
    target.failNext("getFile", new DOMException("The file could not be read.", "NotReadableError"));
    target.releaseOp("close");
    await first;
    assert.equal(homeModule.currentHome().lastModified, null, "the home holds no timestamp");

    const outside = await target.handle.createWritable();
    await outside.write("Changed by someone else.");
    await outside.close();

    edit("Second.");
    await saveDoc();
    assert.equal(fileConflicts().current(), null, "no conflict is raised: the check is skipped for this one save (saving.md, known gaps)");
    assert.ok(target.text().includes("Second."), "so the save overwrote the outside change");
  } finally {
    fileConflicts().close();
    document.getElementById("toast-host").replaceChildren();
    homeModule.setHome("none");
  }
});
