import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { createHeldFileHandle, mockClock } from "./_m4-matrix.mjs";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { clearDirty, markDirty } = await import("../js/12-dirty-toast.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { obsoleteSaveText, saveDoc, setAutoSaveEnabled } = await import("../js/14-export.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const homeModule = await import("../js/_home.js");
const saves = await import("../legacy/save-bridge.ts");

after(closeApp);

const ID = (letter) => "d" + letter.repeat(32);

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
  S.state = script("Placeholder", ID("0"));
  flushEdits();
  clearDirty();
  await openProjectFile(await target.handle.getFile(), target.handle, { skipSnapshot: true, silent: true });
}

function edit(text) {
  S.state.rows[0].audioText = text;
  markDirty();
}

function warnings() {
  return Array.from(document.querySelectorAll("#toast-host .toast.warn")).map((el) => el.textContent);
}

function buttons() {
  return ["btn-save", "wr-save"].map((id) => {
    const btn = document.getElementById(id);
    return { text: btn.textContent, disabled: btn.disabled, dirty: btn.classList.contains("is-dirty") };
  });
}

function scene(run) {
  return async (t) => {
    mockClock(t);
    setAutoSaveEnabled(false);
    try {
      await run(t);
    } finally {
      homeModule.setHome("none");
      clearDirty();
    }
  };
}

test("D10: a file save that lands after the same file was reopened is reported once with the agreed wording", scene(async () => {
  const target = heldFile(script("Reopened", ID("a")), "reopened.splitpage");
  await openFrom(target);
  edit("Typed before the save.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  await openProjectFile(await target.handle.getFile(), target.handle, { skipSnapshot: true, silent: true });
  const before = warnings().length;
  target.releaseOp("close");
  await saving;
  assert.deepEqual(warnings().slice(before), [obsoleteSaveText("Reopened")]);
}));

test("D10: a file save that lands after another file's document was opened says nothing", scene(async () => {
  const target = heldFile(script("Left", ID("b")), "left.splitpage");
  await openFrom(target);
  edit("Typed before the save.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  const other = heldFile(script("Other", ID("c")), "other.splitpage");
  await openProjectFile(await other.handle.getFile(), other.handle, { skipSnapshot: true, silent: true });
  const before = warnings().length;
  target.releaseOp("close");
  await saving;
  assert.deepEqual(warnings().slice(before), []);
}));

test("INV-20: while a save waits behind another, both Save buttons stay busy until the last one finishes, then read saved", scene(async () => {
  const target = heldFile(script("Busy", ID("d")), "busy.splitpage");
  await openFrom(target);
  edit("First.");
  target.holdOp("write");
  const first = saveDoc();
  await target.arrivedAt("write");
  edit("Second.");
  const second = saveDoc({ force: true });
  assert.equal(saves.savesWaiting(), 1, "the second save waits its turn");
  assert.deepEqual(buttons(), [{ text: "Saving…", disabled: true, dirty: false }, { text: "Saving…", disabled: true, dirty: false }]);
  target.gates.releaseAll("file.write");
  await first;
  assert.equal(saves.saveRunning(), true, "the waiting save started as the first finished");
  await second;
  assert.equal(S.dirty, false);
  assert.deepEqual(buttons(), [{ text: "Save", disabled: false, dirty: false }, { text: "Save", disabled: false, dirty: false }]);
  assert.ok(target.text().includes("Second."), "the file ends with the later save");
}));

test("clearDirty confirms the open destination at the current generation, and an edit puts it behind again", scene(async () => {
  const target = heldFile(script("Generations", ID("e")), "generations.splitpage");
  await openFrom(target);
  assert.equal(saves.unsavedFor(), false);
  edit("Typed.");
  assert.equal(S.editSeq, saves.saveChanges(), "S.editSeq is the coordinator's change generation");
  assert.equal(saves.unsavedFor(), true);
  await saveDoc();
  assert.equal(saves.confirmedGeneration(), S.editSeq);
  assert.equal(saves.unsavedFor(), false);
  assert.equal(saves.confirmedSave().baseline, S.baseState, "S.baseState is the destination's confirmed baseline");
}));
