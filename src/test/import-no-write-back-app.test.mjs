import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHeldFileHandle } from "./_m4-matrix.mjs";

localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { currentDocument, noteSessionEdit } = await import("../bootstrap/wiring/session-owner.ts");
const { confirmSavedNow, fileConflicts, requestSave, saveDoc, setAutoSaveEnabled } = await import("../bootstrap/wiring/save-owners.ts");
const { currentHome, importHome, setHome } = await import("../bootstrap/wiring/location-owner.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { localFileMenuControls } = await import("../bootstrap/wiring/local-files.ts");
const { applyTakenDraft } = await import("../bootstrap/wiring/drafts.ts");
const { appActions } = await import("../bootstrap/wiring/ports/actions.ts");
const { runMenuCommand } = await import("../application/desktop/menu-commands.ts");
const { makeDesktopHandle } = await import("../adapters/desktop/desktop-handle.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const SOURCE = "Alpha line.\n\nBeta line.\n";
const SAVE_CHOICES = [
  { description: "Markdown script", accept: { "text/markdown": [".md"] } },
  { description: "Splitpage script", accept: { "application/json": [".splitpage"] } }
];
const DESKTOP_SAVE_CHOICES = [
  { name: "Markdown script", extensions: ["md"] },
  { name: "Splitpage script", extensions: ["splitpage"] }
];

function placeholder() {
  loadTestDocument(migrateRows({ schema: 5, title: "Placeholder", docId: "d" + "1".repeat(32),
    rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo" }] }));
  undoOwner().flush();
  confirmSavedNow();
}

function edit(text) {
  currentDocument().rows[0].audioText = text;
  noteSessionEdit();
}

function wrote(target) {
  return target.calls.filter((op) => op === "createWritable" || op === "write" || op === "close");
}

function scene(run) {
  return async () => {
    const asked = [];
    const picked = createHeldFileHandle({ name: "notes.md", text: "" });
    window.showSaveFilePicker = async (options) => { asked.push(options); return picked.handle; };
    setAutoSaveEnabled(false);
    try {
      await run({ asked, picked });
    } finally {
      delete window.showSaveFilePicker;
      window.__desktopTest.restoreBackend();
      setAutoSaveEnabled(false);
      fileConflicts().close();
      setHome("none");
      confirmSavedNow();
    }
  };
}

async function importText(target) {
  placeholder();
  await openDocument({ kind: "file", file: await target.handle.getFile(), handle: target.handle });
}

test("an imported file opens as a script with no file, and nothing in the app offers to write back to it", scene(async () => {
  const target = createHeldFileHandle({ name: "notes.txt", text: SOURCE, lastModified: 1000 });
  await importText(target);
  assert.equal(currentHome().kind, "none", "the script has no file, like a new untitled script");
  assert.equal(importHome(), null, "no import home is recorded");
  assert.equal(currentDocument().title, "notes", "the imported file's name is the script's name");
  assert.match(currentDocument().rows.map((row) => row.audioText).join(" "), /Alpha line\./, "the file's content is open");
  localFileMenuControls().updateFileChip();
  assert.equal(document.getElementById("file-chip").hidden, true, "the header shows no imported file");
  assert.equal(document.getElementById("menu-save-back"), null, "the file menu has no write-back item");
  assert.equal(document.querySelector('[data-file-action="save-back"]'), null, "no menu item runs a write-back");
  assert.equal(appActions.has("save-back"), false, "no action writes back");
  const labels = appActions.list("command-menu").map((action) => action.label);
  assert.deepEqual(labels.filter((label) => /notes\.txt|write back|Save to file|Save a new copy of/i.test(label)), [], "no command offers a write-back");
  assert.doesNotMatch(document.body.textContent, /Save to notes\.txt|Save a new copy of notes\.txt|Not written back/, "no menu, prompt or status line mentions one");
  assert.deepEqual(wrote(target), [], "the imported file was only read");
}));

test("Save after an import asks for a new project file with the usual choices and default, and the imported file is never written", scene(async ({ asked, picked }) => {
  const target = createHeldFileHandle({ name: "notes.txt", text: SOURCE, lastModified: 1000 });
  await importText(target);
  edit("Typed after the import.");
  setAutoSaveEnabled(true);
  const auto = await requestSave({ kind: "autosave" });
  assert.equal(auto.kind, "refused", "autosave has nowhere to write a script with no file");
  setAutoSaveEnabled(false);
  assert.equal(runMenuCommand("save-back"), false, "the desktop menu command for a write-back is not handled");
  localFileMenuControls().handleFileMenuAction("save-back", "menu");
  fileConflicts().show({ fileName: "notes.txt", current: null, kind: "import" });
  document.getElementById("file-conflict-overwrite").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [], "none of those asked where to save");
  assert.deepEqual(wrote(target), [], "none of those wrote the imported file");
  await saveDoc();
  assert.deepEqual(asked, [{ suggestedName: "notes.md", types: SAVE_CHOICES }], "Save asks where, as for any script with no file");
  assert.equal(picked.commits.length, 1, "the script was saved to the picked file");
  assert.match(picked.text(), /Typed after the import\./);
  assert.equal(currentHome().kind, "file", "the picked file is now the script's file");
  assert.equal(currentHome().handle, picked.handle);
  edit("Typed after the first save.");
  await saveDoc();
  assert.equal(picked.commits.length, 2, "the next Save writes the picked file again");
  assert.deepEqual(wrote(target), [], "the imported file was never written");
  assert.equal(target.text(), SOURCE, "and still holds what it held");
}));

test("Save after a desktop import asks for a new project file and never writes the imported file's path", scene(async () => {
  const fake = window.__desktopTest.makeFakeBackend();
  const asked = [];
  const written = [];
  const source = await fake.saveFileDialog({ suggestedName: "notes.txt" });
  await fake.writeFile(source.id, new TextEncoder().encode(SOURCE));
  window.__desktopTest.setBackend(Object.assign({}, fake, {
    saveFileDialog: (options) => { asked.push(options); return fake.saveFileDialog(options); },
    writeFile: (id, ...rest) => { written.push(id); return fake.writeFile(id, ...rest); }
  }));
  const handle = makeDesktopHandle(source);
  placeholder();
  await openDocument({ kind: "file", file: await handle.getFile(), handle: handle });
  assert.equal(currentHome().kind, "none", "the desktop import has no file either");
  edit("Typed after the desktop import.");
  await saveDoc();
  assert.deepEqual(asked, [{ suggestedName: "notes.md", filters: DESKTOP_SAVE_CHOICES }], "Save asks where, with the usual choices");
  assert.equal(written.length, 1, "Save wrote one file");
  assert.notEqual(written[0], source.id, "and not the imported one");
  assert.equal(new TextDecoder().decode((await fake.readFile(source.id)).bytes), SOURCE, "the imported file is unchanged");
}));

test("a home an older build recorded as an import loads, and Save treats it as a script with no file", scene(async ({ asked, picked }) => {
  const target = createHeldFileHandle({ name: "old.txt", text: SOURCE, lastModified: 1000 });
  placeholder();
  setHome("import", { name: "old.txt", handle: target.handle, format: "txt", inPlace: true, dirty: false, lastModified: 1000 });
  edit("Typed on the old import.");
  setAutoSaveEnabled(true);
  const auto = await requestSave({ kind: "autosave" });
  assert.equal(auto.kind, "refused", "autosave does not write the old import");
  setAutoSaveEnabled(false);
  await saveDoc();
  assert.deepEqual(asked, [{ suggestedName: "placeholder.md", types: SAVE_CHOICES }], "Save asks for a new project file");
  assert.equal(picked.commits.length, 1);
  assert.equal(currentHome().handle, picked.handle, "the picked file is the script's file");
  assert.deepEqual(wrote(target), [], "the old imported file was never written");
}));

test("a recovery draft that records an import loads as a script with no file, and Save asks where", scene(async ({ asked, picked }) => {
  placeholder();
  const restored = await applyTakenDraft({
    header: { origin: { kind: "import", importName: "notes.txt" } },
    stateJson: JSON.stringify({ schema: 5, title: "Imported draft", docId: "d" + "2".repeat(32),
      rows: [{ id: "r1", visualText: "Wide", audioText: "Recovered words.", status: "todo" }] })
  });
  assert.notEqual(restored, "failed", "the draft loads");
  assert.match(currentDocument().rows[0].audioText, /Recovered words\./, "with its content");
  assert.equal(currentHome().kind, "none", "and no file");
  await saveDoc();
  assert.deepEqual(asked, [{ suggestedName: "imported-draft.md", types: SAVE_CHOICES }]);
  assert.equal(picked.commits.length, 1, "Save wrote the picked file");
}));
