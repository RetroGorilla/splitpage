import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHeldFileHandle } from "./_m4-matrix.mjs";
import { currentDocument, runCommand } from "../bootstrap/wiring/session-owner.ts";
import { documentTransitions, openDocument } from "../bootstrap/wiring/transition-owners.ts";
import { documentLocation, currentHome } from "../bootstrap/wiring/location-owner.ts";
import { saveDoc, setAutoSaveEnabled, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
import { titleCommand } from "../application/commands/title.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";

localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);
setAutoSaveEnabled(false);

function fresh(extra = {}) {
  documentTransitions().startNew({ from: { raw: { title: "Untitled Script", rows: [{ id: "r1", audioText: "Hello", visualText: "" }], ...extra } }, destination: { kind: "none" }, reason: "first save test" });
  documentLocation().markWrittenOut(false);
  undoOwner().flush();
}

function target(name) {
  const file = createHeldFileHandle({ name, text: "" });
  window.showSaveFilePicker = async () => file.handle;
  return file;
}

test("first save names the live title and both tags, stays clean, and undoes as one change without losing its file", async () => {
  fresh();
  target("Headset ad v3.md");
  document.getElementById("doc-title").focus();
  const before = undoOwner().sizes().undo;
  await saveDoc();
  undoOwner().flush();
  assert.equal(currentDocument().title, "Headset ad");
  assert.equal(currentDocument().titleVersion, "v3");
  assert.equal(unsavedChanges(), false);
  assert.equal(undoOwner().sizes().undo, before + 1);
  assert.equal(document.getElementById("doc-title").value, "Headset ad");
  for (const id of ["doc-version", "writer-version"]) {
    assert.equal(document.getElementById(id)?.textContent, "v3");
    assert.equal(document.getElementById(id)?.hidden, false);
  }
  const home = currentHome();
  undoOwner().undo();
  assert.equal(currentDocument().title, "Untitled Script");
  assert.equal(currentDocument().titleVersion, undefined);
  assert.equal(currentDocument().titleOrigin, undefined);
  assert.equal(unsavedChanges(), true);
  assert.equal(currentHome(), home);
  undoOwner().redo();
  assert.equal(currentDocument().titleVersion, "v3");
  await saveDoc({ saveAs: true });
  assert.equal(unsavedChanges(), false);
});

test("a replacement while the first save writes receives neither the earlier title nor tag", async () => {
  fresh();
  const file = target("Headset v3.md");
  file.gates.hold("file.close");
  const saving = saveDoc();
  await file.gates.arrived("file.close");
  fresh({ title: "Replacement" });
  file.gates.release("file.close");
  await saving;
  assert.equal(currentDocument().title, "Replacement");
  assert.equal(currentDocument().titleVersion, undefined);
  assert.equal(currentHome().kind, "none");
  assert.equal(undoOwner().sizes().undo, 0);
});

test("undo of an unversioned first-save title updates a focused title input", async () => {
  fresh();
  target("Headset ad.md");
  const input = document.getElementById("doc-title");
  input.focus();
  await saveDoc();
  undoOwner().flush();
  assert.equal(input.value, "Headset ad");
  undoOwner().undo();
  assert.equal(currentDocument().title, "Untitled Script");
  assert.equal(input.value, "Untitled Script");
});

test("both project formats reopen with the file provenance and tag; Save As only changes the tag", async () => {
  for (const ext of ["md", "splitpage"]) {
    fresh();
    const file = target("Headset ad V3." + ext);
    await saveDoc();
    await openDocument({ kind: "file", file: await file.handle.getFile(), handle: file.handle, options: { skipSnapshot: true, silent: true } });
    assert.equal(currentDocument().title, "Headset ad");
    assert.equal(currentDocument().titleVersion, "v3");
    assert.equal(currentDocument().titleOrigin, "file");
    target("Different name_v42." + ext);
    await saveDoc({ saveAs: true });
    assert.equal(currentDocument().title, "Headset ad");
    assert.equal(currentDocument().titleVersion, "v42");
    target("Different name." + ext);
    await saveDoc({ saveAs: true });
    assert.equal(currentDocument().titleVersion, undefined);
    assert.equal(unsavedChanges(), false);
  }
});

test("typed titles including a typed default are never replaced, and their tags stay on Save As", async () => {
  fresh();
  runCommand(titleCommand("My title"));
  runCommand(titleCommand("Untitled Script"));
  target("File v8.md");
  await saveDoc();
  assert.equal(currentDocument().title, "Untitled Script");
  assert.equal(currentDocument().titleVersion, undefined);
  fresh({ title: "Old file", titleOrigin: "file", titleVersion: "v3" });
  runCommand(titleCommand("My title"));
  target("Other v9.md");
  await saveDoc({ saveAs: true });
  assert.equal(currentDocument().title, "My title");
  assert.equal(currentDocument().titleVersion, "v3");
});

test("a title typed while the write waits wins and remains dirty after save completion", async () => {
  fresh();
  const file = target("Headset v3.md");
  file.gates.hold("file.close");
  const saving = saveDoc();
  await file.gates.arrived("file.close");
  runCommand(titleCommand("Typed during save"));
  file.gates.release("file.close");
  await saving;
  assert.equal(currentDocument().title, "Typed during save");
  assert.equal(currentDocument().titleOrigin, "user");
  assert.equal(currentDocument().titleVersion, undefined);
  assert.equal(unsavedChanges(), true);
});
