import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHeldFileHandle, mockClock } from "./_m4-matrix.mjs";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
after(closeApp);

const { currentDocument, noteSessionEdit } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const saves = await import("../bootstrap/wiring/save-owners.ts");
const { autoSavePolicy, confirmSavedNow, setAutoSaveEnabled } = saves;
const homeModule = await import("../bootstrap/wiring/location-owner.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { saveStatus } = await import("../application/save/status.ts");
const { importSavingOwner } = await import("../bootstrap/wiring/local-files.ts");

const ID = (letter) => "d" + letter.repeat(32);
const SAVED = { label: "Save", wr: "Save", disabled: false, dirty: false, status: "Saved" };
const UNSAVED = { label: "Save •", wr: "Save •", disabled: false, dirty: true, status: "Unsaved changes" };

function script(title, docId) {
  return migrateRows({
    schema: 5, title: title, docId: docId,
    rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo" }]
  });
}

function openImport(name, letter) {
  const target = createHeldFileHandle({ name: name, text: "One.", lastModified: 1000 });
  loadTestDocument(script(name, ID(letter)));
  undoOwner().flush();
  homeModule.setHome("import", { name: name, format: "txt", dirty: false, handle: target.handle, inPlace: true, lastModified: 1000 });
  confirmSavedNow();
  return target;
}

function edit(text) {
  currentDocument().rows[0].audioText = text;
  noteSessionEdit();
}

function painted() {
  const btn = document.getElementById("btn-save");
  return {
    label: btn.textContent,
    wr: document.getElementById("wr-save").textContent,
    disabled: btn.disabled,
    dirty: btn.classList.contains("is-dirty"),
    status: document.getElementById("save-status").textContent
  };
}

function projected() {
  const home = homeModule.currentHome();
  const view = saveStatus({
    busy: saves.saveBusy(),
    dirty: saves.unsavedChanges(),
    halted: autoSavePolicy().halted(),
    autoSaveOn: autoSavePolicy().enabled(),
    target: saves.autoSaveTarget(),
    where: home.kind === "import" ? home.name || "" : "",
    homeKind: home.kind
  });
  const b = view.button;
  return { label: b.label, wr: b.label, disabled: b.disabled, dirty: b.dirty, status: view.line ? view.line.text : "" };
}

function settledAs(expected, importDirty) {
  assert.deepEqual(painted(), projected(), "the painted Save controls are saveStatus() of the state now");
  assert.deepEqual(painted(), expected);
  assert.equal(homeModule.currentHome().dirty, importDirty, "the import home and the Save controls agree");
}

function scene(run) {
  return async (t) => {
    mockClock(t);
    setAutoSaveEnabled(false);
    try {
      await run(t);
    } finally {
      homeModule.setHome("none");
      confirmSavedNow();
    }
  };
}

test("an import save-back with no edit after its capture reads saved", scene(async () => {
  const target = openImport("first.txt", "a");
  edit("Typed before the save.");
  settledAs(UNSAVED, true);
  await importSavingOwner().saveBackToFile();
  assert.ok(target.text().includes("Typed before the save."));
  settledAs(SAVED, false);
}));

test("an import save-back with an edit after its capture still reads unsaved", scene(async () => {
  const target = openImport("second.txt", "b");
  edit("Typed before the save.");
  target.holdOp("close");
  const saving = importSavingOwner().saveBackToFile();
  await target.arrivedAt("close");
  edit("Typed during the save.");
  target.releaseOp("close");
  await saving;
  assert.ok(!target.text().includes("Typed during the save."));
  settledAs(UNSAVED, true);
}));

test("an import save-back that falls back to a download with no edit after its capture reads saved", scene(async () => {
  loadTestDocument(script("third.txt", ID("c")));
  undoOwner().flush();
  homeModule.setHome("import", { name: "third.txt", format: "txt", dirty: false, handle: null, inPlace: false, lastModified: null });
  confirmSavedNow();
  edit("Typed before the copy.");
  const made = URL.createObjectURL;
  const revoked = URL.revokeObjectURL;
  const downloads = [];
  URL.createObjectURL = (blob) => { downloads.push(blob); return "blob:third"; };
  URL.revokeObjectURL = () => {};
  const stayOnPage = (event) => { event.preventDefault(); };
  document.addEventListener("click", stayOnPage, true);
  try {
    await importSavingOwner().saveBackToFile();
  } finally {
    document.removeEventListener("click", stayOnPage, true);
    URL.createObjectURL = made;
    URL.revokeObjectURL = revoked;
  }
  assert.equal(downloads.length, 1, "the copy went out as a download");
  settledAs(SAVED, false);
}));
