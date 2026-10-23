import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { saveBusy, unsavedChanges } from "../legacy/save-bridge.ts";
import {
  createGates,
  createHeldDesktop,
  createHeldFetch,
  createHeldFileHandle,
  mockClock,
  rightToday
} from "./_m4-matrix.mjs";
import { documentLocation } from "../legacy/location-bridge.ts";
import { mergeBase } from "../legacy/session-bridge.ts";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportAssetsNow } = await import("../adapters/formats/export-assets.ts");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { buildDocx } = await import("../adapters/formats/docx.ts");
const { closeImportModal, handleImportFile, openImportModal } = await import("../js/11-import.js");
const { zipRead } = await import("../adapters/formats/zip.ts");
const { setBackend: setBlobBackend } = await import("../adapters/storage/02c-blobs.js");
const { noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { confirmSavedNow } = await import("../legacy/save-bridge.ts");
const { flushEdits } = await import("../js/12a-undo.js");
const { saveDoc, setAutoSaveEnabled } = await import("../js/14-export.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { closeFileConflict, exportAs, openProjectFile, saveBackToFile, showFileConflict } = await import("../js/18-local-files.js");
const { finishServerDetect } = await import("../js/13-hosted.js");
const homeModule = await import("../legacy/location-bridge.ts");
const { makeDesktopHandle, openPrompterInBrowser } = await import("../js/20f-desktop.js");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const ID = (letter) => "d" + letter.repeat(32);

function script(title, extra) {
  return migrateRows(Object.assign({
    schema: 5, title: title, docId: ID("4"),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  }, extra || {}));
}

function splitpageFile(doc, name) {
  return new File([buildSplitpageFile(exportDocumentOf(doc))], name || "m4.splitpage", { lastModified: 1 });
}

function heldFile(doc, name) {
  return createHeldFileHandle({ name: name || "held.splitpage", text: buildSplitpageFile(exportDocumentOf(doc)), lastModified: 1000 });
}

function useDocument(doc) {
  loadTestDocument(doc);
  flushEdits();
  confirmSavedNow();
  return doc;
}

async function openFrom(target) {
  useDocument(script("Placeholder"));
  await openProjectFile(await target.handle.getFile(), target.handle, { skipSnapshot: true, silent: true });
  assert.equal(homeModule.currentHome().kind, "file", "the document is open from the file");
  assert.equal(homeModule.currentHome().handle, target.handle, "and its home holds the file's handle");
}

function edit(text) {
  S.state.rows[0].audioText = text;
  noteSessionEdit();
}

async function turns(count) {
  for (let turn = 0; turn < (count || 40); turn++) await new Promise((resolve) => setImmediate(resolve));
}

const abortError = () => new DOMException("The user aborted a request.", "AbortError");

function withHeldDesktop(options) {
  const fake = window.__desktopTest.makeFakeBackend(options);
  const held = createHeldDesktop(fake);
  window.__desktopTest.setBackend(held.desktop);
  return { fake: fake, held: held };
}

async function openFromDesktop(fake, doc) {
  const picked = await fake.saveFileDialog({ suggestedName: "disk.splitpage" });
  await fake.writeFile(picked.id, new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(doc))));
  const handle = makeDesktopHandle(picked);
  useDocument(script("Placeholder"));
  await openProjectFile(await handle.getFile(), handle, { skipSnapshot: true, silent: true });
  assert.equal(homeModule.currentHome().kind, "file", "the document is open from the desktop file");
  return picked;
}

function scene(run) {
  return async (t) => {
    mockClock(t);
    setAutoSaveEnabled(false);
    try {
      await run(t);
    } finally {
      delete window.showSaveFilePicker;
      window.__desktopTest.restoreBackend();
      setBlobBackend(null);
      closeFileConflict();
      document.getElementById("save-error-banner").hidden = true;
      setHome("none");
    }
  };
}

function setHome(kind, fields) {
  return homeModule.setHome(kind, fields);
}

function homeRecord() {
  const h = homeModule.currentHome();
  return { record: h, kind: h.kind, name: h.name, handle: h.handle, lastModified: h.lastModified, diskBase: JSON.stringify(h.diskBase || null), dirty: h.dirty };
}

function observed() {
  return { docId: S.state.docId, rev: S.state.rev, base: JSON.stringify(mergeBase()), dirty: unsavedChanges(), home: homeRecord() };
}

