import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { autoSavePolicy, confirmSavedNow, fileConflicts, saveDoc, setAutoSaveEnabled, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
import { createHeldDesktop, createHeldFileHandle, mockClock } from "./_m4-matrix.mjs";
import * as homeModule from "../bootstrap/wiring/location-owner.ts";
import { currentDocument, mergeBase, noteSessionEdit } from "../bootstrap/wiring/session-owner.ts";

localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { makeDesktopHandle } = await import("../adapters/desktop/desktop-handle.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");

after(closeApp);

const ID = (letter) => "d" + letter.repeat(32);

function script(title, extra) {
  return migrateRows(Object.assign({
    schema: 5, title: title, docId: ID("6"),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  }, extra || {}));
}

function useDocument(doc) {
  loadTestDocument(doc);
  undoOwner().flush();
  confirmSavedNow();
  return doc;
}

async function openFrom(handle) {
  useDocument(script("Placeholder"));
  await openDocument({ kind: "file", file: await handle.getFile(), handle: handle, options: { skipSnapshot: true, silent: true } });
  assert.equal(homeModule.currentHome().kind, "file", "the document is open from the file");
  assert.equal(homeModule.currentHome().handle, handle, "and its home holds the file's handle");
}

function edit(text) {
  currentDocument().rows[0].audioText = text;
  noteSessionEdit();
}

function scene(run) {
  return async (t) => {
    const clock = mockClock(t);
    setAutoSaveEnabled(false);
    try {
      await run(t, clock);
    } finally {
      window.__desktopTest.restoreBackend();
      fileConflicts().close();
      autoSavePolicy().resume();
      document.getElementById("toast-host").replaceChildren();
      homeModule.setHome("none");
    }
  };
}

async function turns(count) {
  for (let turn = 0; turn < (count || 40); turn++) await new Promise((resolve) => setImmediate(resolve));
}

function toasts(kind) {
  return [...document.querySelectorAll("#toast-host .toast" + (kind ? "." + kind : ""))].map((node) => node.textContent);
}

function clearToasts() {
  document.getElementById("toast-host").replaceChildren();
}

function closeWouldWarn() {
  const event = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function saveStatus() {
  return document.getElementById("save-status").textContent;
}

function observed() {
  const home = homeModule.currentHome();
  return {
    docId: currentDocument().docId,
    rev: currentDocument().rev,
    base: JSON.stringify(mergeBase()),
    record: home,
    lastModified: home.lastModified,
    diskBase: JSON.stringify(home.diskBase || null)
  };
}

function assertUnchangedByFailure(before, who) {
  const home = homeModule.currentHome();
  assert.equal(currentDocument().docId, before.docId, who + ": the document id is unchanged");
  assert.equal(currentDocument().rev, before.rev, who + ": the rev is unchanged");
  assert.equal(JSON.stringify(mergeBase()), before.base, who + ": the baseline is unchanged");
  assert.equal(home, before.record, who + ": the home is the same record");
  assert.equal(home.lastModified, before.lastModified, who + ": the home keeps its timestamp");
  assert.equal(JSON.stringify(home.diskBase || null), before.diskBase, who + ": the home keeps its disk baseline");
}

function assertSavedCleanly(who) {
  assert.equal(unsavedChanges(), false, who + ": the document is clean");
  assert.equal(closeWouldWarn(), false, who + ": closing no longer warns");
  assert.equal(fileConflicts().current(), null, who + ": no file conflict is open");
  assert.equal(toasts().some((text) => /changed on disk/i.test(text)), false, who + ": nothing says the file changed on disk");
  assert.equal(toasts("error").length, 0, who + ": no error is showing");
  assert.equal(toasts("ok").length, 1, who + ": the save says it saved");
  assert.match(toasts("ok")[0], /^Saved to /, who + ": and says where");
  assert.match(saveStatus(), /Saved/, who + ": the status line says saved");
}

const FAULTS = [
  { op: "createWritable", why: "the file is read-only", shown: /read-only/i, error: () => new DOMException("The file is read-only.", "NoModificationAllowedError") },
  { op: "write", why: "the disk is full", shown: /space on the disk/i, error: () => new DOMException("There is not enough space on the disk.", "QuotaExceededError") },
  { op: "close", why: "permission is lost while closing", shown: /not allowed/i, error: () => new DOMException("The request is not allowed by the user agent.", "NotAllowedError") }
];

for (const fault of FAULTS) {
  test("a file handle that fails at " + fault.op + " (" + fault.why + ") keeps the work, warns on close, and the next save completes", scene(async () => {
    const target = createHeldFileHandle({
      name: "fails.splitpage", text: buildSplitpageFile(exportDocumentOf(script("Failing", { docId: ID("1") }))), lastModified: 1000
    });
    const onDisk = target.text();
    await openFrom(target.handle);
    edit("Typed before the save.");
    const before = observed();
    assert.equal(closeWouldWarn(), true, "closing warns before the save");

    target.failNext(fault.op, fault.error());
    await saveDoc();
    assert.equal(target.commits.length, 0, "nothing was committed to the file");
    assert.equal(target.text(), onDisk, "the file still holds what it held");
    assertUnchangedByFailure(before, "after the failed save");
    assert.equal(unsavedChanges(), true, "the document is still dirty");
    assert.match(saveStatus(), /Unsaved changes/, "the status line still says there are unsaved changes");
    assert.equal(toasts("error").length, 1, "one error is shown");
    assert.match(toasts("error")[0], /^Could not save — /, "and it says the save failed");
    assert.match(toasts("error")[0], fault.shown, "and it says why");
    assert.equal(currentDocument().rows[0].audioText, "Typed before the save.", "the typed text is still in the document");
    assert.equal(closeWouldWarn(), true, "closing still warns");
    assert.equal(fileConflicts().current(), null, "a failed write is not reported as a conflict");

    edit("Typed after the failure.");
    clearToasts();
    await saveDoc();
    assert.equal(target.commits.length, 1, "the next save wrote the file once");
    assert.ok(target.text().includes("Typed after the failure."), "the file holds the work done since the failure");
    assert.equal(currentDocument().rev, before.rev + 1, "the rev advanced once, by the save that landed");
    assert.equal(homeModule.currentHome().lastModified, target.lastModified(), "the home holds the stamp of that write");
    assertSavedCleanly("after the retry");
  }));
}

test("a failed automatic save pauses autosave and keeps the work, and a manual save writes, clears the pause and the dirty state", scene(async (t, clock) => {
  const target = createHeldFileHandle({
    name: "auto.splitpage", text: buildSplitpageFile(exportDocumentOf(script("Automatic", { docId: ID("3") }))), lastModified: 1000
  });
  await openFrom(target.handle);
  setAutoSaveEnabled(true);
  edit("Typed before the automatic save.");
  const before = observed();

  target.failNext("write", new DOMException("There is not enough space on the disk.", "QuotaExceededError"));
  clock.tick(autoSavePolicy().idleFor());
  await turns();
  assert.equal(target.calls.includes("createWritable"), true, "the autosave timer ran a save");
  assert.equal(target.commits.length, 0, "nothing was committed");
  assertUnchangedByFailure(before, "after the failed automatic save");
  assert.equal(unsavedChanges(), true, "the document is still dirty");
  assert.match(autoSavePolicy().halted(), /^Autosave is paused — the last save failed \(There is not enough space on the disk\./, "autosave is paused with the reason");
  assert.match(saveStatus(), /Not saving/, "the status line says autosave is not saving");
  assert.equal(toasts("error").length, 1, "the failure is shown");
  assert.equal(currentDocument().rows[0].audioText, "Typed before the automatic save.", "the typed text is still in the document");
  assert.equal(fileConflicts().current(), null, "a failed write is not reported as a conflict");
  assert.equal(closeWouldWarn(), true, "closing still warns");

  clearToasts();
  await saveDoc();
  assert.equal(target.commits.length, 1, "the manual save wrote the file");
  assert.equal(autoSavePolicy().halted(), "", "and lifted the pause");
  assert.equal(homeModule.currentHome().lastModified, target.lastModified(), "the home holds the stamp of that write");
  assertSavedCleanly("after the manual save");
}));

function failingDesktop() {
  const fake = window.__desktopTest.makeFakeBackend();
  const written = [];
  const fault = { next: null };
  const realWrite = fake.writeFile;
  fake.writeFile = function (id, data) {
    if (fault.next) {
      const error = fault.next;
      fault.next = null;
      return Promise.reject(error);
    }
    written.push(id);
    return realWrite.call(fake, id, data);
  };
  const held = createHeldDesktop(fake);
  window.__desktopTest.setBackend(held.desktop);
  return { fake, fault, written, state: () => held.desktop._lastDocState };
}

async function openFromDesktop(fake, doc) {
  const picked = await fake.saveFileDialog({ suggestedName: "disk.splitpage" });
  await fake.writeFile(picked.id, new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(doc))));
  const handle = makeDesktopHandle(picked);
  useDocument(script("Placeholder"));
  await openDocument({ kind: "file", file: await handle.getFile(), handle: handle, options: { skipSnapshot: true, silent: true } });
  assert.equal(homeModule.currentHome().kind, "file", "the document is open from the desktop file");
  return picked;
}

for (const code of ["EACCES", "ENOSPC"]) {
  test("a desktop write that fails with " + code + " keeps the work, tells the desktop the document is dirty, and the next save completes", scene(async () => {
    const { fake, fault, written, state } = failingDesktop();
    const picked = await openFromDesktop(fake, script("Desktop", { docId: ID("4") }));
    const onDisk = fake._text(picked.id);
    edit("Typed before the save.");
    const before = observed();
    assert.equal(state().dirty, true, "the desktop is told the document is dirty");

    const writesBefore = written.length;
    fault.next = Object.assign(new Error(code + ": the write was refused"), { code: code });
    await saveDoc();
    assert.equal(written.length, writesBefore, "nothing was written to the file");
    assert.equal(fake._text(picked.id), onDisk, "the file still holds what it held");
    assertUnchangedByFailure(before, "after the failed desktop save");
    assert.equal(unsavedChanges(), true, "the document is still dirty");
    assert.equal(state().dirty, true, "the desktop is still told it is dirty, so quitting asks");
    assert.equal(closeWouldWarn(), true, "closing still warns");
    assert.equal(toasts("error").length, 1, "one error is shown");
    assert.match(toasts("error")[0], /^Could not save — /, "and it says the save failed");
    assert.match(toasts("error")[0], new RegExp(code), "and it says why");
    assert.equal(currentDocument().rows[0].audioText, "Typed before the save.", "the typed text is still in the document");
    assert.equal(fileConflicts().current(), null, "a failed write is not reported as a conflict");

    clearToasts();
    await saveDoc();
    assert.equal(written.length, writesBefore + 1, "the next save wrote the file once");
    assert.ok(fake._text(picked.id).includes("Typed before the save."), "the file holds the work kept through the failure");
    assert.equal(homeModule.currentHome().lastModified, (await fake.statFile(picked.id)).lastModified, "the home holds the stamp of that write");
    assert.equal(state().dirty, false, "the desktop is told the document is clean");
    assertSavedCleanly("after the desktop retry");
  }));
}
