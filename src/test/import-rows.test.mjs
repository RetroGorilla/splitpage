import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { unsavedChanges } from "../legacy/save-bridge.ts";

await bootApp();
after(closeApp);

const { migrateRows } = await import("../js/02-state.js");
const { listDocHistory } = await import("../js/03a-history-store.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const { flushEdits, redo, undo } = await import("../js/12a-undo.js");
const { closeImportModal, handleImportFile, openImportModal } = await import("../js/11-import.js");
const homeModule = await import("../js/_home.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");

if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = function () {};

const DOC_ID = "d" + "1".repeat(32);
const EMPTY_ID = "d" + "2".repeat(32);

function script(extra) {
  return migrateRows(Object.assign({
    schema: 5, title: "Importing", docId: DOC_ID,
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "shot" }
    ]
  }, extra || {}));
}

function useDocument(doc) {
  S.state = doc;
  flushEdits();
  clearDirty();
  return doc;
}

function el(id) { return document.getElementById(id); }

function toasts() {
  return [...document.querySelectorAll("#toast-host .toast:not(.is-leaving)")].map((t) => t.textContent);
}

function clearToasts() { el("toast-host").textContent = ""; }

function pickSplit(mode) {
  const radio = document.querySelector('input[name="import-split"][value="' + mode + '"]');
  radio.checked = true;
}

function paste(text, opts) {
  opts = opts || {};
  el("import-textarea").value = text;
  pickSplit(opts.mode || "paragraph");
  el("import-replace").checked = !!opts.replace;
  const box = document.querySelector('[data-import-scan="broll"]');
  if (box && opts.scan !== undefined) box.checked = opts.scan;
}

function confirm() {
  el("import-confirm").click();
}

function observed() {
  return {
    state: S.state,
    docId: S.state.docId,
    home: homeModule.home,
    homeKind: homeModule.home.kind,
    base: JSON.stringify(S.baseState),
    rev: S.state.rev
  };
}

function rowsJson() {
  return JSON.stringify(S.state.rows);
}

function assertSameDocument(before) {
  assert.equal(S.state, before.state, "the open document is the same object");
  assert.equal(S.state.docId, before.docId, "its id is unchanged");
  assert.equal(homeModule.home, before.home, "its destination is the same record");
  assert.equal(homeModule.home.kind, before.homeKind, "of the same kind");
  assert.equal(JSON.stringify(S.baseState), before.base, "its baseline is unchanged");
  assert.equal(S.state.rev, before.rev, "its rev is unchanged");
}

function assertStamped(row) {
  assert.equal(typeof row.updatedAt, "string", "an imported scene carries an edit time");
  assert.ok(row.updatedAt.length > 0, "a non-empty edit time");
  assert.equal(typeof row.updatedBy, "string", "and an editor");
}

test("appending pasted rows keeps the document, its destination and baseline, marks it unsaved, and undoes as one step", () => {
  useDocument(script());
  const before = observed();
  const rowsBefore = rowsJson();
  clearToasts();
  openImportModal();
  paste("Alpha line.\n\nBeta line.");
  confirm();
  assert.equal(el("import-modal").hidden, true, "the modal closed");
  assert.deepEqual(S.state.rows.map((r) => r.id).slice(0, 2), ["r1", "r2"], "the existing scenes stay first");
  assert.equal(S.state.rows.length, 4, "two scenes were appended");
  assert.equal(JSON.stringify(S.state.rows.slice(0, 2)), JSON.stringify(JSON.parse(rowsBefore)), "the existing scenes are untouched");
  assert.match(S.state.rows[2].audioText, /Alpha line\./);
  assert.match(S.state.rows[3].audioText, /Beta line\./);
  S.state.rows.slice(2).forEach(assertStamped);
  assertSameDocument(before);
  assert.equal(unsavedChanges(), true, "the document has unsaved changes");
  assert.ok(toasts().some((t) => /^Imported 2 rows\./.test(t)), "the toast counts the imported rows");
  const imported = rowsJson();
  undo();
  assert.equal(rowsJson(), rowsBefore, "one undo takes the import back");
  redo();
  assert.equal(rowsJson(), imported, "redo puts it back");
});