function assertSame(before, who) {
  assert.equal(S.state.docId, before.docId, "the " + who + "'s document id is unchanged");
  assert.equal(S.state.rev, before.rev, "the " + who + "'s rev is unchanged");
  assert.equal(JSON.stringify(mergeBase()), before.base, "the " + who + "'s baseline is unchanged");
  assert.equal(unsavedChanges(), before.dirty, "the " + who + "'s dirty state is unchanged");
  const now = homeRecord();
  assert.equal(now.record, before.home.record, "the " + who + "'s home is the same record");
  assert.equal(now.lastModified, before.home.lastModified, "the " + who + "'s home keeps its timestamp");
  assert.equal(now.diskBase, before.home.diskBase, "the " + who + "'s home keeps its disk baseline");
  assert.equal(now.handle, before.home.handle, "the " + who + "'s home keeps its handle");
}

function writers(...targets) {
  return targets.reduce((n, t) => n + t.calls.filter((c) => c === "createWritable").length, 0);
}

rightToday("F1", "a file save that fails after its document was replaced leaves the replacement alone", scene(async () => {
  const target = heldFile(script("Saving", { docId: ID("1") }));
  await openFrom(target);
  edit("Typed before the save.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  await openProjectFile(splitpageFile(script("Replacement", { docId: ID("2"), rev: 7 }), "other.splitpage"), null, { skipSnapshot: true, silent: true });
  assert.equal(S.state.title, "Replacement", "the document was replaced");
  assert.equal(S.state.rev, 7, "the replacement opened with its own rev");
  const before = observed();
  target.failNext("close", new Error("disk full"));
  target.releaseOp("close");
  await saving;
  assert.equal(target.commits.length, 0, "the failed write stored nothing");
  assertSame(before, "replacement");
}));

rightToday("F1-abort", "a Save As picker that is cancelled after its document was replaced leaves the replacement alone", scene(async () => {
  const picks = createGates();
  window.showSaveFilePicker = async () => {
    await picks.pass("picker");
    throw abortError();
  };
  useDocument(script("Saving as", { docId: ID("1") }));
  edit("Typed before the dialog.");
  picks.hold("picker");
  const saving = saveDoc({ saveAs: true });
  await picks.arrived("picker");
  await openProjectFile(splitpageFile(script("Replacement", { docId: ID("2"), rev: 7 }), "other.splitpage"), null, { skipSnapshot: true, silent: true });
  assert.equal(S.state.title, "Replacement", "the document was replaced");
  assert.equal(S.state.rev, 7, "the replacement opened with its own rev");
  const before = observed();
  picks.release("picker");
  await saving;
  assertSame(before, "replacement");
}));

rightToday("F1-dialog", "a desktop save dialog that is cancelled after its document was replaced leaves the replacement alone", scene(async () => {
  const { fake, held } = withHeldDesktop();
  useDocument(script("Saving as", { docId: ID("1") }));
  edit("Typed before the dialog.");
  held.holdOp("saveFileDialog");
  const saving = saveDoc();
  await held.arrivedAt("saveFileDialog");
  await openProjectFile(splitpageFile(script("Replacement", { docId: ID("2"), rev: 7 }), "other.splitpage"), null, { skipSnapshot: true, silent: true });
  assert.equal(S.state.title, "Replacement", "the document was replaced");
  assert.equal(S.state.rev, 7, "the replacement opened with its own rev");
  const before = observed();
  fake._cancelNextSave = true;
  held.releaseOp("saveFileDialog");
  await saving;
  assertSame(before, "replacement");
}));

rightToday("F1-done", "a file save that completes after its document was replaced writes its own file and touches nothing in the replacement", scene(async () => {
  const target = heldFile(script("Saving", { docId: ID("1") }));
  await openFrom(target);
  edit("Typed before the save.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  await openProjectFile(splitpageFile(script("Replacement", { docId: ID("2"), rev: 7 }), "other.splitpage"), null, { skipSnapshot: true, silent: true });
  const before = observed();
  target.releaseOp("close");
  await saving;
  assert.equal(target.commits.length, 1, "the old document's file was written once");
  assert.ok(target.text().includes("Typed before the save."), "with the old document's text");
  assertSame(before, "replacement");
}));

rightToday("F2", "a file save that completes after a same-id reopen leaves the reopened session's baseline and dirty state alone", scene(async () => {
  const target = heldFile(script("Same id", { docId: ID("3") }));
  await openFrom(target);
  edit("Typed before the save.");
  target.holdOp("close");
  const saving = saveDoc();
  await target.arrivedAt("close");
  await openProjectFile(await target.handle.getFile(), target.handle, { skipSnapshot: true, silent: true });
  assert.equal(S.state.docId, ID("3"), "the reopened document has the same id");
  assert.equal(S.state.rows[0].audioText, "One.", "and it was read before the write landed");
  edit("Typed after the reopen.");
  const baselineBefore = JSON.stringify(mergeBase());
  target.releaseOp("close");
  await saving;
  assert.equal(unsavedChanges(), true, "the reopened session is still unsaved");
  assert.equal(JSON.stringify(mergeBase()), baselineBefore, "the reopened session's baseline is the one it opened with");
}));

rightToday("F3", "a Save As that is cancelled or fails leaves Save's target and the document id as they were", scene(async () => {
  const target = heldFile(script("Saved as", { docId: ID("1") }));
  await openFrom(target);
  edit("Typed before Save As.");
  const before = observed();

  window.showSaveFilePicker = async () => { throw abortError(); };
  await saveDoc({ saveAs: true });
  assertSame(before, "document after a cancelled Save As");
  assert.equal(target.commits.length, 0, "a cancelled Save As wrote nothing");

  const copy = createHeldFileHandle({ name: "copy.splitpage" });
  copy.failNext("close", new Error("disk full"));
  window.showSaveFilePicker = async () => copy.handle;
  await saveDoc({ saveAs: true });
  assertSame(before, "document after a failed Save As");
  assert.equal(copy.commits.length, 0, "a failed Save As stored nothing");
  assert.equal(target.commits.length, 0, "and Save's file was not written");

  const { fake } = withHeldDesktop();
  delete window.showSaveFilePicker;
  fake._cancelNextSave = true;
  useDocument(script("Desktop", { docId: ID("1") }));
  documentLocation().markWrittenOut(true);
  edit("Typed before the dialog.");
  const desktopBefore = observed();
  await saveDoc({ saveAs: true });
  assertSame(desktopBefore, "document after a cancelled desktop dialog");
}));

rightToday("F4", "an edit during the write leaves the document dirty, and the file holds the bytes without it", scene(async () => {
  const target = heldFile(script("Edited during", { docId: ID("1") }));
  await openFrom(target);
  edit("Typed before the save.");
  target.holdOp("write");
  const saving = saveDoc();
  await target.arrivedAt("write");
  edit("Typed during the write.");
  target.releaseOp("write");
  await saving;
  assert.equal(target.commits.length, 1, "the file was written once");
  assert.ok(target.text().includes("Typed before the save."), "the file holds what was captured");
  assert.ok(!target.text().includes("Typed during the write."), "and not the edit made during the write");
  assert.equal(unsavedChanges(), true, "the document is still unsaved");
  assert.equal(S.state.rows[0].audioText, "Typed during the write.", "the edit is still on screen");
}));

rightToday("F5-one", "a save with nothing else running writes once", scene(async () => {
  const target = heldFile(script("Alone", { docId: ID("1") }));
  await openFrom(target);
  edit("Typed once.");
  await saveDoc();
  assert.equal(writers(target), 1, "one writer was opened");
  assert.equal(unsavedChanges(), false, "and the document is saved");
}));

async function firstSaveInFlight() {
  const target = heldFile(script("Direct callers", { docId: ID("5") }));
  await openFrom(target);
  edit("First save's text.");
  target.holdOp("write");
  document.getElementById("btn-save").click();
  await target.arrivedAt("write");
  assert.equal(saveBusy(), true, "the first save is in flight");
  edit("Second save's text.");
  return target;
}

async function finishSaves(target, others) {
  target.gates.releaseAll("file.write");
  await turns(80);
  [target].concat(others || []).forEach((t) => t.gates.releaseAll("file.write"));
  await turns(80);
}

function assertEndsWithLaterSave(target, copy) {
  const file = homeModule.currentHome().handle === copy.handle ? copy : target;
  assert.ok(file.text().includes("Second save's text."), "the file ends with the later save's text");
}

function directCaller(id, title, trigger) {
  rightToday(id, title, scene(async () => {
    const target = await firstSaveInFlight();
    const copy = createHeldFileHandle({ name: "copy.splitpage" });
    window.showSaveFilePicker = async () => copy.handle;
    await trigger(target);
    await turns(60);
    assert.equal(writers(target, copy), 1, "no second writer was opened while the first save was writing");
    await finishSaves(target, [copy]);
    assertEndsWithLaterSave(target, copy);
  }));
}

directCaller("F5-retry", "the save-error retry waits for the save that is running", async () => {
  document.getElementById("save-error-retry").click();
});

directCaller("F5-overwrite", "the conflict overwrite waits for the save that is running", async () => {
  showFileConflict("held.splitpage", null, { kind: "project" });
  document.getElementById("file-conflict-overwrite").click();
});

directCaller("F5-copy", "the conflict copy waits for the save that is running", async () => {
  showFileConflict("held.splitpage", null, { kind: "project" });
  document.getElementById("file-conflict-copy").click();
});

rightToday("F5-stale", "overlapping saves never leave the file older than the document says it is saved", scene(async () => {
  const target = await firstSaveInFlight();
  document.getElementById("save-error-retry").click();
  await turns(60);
  await finishSaves(target);
  assert.ok(unsavedChanges() || target.text().includes(S.state.rows[0].audioText), "the document is not marked saved while its file holds older text");
}));

rightToday("F5-link", "the turned-off link's copy waits for the save that is running", scene(async () => {
  const target = await firstSaveInFlight();
  const copy = createHeldFileHandle({ name: "copy.splitpage" });
  window.showSaveFilePicker = async () => copy.handle;
  const server = createHeldFetch({ answer: () => ({ status: 403, body: { error: "link-off" } }) });
  const uninstall = server.install();
  try {
    await finishServerDetect();
  } finally {
    uninstall();
  }
  const action = document.querySelector("#toast-host .toast.has-action .toast-action");
  assert.ok(action, "the turned-off link offers a copy");
  action.click();
  await turns(60);
  sessionStorage.clear();
  assert.equal(writers(target, copy), 1, "no second writer was opened while the first save was writing");
  await finishSaves(target, [copy]);
  assertEndsWithLaterSave(target, copy);
}));

rightToday("F5-prompter", "the prompter's save waits for the save that is running", scene(async () => {
  const { fake, held } = withHeldDesktop();
  await openFromDesktop(fake, script("Prompter", { docId: ID("6") }));
  edit("First save's text.");
  held.holdOp("writeFile");
  document.getElementById("btn-save").click();
  await held.arrivedAt("writeFile");
  edit("Second save's text.");
  const prompting = openPrompterInBrowser();
  await turns(60);
  assert.equal(held.calls.filter((c) => c.op === "writeFile").length, 1, "no second write was started while the first save was writing");
  held.gates.releaseAll("desktop.writeFile");
  await prompting;
  await turns(40);
  assert.ok(new TextDecoder().decode((await fake.readFile(homeModule.currentHome().handle._desktopId)).bytes).includes("Second save's text."), "the file ends with the later save's text");
}));

rightToday("F5-saveas", "a save asked for while a Save As is writing its new file waits for it", scene(async () => {
  const copy = createHeldFileHandle({ name: "copy.splitpage" });
  window.showSaveFilePicker = async () => copy.handle;
  useDocument(script("Saving as", { docId: ID("5") }));
  edit("First save's text.");
  copy.holdOp("write");
  const saving = saveDoc({ saveAs: true });
  await copy.arrivedAt("write");
  assert.equal(homeModule.currentHome().handle, copy.handle, "setup: Save As already points Save at the new file");
  edit("Second save's text.");
  document.getElementById("save-error-retry").click();
  await turns(60);
  assert.equal(writers(copy), 1, "no second writer was opened while the Save As was writing");
  copy.gates.releaseAll("file.write");
  await saving;
  await turns(80);
  copy.gates.releaseAll("file.write");
  await turns(80);
  assert.ok(copy.text().includes("Second save's text."), "the file ends with the later save's text");
  assert.equal(unsavedChanges(), false, "and the document is saved");
}));

rightToday("F5-replaced", "a save waiting behind a running save is dropped when the document is replaced, not run against the replacement", scene(async () => {
  const target = await firstSaveInFlight();
  document.getElementById("save-error-retry").click();
  await turns(20);
  const other = heldFile(script("Replacement", { docId: ID("2"), rev: 7 }), "other.splitpage");
  await openProjectFile(await other.handle.getFile(), other.handle, { skipSnapshot: true, silent: true });
  assert.equal(S.state.title, "Replacement", "setup: the document was replaced");
  const before = observed();
  await finishSaves(target);
  assert.equal(writers(other), 0, "the replacement's file was not written");
  assertSame(before, "replacement");
}));

rightToday("F6", "a write that fails at write or close keeps the document dirty and the home and rev as they were", scene(async () => {
  for (const op of ["write", "close"]) {
    const target = heldFile(script("Fails at " + op, { docId: ID("1") }));
    await openFrom(target);
    edit("Typed before the " + op + " failed.");
    const before = observed();
    target.failNext(op, new Error("disk full"));
    await saveDoc();
    assert.equal(target.commits.length, 0, "a failure at " + op + " stored nothing");
    assertSame(before, "document after a failure at " + op);
    assert.ok(document.querySelector("#toast-host .toast.error"), "and the failure is reported (" + op + ")");
  }
}));

rightToday("F7", "a handle whose permission is refused fails without retargeting and without a write", scene(async () => {
  const target = heldFile(script("Refused", { docId: ID("1") }));
  await openFrom(target);
  edit("Typed before the save.");
  const before = observed();
  target.setPermission("prompt");
  await saveDoc();
  assert.equal(target.commits.length, 0, "an existing handle without permission wrote nothing");
  assert.equal(target.calls.includes("createWritable"), false, "and was not asked for a writer");
  assertSame(before, "document after a refused Save");
  closeFileConflict();

  const refused = createHeldFileHandle({ name: "refused.splitpage", permission: "prompt" });
  window.showSaveFilePicker = async () => refused.handle;
  await saveDoc({ saveAs: true });
  assert.equal(refused.commits.length, 0, "a picked handle without permission wrote nothing");
  assertSame(before, "document after a refused Save As");
}));

rightToday("F8", "after a desktop write the baseline timestamp is the one that write produced, not a later read's", scene(async () => {
  const { fake, held } = withHeldDesktop();
  const picked = await openFromDesktop(fake, script("Stamped", { docId: ID("7") }));
  edit("Typed before the save.");
  held.holdOp("writeFile");
  const saving = saveDoc();
  await held.arrivedAt("writeFile");
  const readsBefore = held.calls.filter((c) => c.op === "readFile").length;
  held.holdOp("readFile");
  held.releaseOp("writeFile");
  const first = await Promise.race([saving.then(() => "saved"), held.arrivedAt("readFile").then(() => "read", () => "none")]);
  const written = (await fake.statFile(picked.id)).lastModified;
  if (first === "read") {
    await fake.writeFile(picked.id, new TextEncoder().encode("changed by something else"));
    assert.notEqual((await fake.statFile(picked.id)).lastModified, written, "the file changed again before the read");
    held.releaseOp("readFile");
    await saving;
  }
  held.gates.releaseAll("desktop.readFile");
  assert.equal(homeModule.currentHome().lastModified, written, "the baseline timestamp is the one the write produced");
  assert.equal(held.calls.filter((c) => c.op === "readFile").length, readsBefore, "and no second full read followed the write");
}));

rightToday("F9", "no history copy happens before the write is confirmed, and a save never waits on a history copy that does not resolve", scene(async () => {
  const { fake, held } = withHeldDesktop({ history: true });
  await openFromDesktop(fake, script("Forked", { docId: ID("8") }));
  documentLocation().markWrittenOut(true);
  edit("Typed before Save As.");
  held.holdOp("writeFile");
  held.holdOp("historyCopy");
  const saving = saveDoc({ saveAs: true });
  await held.arrivedAt("writeFile");
  await turns(60);
  assert.equal(held.calls.filter((c) => c.op === "historyCopy").length, 0, "no history was copied before the write was confirmed");
  held.releaseOp("writeFile");
  let finished = false;
  saving.then(() => { finished = true; });
  await turns(80);
  assert.equal(finished, true, "the save finished while the history copy was still held");
  assert.equal(held.calls.filter((c) => c.op === "historyCopy").length, 1, "the history was copied once the write was confirmed");
  held.gates.releaseAll("desktop.historyCopy");
}));

rightToday("F9-warn", "a Save As that gives the copy a new document id is not reported as finishing after a reopen", scene(async () => {
  const copy = createHeldFileHandle({ name: "copy.splitpage" });
  window.showSaveFilePicker = async () => copy.handle;
  useDocument(script("Forked", { docId: ID("8") }));
  documentLocation().markWrittenOut(true);
  edit("Typed before Save As.");
  document.getElementById("toast-host").textContent = "";
  await saveDoc({ saveAs: true });
  assert.equal(copy.commits.length, 1, "setup: the copy was written");
  assert.notEqual(S.state.docId, ID("8"), "setup: the copy has its own document id");
  assert.equal(unsavedChanges(), false, "the document is saved");
  assert.equal(/after you reopened it/.test(document.getElementById("toast-host").textContent), false, "no reopen warning was shown");
}));

function importDocument() {
  return createHeldFileHandle({ name: "notes.txt", text: "Alpha line.\n\nBeta line.\n", lastModified: 1000 });
}

async function importFrom(target) {
  useDocument(script("Placeholder"));
  await openProjectFile(await target.handle.getFile(), target.handle);
  assert.equal(homeModule.currentHome().kind, "import", "the text file opened as an import");
  assert.equal(homeModule.currentHome().handle, target.handle, "with its handle");
  assert.equal(homeModule.currentHome().dirty, false, "and nothing unsaved");
}

rightToday("I1", "an edit while import writeback awaits its bytes leaves the import home unsaved", scene(async () => {
  const target = importDocument();
  await importFrom(target);
  const imported = homeModule.currentHome();
  S.state.rows[0].imageRef = { sha256: "a".repeat(64), width: 4, height: 4, mime: "image/png" };
  noteSessionEdit();
  assert.equal(imported.dirty, true, "the import home has unsaved changes");
  const gates = createGates();
  gates.hold("blob.get");
  setBlobBackend({ name: "held", persistent: false, get: async (sha) => { await gates.pass("blob.get", sha); return null; } });
  const saving = saveBackToFile();
  await gates.arrived("blob.get");
  edit("Typed while the bytes were being prepared.");
  gates.release("blob.get");
  await saving;
  assert.equal(target.commits.length, 1, "the file was written");
  assert.equal(imported.dirty, true, "the import home is still unsaved after an edit made while its bytes were prepared");
}));

rightToday("I2", "import writeback acknowledges only the import home", scene(async () => {
  const target = importDocument();
  await importFrom(target);
  const imported = homeModule.currentHome();
  edit("Typed before the write back.");
  const before = observed();
  await saveBackToFile();
  assert.equal(target.commits.length, 1, "the file was written");
  assert.equal(imported.dirty, false, "the import home is saved");
  assert.equal(homeModule.currentHome(), before.home.record, "the home is the same record");
  assert.equal(unsavedChanges(), before.dirty, "the document's dirty state is unchanged");
  assert.equal(JSON.stringify(mergeBase()), before.base, "the document's baseline is unchanged");
  assert.equal(S.state.rev, before.rev, "the document's rev is unchanged");
  assert.equal(S.state.docId, before.docId, "the document's id is unchanged");
}));

const WRITEBACK_SOURCES = [
  ["txt", "notes.txt", () => "Alpha line.\n\nBeta line.\n"],
  ["md", "notes.md", () => "Alpha line.\n\nBeta line.\n"],
  ["csv", "plan.csv", () => "Visual,Audio\nWide,Alpha line.\nClose,Beta line.\n"],
  ["docx", "plan.docx", () => {
    const doc = exportDocumentOf(script("Source"));
    return buildDocx(doc, exportAssetsNow(doc));
  }]
];

async function writtenText(kind, bytes) {
  if (kind !== "docx") return new TextDecoder().decode(bytes);
  const zip = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return new TextDecoder().decode(await zip.get("word/document.xml"));
}

rightToday("I3", "import writeback stores the document as it stood when the write back began, while its bytes are held, for every import format", scene(async () => {
  for (const [kind, name, source] of WRITEBACK_SOURCES) {
    const target = createHeldFileHandle({ name: name, text: source(), lastModified: 1000 });
    await importFrom(target);
    assert.equal(homeModule.currentHome().format, kind, "setup: the " + kind + " file is the import home's format");
    S.state.rows[0].imageRef = { sha256: "a".repeat(64), width: 4, height: 4, mime: "image/png" };
    edit("Captured words.");
    const gates = createGates();
    gates.hold("blob.get");
    setBlobBackend({ name: "held", persistent: false, get: async (sha) => { await gates.pass("blob.get", sha); return null; } });
    const saving = saveBackToFile();
    await gates.arrived("blob.get");
    edit("Typed while held.");
    gates.release("blob.get");
    await saving;
    setBlobBackend(null);
    assert.equal(target.commits.length, 1, "the " + kind + " file was written");
    const stored = await writtenText(kind, target.commits[0].bytes);
    assert.match(stored, /Captured words\./, "the stored " + kind + " holds the words typed before the write back");
    assert.doesNotMatch(stored, /Typed while held/, "the stored " + kind + " leaves out the words typed while its bytes were held");
    assert.match(S.state.rows[0].audioText, /Typed while held/, "the live document keeps the later words");
    assert.equal(homeModule.currentHome().dirty, true, "and the " + kind + " import home is still unsaved");
  }
}));

function heldTextFile(name, text) {
  const gates = createGates();
  gates.hold("text");
  return {
    gates: gates,
    file: { name: name, size: text.length, text: async () => { await gates.pass("text"); return text; } }
  };
}

function importModalShows(pattern) {
  return pattern.test(document.getElementById("import-preview").textContent);
}

rightToday("I4", "a file decoded for an import that was closed and opened again does not fill the reopened import", scene(async () => {
  useDocument(script("Importing"));
  const late = heldTextFile("late.csv", "Visual,Audio\nLate,Late words.\n");
  openImportModal();
  const decoding = handleImportFile(late.file);
  await late.gates.arrived("text");
  closeImportModal();
  openImportModal();
  late.gates.release("text");
  await decoding;
  assert.equal(importModalShows(/late\.csv/), false, "the reopened import does not offer the earlier file");
  document.getElementById("import-textarea").value = "Typed line.";
  document.getElementById("import-confirm").click();
  assert.equal(S.state.rows.length, 3, "only the typed scene was imported");
  assert.doesNotMatch(JSON.stringify(S.state.rows), /Late words/, "the earlier file's scenes are not in the document");
}));

rightToday("I5", "a file decoded for an import into a document that was replaced meanwhile fills nothing", scene(async () => {
  useDocument(script("Importing"));
  const late = heldTextFile("late.csv", "Visual,Audio\nLate,Late words.\n");
  openImportModal();
  const decoding = handleImportFile(late.file);
  await late.gates.arrived("text");
  await openProjectFile(splitpageFile(script("Replacement", { docId: ID("5") })), null, { skipSnapshot: true, silent: true });
  assert.equal(S.state.docId, ID("5"), "setup: the other document is open");
  late.gates.release("text");
  await decoding;
  assert.equal(importModalShows(/late\.csv/), false, "the import does not offer the file decoded for the replaced document");
  closeImportModal();
}));

rightToday("I6", "confirming an import after its document was replaced adds nothing to the replacement", scene(async () => {
  useDocument(script("Importing"));
  openImportModal();
  document.getElementById("import-textarea").value = "Meant for the first document.";
  await openProjectFile(splitpageFile(script("Replacement", { docId: ID("6") })), null, { skipSnapshot: true, silent: true });
  const replacement = S.state;
  const before = observed();
  const rows = JSON.stringify(replacement.rows);
  document.getElementById("toast-host").textContent = "";
  document.getElementById("import-confirm").click();
  assert.equal(S.state, replacement, "the replacement is still open");
  assert.equal(JSON.stringify(S.state.rows), rows, "its scenes are unchanged");
  assertSame(before, "replacement");
  assert.equal(document.getElementById("import-modal").hidden, true, "the import closed");
  const told = document.getElementById("toast-host").textContent;
  assert.ok(told && !/Imported/.test(told), "the user is told nothing was imported");
}));

test("import writeback is the import destination's save: it waits behind a writeback in flight and runs after it", scene(async () => {
  const gates = createGates();
  const target = createHeldFileHandle({ name: "notes.txt", text: "Alpha line.\n\nBeta line.\n", lastModified: 1000, gates: gates });
  await importFrom(target);
  edit("Typed before the first write back.");
  gates.hold("file.close");
  const first = saveBackToFile();
  await gates.arrived("file.close");
  edit("Typed while the first write back was writing.");
  const second = saveBackToFile();
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(target.calls.filter((op) => op === "createWritable").length, 1, "the second write back has not opened the file while the first holds it");
  gates.release("file.close");
  await first;
  await second;
  assert.equal(target.commits.length, 2, "both write backs reached the file, one after the other");
  assert.equal(homeModule.currentHome().dirty, false, "the import home is saved once the second has landed");
}));

test("an import writeback that lands after another file was imported leaves the new import home's unsaved state alone", scene(async () => {
  const gates = createGates();
  const target = createHeldFileHandle({ name: "notes.txt", text: "Alpha line.\n\nBeta line.\n", lastModified: 1000, gates: gates });
  await importFrom(target);
  edit("Typed before the write back.");
  gates.hold("file.close");
  const saving = saveBackToFile();
  await gates.arrived("file.close");
  const other = createHeldFileHandle({ name: "other.txt", text: "Gamma line.\n\nDelta line.\n", lastModified: 2000 });
  await openProjectFile(await other.handle.getFile(), other.handle);
  const replaced = homeModule.currentHome();
  edit("Typed in the other file.");
  assert.equal(replaced.dirty, true);
  gates.release("file.close");
  await saving;
  assert.equal(target.commits.length, 1, "the first file was written");
  assert.equal(homeModule.currentHome(), replaced, "the other file is still the import home");
  assert.equal(replaced.dirty, true, "and still unsaved");
}));

test("a writeback queued behind another writes nothing once a different file was imported while it waited", scene(async () => {
  const gates = createGates();
  const target = createHeldFileHandle({ name: "notes.txt", text: "Alpha line.\n\nBeta line.\n", lastModified: 1000, gates: gates });
  await importFrom(target);
  edit("Typed before the write backs.");
  gates.hold("file.close");
  const first = saveBackToFile();
  await gates.arrived("file.close");
  const second = saveBackToFile();
  const other = createHeldFileHandle({ name: "other.txt", text: "Gamma line.\n\nDelta line.\n", lastModified: 2000 });
  await openProjectFile(await other.handle.getFile(), other.handle);
  const replaced = homeModule.currentHome();
  edit("Typed in the other file.");
  gates.release("file.close");
  await first;
  await second;
  assert.equal(target.commits.length, 1, "the first write back reached its own file");
  assert.equal(other.commits.length, 0, "the queued write back did not write the file imported after it was asked for");
  assert.equal(homeModule.currentHome(), replaced, "the other file is still the import home");
  assert.equal(replaced.dirty, true, "and still unsaved");
}));

function noDownloads() {
  const clicks = [];
  const make = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const click = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => "blob:m4-matrix/export";
  URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { clicks.push(this.download); };
  return {
    clicks: clicks,
    restore: () => {
      URL.createObjectURL = make;
      URL.revokeObjectURL = revoke;
      window.HTMLAnchorElement.prototype.click = click;
    }
  };
}

rightToday("D1", "an export acknowledges nothing", scene(async () => {
  const target = heldFile(script("Exported", { docId: ID("9") }));
  await openFrom(target);
  edit("Typed before the exports.");
  const before = observed();
  const downloads = noDownloads();
  try {
    for (const kind of ["md", "html", "csv", "txt"]) {
      await exportAs(kind);
      assertSame(before, "document after the " + kind + " export");
    }
  } finally {
    downloads.restore();
  }
  assert.equal(downloads.clicks.length, 4, "four files were handed to the browser");
  assert.equal(target.commits.length, 0, "and the document's own file was not written");

  const { fake, held } = withHeldDesktop();
  const picked = await openFromDesktop(fake, script("Exported on the desktop", { docId: ID("9") }));
  edit("Typed before the desktop export.");
  const desktopBefore = observed();
  const stored = await fake.readFile(picked.id);
  await exportAs("md");
  assert.ok(held.calls.some((c) => c.op === "writeFile" && c.args[0] !== picked.id), "the export went to a file of its own");
  assertSame(desktopBefore, "document after the desktop export");
  assert.deepEqual(Array.from((await fake.readFile(picked.id)).bytes), Array.from(stored.bytes), "and the document's own file holds what it held");
}));
