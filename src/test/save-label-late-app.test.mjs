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
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const saves = await import("../bootstrap/wiring/save-owners.ts");
const { autoSavePolicy, confirmSavedNow, saveDoc, setAutoSaveEnabled } = saves;
const homeModule = await import("../bootstrap/wiring/location-owner.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { saveStatus } = await import("../application/save/status.ts");
const { importSavingOwner } = await import("../bootstrap/wiring/local-files.ts");
const flushEdits = () => undoOwner().flush();

const ID = (letter) => "d" + letter.repeat(32);
const SAVED = { label: "Save", wr: "Save", disabled: false, dirty: false, status: "Saved" };
const UNSAVED = { label: "Save •", wr: "Save •", disabled: false, dirty: true, status: "Unsaved changes" };

function script(title, docId) {
  return migrateRows({
    schema: 5, title: title, docId: docId,
    rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo" }]
  });
}

function heldFile(doc, name) {
  return createHeldFileHandle({ name: name, text: buildSplitpageFile(exportDocumentOf(doc)), lastModified: 1000 });
}

async function openFrom(target) {
  loadTestDocument(script("Placeholder", ID("0")));
  flushEdits();
  confirmSavedNow();
  await openDocument({ kind: "file", file: await target.handle.getFile(), handle: target.handle, options: { skipSnapshot: true, silent: true } });
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
  const where = home.kind === "file" ? (home.handle && home.handle.name) || "" : home.kind === "import" ? home.name || "" : "";
  const view = saveStatus({
    busy: saves.saveBusy(),
    dirty: saves.unsavedChanges(),
    halted: autoSavePolicy().halted(),
    autoSaveOn: autoSavePolicy().enabled(),
    target: saves.autoSaveTarget(),
    where: where,
    homeKind: home.kind
  });
  const b = view.button;
  return { label: b.label, wr: b.label, disabled: b.disabled, dirty: b.dirty, status: view.line ? view.line.text : "" };
}

function settledAs(expected) {
  assert.deepEqual(painted(), projected(), "the painted Save controls are saveStatus() of the state now");
  assert.deepEqual(painted(), expected);
}

function beat(run) {
  return async (t) => {
    mockClock(t);
    setAutoSaveEnabled(false);
    try {
      await run(t);
    } finally {
      delete window.showSaveFilePicker;
      homeModule.setHome("none");
      confirmSavedNow();
    }
  };
}

test("I-20: an edit made while a save runs leaves the label dirty once the save lands", beat(async () => {
  const target = heldFile(script("One", ID("a")), "one.splitpage");
  await openFrom(target);
  edit("Before.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  edit("During.");
  target.releaseOp("close");
  await saving;
  settledAs(UNSAVED);
}));

test("I-20: a save that lands after another document was opened and edited shows that document's state", beat(async () => {
  const target = heldFile(script("Two", ID("b")), "two.splitpage");
  await openFrom(target);
  edit("Before.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  const other = heldFile(script("Other", ID("c")), "other.splitpage");
  await openDocument({ kind: "file", file: await other.handle.getFile(), handle: other.handle, options: { skipSnapshot: true, silent: true } });
  edit("Other edit.");
  target.releaseOp("close");
  await saving;
  settledAs(UNSAVED);
}));

test("I-20: a save that lands after the same file was reopened reads saved", beat(async () => {
  const target = heldFile(script("Three", ID("d")), "three.splitpage");
  await openFrom(target);
  edit("Before.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  await openDocument({ kind: "file", file: await target.handle.getFile(), handle: target.handle, options: { skipSnapshot: true, silent: true } });
  target.releaseOp("close");
  await saving;
  settledAs(SAVED);
}));

test("I-20: a second save waiting behind the first, with an edit during the second, ends dirty", beat(async () => {
  const target = heldFile(script("Four", ID("e")), "four.splitpage");
  await openFrom(target);
  edit("First.");
  target.holdOp("close", 2);
  const first = saveDoc();
  await target.arrivedAt("close");
  edit("Second.");
  const second = saveDoc({ force: true });
  target.releaseOp("close");
  await first;
  await target.arrivedAt("close");
  edit("Third.");
  target.releaseOp("close");
  await second;
  settledAs(UNSAVED);
}));

test("I-20: a save that fails after an edit leaves the label dirty", beat(async () => {
  const target = heldFile(script("Five", ID("f")), "five.splitpage");
  await openFrom(target);
  edit("Before.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  edit("During.");
  target.failNext("close", new Error("disk full"));
  target.releaseOp("close");
  await saving;
  settledAs(UNSAVED);
}));

test("I-20: a Save As waiting behind a running save stays busy, then ends dirty after an edit during it", beat(async () => {
  const target = heldFile(script("Six", ID("g")), "six.splitpage");
  await openFrom(target);
  edit("First.");
  target.holdOp("close");
  const first = saveDoc();
  await target.arrivedAt("close");
  edit("Second.");
  const copy = createHeldFileHandle({ name: "six-copy.splitpage", text: "", lastModified: 5000 });
  copy.holdOp("close");
  window.showSaveFilePicker = async () => copy.handle;
  const second = saveDoc({ saveAs: true });
  target.releaseOp("close");
  await first;
  assert.deepEqual(painted(), projected());
  assert.equal(painted().label, "Saving…", "the Save As started as the first save finished");
  await copy.arrivedAt("close");
  edit("Third.");
  copy.releaseOp("close");
  await second;
  settledAs(UNSAVED);
}));

test("I-20: an untitled save that picks a file while the user types, with a second Save queued, ends saved", beat(async () => {
  loadTestDocument(script("Seven", ID("h")));
  flushEdits();
  confirmSavedNow();
  edit("First.");
  const copy = createHeldFileHandle({ name: "seven.splitpage", text: "", lastModified: 5000 });
  copy.holdOp("close");
  window.showSaveFilePicker = async () => copy.handle;
  const first = saveDoc();
  await copy.arrivedAt("close");
  edit("Second.");
  const second = saveDoc();
  copy.releaseOp("close");
  await first;
  await second;
  settledAs(SAVED);
  assert.ok(copy.text().includes("Second."), "the queued save wrote the later edit");
}));

test("I-20: an autosave that runs while the user types and presses Save ends saved", beat(async () => {
  const target = heldFile(script("Eight", ID("i")), "eight.splitpage");
  await openFrom(target);
  setAutoSaveEnabled(true);
  try {
    edit("First.");
    target.holdOp("close");
    const auto = saves.requestSave({ kind: "autosave" });
    await target.arrivedAt("close");
    edit("Second.");
    const manual = saveDoc();
    target.releaseOp("close");
    await auto;
    await manual;
    settledAs(SAVED);
  } finally {
    setAutoSaveEnabled(false);
  }
}));

test("I-20: an import writeback that lands late repaints from the save state", beat(async () => {
  const target = createHeldFileHandle({ name: "nine.txt", text: "Hello", lastModified: 1000 });
  loadTestDocument(script("Nine", ID("j")));
  flushEdits();
  homeModule.setHome("import", { name: "nine.txt", format: "txt", dirty: false, handle: target.handle, inPlace: true, lastModified: 1000 });
  confirmSavedNow();
  edit("Before.");
  target.holdOp("close");
  const saving = importSavingOwner().saveBackToFile();
  await target.arrivedAt("close");
  assert.equal(painted().label, "Saving…");
  target.releaseOp("close");
  await saving;
  assert.equal(homeModule.currentHome().dirty, false, "the import reads written back");
  settledAs(UNSAVED);
}));

test("I-20: a save from a stopped app that lands after the restart leaves the new app's label alone", beat(async () => {
  const target = heldFile(script("Ten", ID("k")), "ten.splitpage");
  await openFrom(target);
  edit("Before.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  assert.equal(painted().label, "Saving…");
  const { rewireRunningApp } = await import("./_app-boot.mjs");
  await rewireRunningApp();
  const restarted = painted();
  assert.deepEqual(restarted, projected());
  target.releaseOp("close");
  await saving;
  await new Promise((resolve) => setImmediate(resolve));
  settledAs(restarted);
  assert.notEqual(restarted.label, "Saving…");
}));