test("replacing rows keeps the document, keeps a history version of the replaced scenes, and undoes as one step", async () => {
  useDocument(script());
  const before = observed();
  const rowsBefore = rowsJson();
  openImportModal();
  paste("Only line.", { replace: true });
  confirm();
  assert.equal(S.state.rows.length, 1, "the scenes were replaced");
  assert.match(S.state.rows[0].audioText, /Only line\./);
  assertStamped(S.state.rows[0]);
  assertSameDocument(before);
  assert.equal(unsavedChanges(), true, "the document has unsaved changes");
  const listed = await listDocHistory(DOC_ID);
  const kept = listed.entries.filter((e) => e.label === "Before replacing rows on import");
  assert.equal(kept.length, 1, "one history version was kept before the replace");
  assert.equal(kept[0].rows, 2, "holding the two replaced scenes");
  undo();
  assert.equal(rowsJson(), rowsBefore, "one undo brings the replaced scenes back");
});

test("replacing the rows of an empty document keeps no history version", async () => {
  useDocument(script({ docId: EMPTY_ID, rows: [] }));
  openImportModal();
  paste("First line.", { replace: true });
  confirm();
  assert.equal(S.state.rows.length, 1);
  const listed = await listDocHistory(EMPTY_ID);
  assert.equal(listed.entries.filter((e) => e.label === "Before replacing rows on import").length, 0, "nothing was replaced, so nothing was kept");
});

test("an import with nothing to import changes nothing and keeps the modal open", () => {
  useDocument(script());
  const rowsBefore = rowsJson();
  clearToasts();
  openImportModal();
  paste("   ");
  confirm();
  assert.equal(el("import-modal").hidden, false, "the modal stays open");
  assert.equal(rowsJson(), rowsBefore, "the document is unchanged");
  assert.equal(unsavedChanges(), false, "and has nothing unsaved");
  assert.ok(toasts().some((t) => /Paste or choose some text first/.test(t)), "the user is asked for text");
  closeImportModal();
});

test("the b-roll scan anchors an imported B-roll line in the same step, and leaves it alone when switched off", () => {
  useDocument(script());
  clearToasts();
  openImportModal();
  paste("Visual: B-roll: Drone over the hill\nAudio: We start high.", { mode: "twocolumn", scan: true });
  confirm();
  const row = S.state.rows[2];
  assert.match(row.visualText, /broll-key/, "the line became a tracked b-roll line");
  assert.ok(toasts().some((t) => /1 B-roll line found and tracked\./.test(t)), "the toast says so");
  undo();
  assert.equal(S.state.rows.length, 2, "one undo takes back the import and its scan together");

  useDocument(script());
  openImportModal();
  paste("Visual: B-roll: Drone over the hill\nAudio: We start high.", { mode: "twocolumn", scan: false });
  confirm();
  assert.doesNotMatch(S.state.rows[2].visualText, /broll-key/, "with the scan off the line is left as text");
  openImportModal();
  assert.equal(document.querySelector('[data-import-scan="broll"]').checked, false, "the choice is remembered");
  paste("Reset line.", { scan: true });
  confirm();
  assert.equal((openImportModal(), document.querySelector('[data-import-scan="broll"]').checked), true, "and switched back on");
  closeImportModal();
});

test("a decoded file waits in the modal without touching the document, then appends on confirm", async () => {
  useDocument(script());
  const before = observed();
  const rowsBefore = rowsJson();
  openImportModal();
  await handleImportFile(new File(["Visual,Audio\nCrane,Up we go.\nDolly,In we come.\n"], "plan.csv"));
  assert.match(el("import-preview").textContent, /plan\.csv — this will create 2 rows/, "the preview names the file");
  assert.equal(rowsJson(), rowsBefore, "decoding left the document alone");
  assert.equal(unsavedChanges(), false, "and marked nothing unsaved");
  confirm();
  assert.equal(S.state.rows.length, 4, "the decoded scenes were appended");
  assert.match(S.state.rows[2].visualText, /Crane/);
  assertSameDocument(before);
  assert.equal(unsavedChanges(), true);
});

test("a pasted script imported as a new document is adopted through the new-document transition and left unsaved", () => {
  const old = useDocument(script());
  clearToasts();
  const link = document.querySelector('[data-newtab-action="paste"]');
  link.click();
  assert.equal(el("import-modal").hidden, false, "the import modal opened");
  assert.equal(el("import-modal").classList.contains("is-new-document"), true, "as a new-document import");
  paste("Visual: B-roll: Pier at dawn\nAudio: Fresh start.", { mode: "twocolumn", scan: true });
  confirm();
  assert.notEqual(S.state, old, "a new document is open");
  assert.notEqual(S.state.docId, DOC_ID, "with its own id");
  assert.equal(S.state.title, "Untitled Script");
  assert.equal(S.state.rows.length, 1, "holding the imported scene only");
  assertStamped(S.state.rows[0]);
  assert.match(S.state.rows[0].visualText, /broll-key/, "the b-roll scan ran on the new document");
  assert.equal(unsavedChanges(), true, "the new document has unsaved changes");
  assert.equal(old.rows.length, 2, "the previous document is untouched");
  const imported = rowsJson();
  undo();
  assert.notEqual(S.state, old, "undo does not bring the previous document back");
  assert.equal(rowsJson(), imported, "the scan is part of the adopted document, so undo leaves the new document as it was imported");
});

function heldTextFile(name, text) {
  let arrive = null;
  let open = null;
  const reached = new Promise((resolve) => { arrive = resolve; });
  const gate = new Promise((resolve) => { open = resolve; });
  return {
    reached: reached,
    release: () => open(),
    file: { name: name, size: text.length, text: async () => { arrive(); await gate; return text; } }
  };
}

test("a later file choice wins over an earlier one that finishes decoding after it", async () => {
  useDocument(script());
  openImportModal();
  const slow = heldTextFile("slow.csv", "Visual,Audio\nSlow,Slow words.\n");
  const decodingSlow = handleImportFile(slow.file);
  await slow.reached;
  await handleImportFile(new File(["Visual,Audio\nQuick,Quick words.\n"], "quick.csv"));
  slow.release();
  await decodingSlow;
  assert.match(el("import-preview").textContent, /^quick\.csv/, "the modal offers the file chosen last");
  confirm();
  assert.match(JSON.stringify(S.state.rows), /Quick words/);
  assert.doesNotMatch(JSON.stringify(S.state.rows), /Slow words/, "the earlier file's scenes were not imported");
});

test("a file decoded for a new-document import still fills it after the open document was replaced", async () => {
  useDocument(script());
  document.querySelector('[data-newtab-action="paste"]').click();
  const late = heldTextFile("late.csv", "Visual,Audio\nLate,Late words.\n");
  const decoding = handleImportFile(late.file);
  await late.reached;
  const other = migrateRows({ schema: 5, title: "Other", docId: "d" + "3".repeat(32), rows: [{ id: "o1", visualText: "", audioText: "Other." }] });
  await openProjectFile(new File([buildSplitpageFile(exportDocumentOf(other))], "other.splitpage"), null, { skipSnapshot: true, silent: true });
  late.release();
  await decoding;
  assert.match(el("import-preview").textContent, /^late\.csv/, "the new-document import belongs to no open document, so it keeps its file");
  confirm();
  assert.equal(S.state.title, "Untitled Script", "the file became a new document");
  assert.match(JSON.stringify(S.state.rows), /Late words/);
});
