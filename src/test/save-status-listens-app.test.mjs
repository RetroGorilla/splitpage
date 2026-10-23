import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHeldFileHandle } from "./_m4-matrix.mjs";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
after(closeApp);

const { noteAbsorbedDirty, noteSessionEdit, runCommand } = await import("../legacy/session-bridge.ts");
const { amendHome, currentHome, documentLocation, serverStatus, setHome } = await import("../legacy/location-bridge.ts");
const { preferences } = await import("../legacy/preferences-bridge.ts");
const { autoSavePolicy, confirmSavedNow, unsavedChanges } = await import("../legacy/save-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { titleCommand } = await import("../application/commands/title.ts");
const { saveDoc } = await import("../js/14-export.js");
const { toggleFileMenu } = await import("../js/18b-file-menu.js");
const { loadTestDocument } = await import("./_document.mjs");

const el = (id) => document.getElementById(id);
const button = () => el("btn-save");
const status = () => el("save-status");

function script(title) {
  return migrateRows({
    title: title,
    docId: "d" + "c".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One two.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Three four.", status: "todo" }
    ]
  });
}

function open(home) {
  toggleFileMenu(false);
  setHome("none");
  autoSavePolicy().setEnabled(false);
  loadTestDocument(script("Listening"));
  flushEdits();
  if (home) home();
  confirmSavedNow();
  flushEdits();
}

function onFile(handle) {
  return () => setHome("file", { format: "splitpage", name: handle.name, handle: handle });
}

function onImport() {
  setHome("import", { name: "listening.txt", format: "txt", dirty: false });
}

test("an edit made through the session marks the save buttons and the status line dirty without a call into them", () => {
  const target = createHeldFileHandle({ name: "listening.splitpage" });
  open(onFile(target.handle));
  assert.equal(button().textContent, "Save");
  assert.equal(button().classList.contains("is-dirty"), false);
  assert.equal(status().textContent, "Saved");
  assert.equal(runCommand(titleCommand("Edited")).kind, "applied");
  assert.equal(button().textContent, "Save •");
  assert.equal(button().classList.contains("is-dirty"), true);
  assert.equal(el("wr-save").textContent, "Save •");
  assert.equal(status().textContent, "Unsaved changes");
});

test("a legacy edit and an absorbed change refresh the buttons through the save coordinator", () => {
  open(onImport);
  noteSessionEdit();
  assert.equal(button().textContent, "Save •");
  confirmSavedNow();
  assert.equal(button().textContent, "Save");
  noteAbsorbedDirty("server");
  assert.equal(unsavedChanges(), true);
  assert.equal(button().textContent, "Save •");
});

test("confirming a save drops autosave's halt and timers, and the status line shows it saved", () => {
  const target = createHeldFileHandle({ name: "listening.splitpage" });
  open(onFile(target.handle));
  autoSavePolicy().setEnabled(true);
  noteSessionEdit();
  assert.equal(autoSavePolicy().pending(), true, "the edit armed autosave");
  autoSavePolicy().halt("Paused for the test.");
  assert.equal(status().textContent, "Not saving");
  assert.equal(status().title, "Paused for the test.");
  noteSessionEdit();
  confirmSavedNow();
  assert.equal(autoSavePolicy().halted(), "");
  assert.equal(autoSavePolicy().pending(), false);
  assert.equal(status().textContent, "Saved");
  assert.equal(button().textContent, "Save");
  autoSavePolicy().setEnabled(false);
});

test("a running save shows Saving… from its start and the saved state when it ends", async () => {
  const target = createHeldFileHandle({ name: "listening.splitpage" });
  open(onFile(target.handle));
  noteSessionEdit();
  target.gates.hold("file.createWritable");
  const saving = saveDoc();
  assert.equal(button().textContent, "Saving…");
  assert.equal(button().disabled, true);
  assert.equal(status().textContent, "Saving…");
  await target.gates.arrived("file.createWritable");
  target.gates.releaseAll("file.createWritable");
  await saving;
  assert.equal(target.commits.length, 1, "the save wrote the file");
  assert.equal(button().textContent, "Save");
  assert.equal(button().disabled, false);
  assert.equal(status().textContent, "Saved");
  assert.match(status().title, /^Last saved to listening\.splitpage at /);
  const twelve = status().title;
  preferences().setClock("24");
  try {
    assert.notEqual(status().title, twelve, "a clock change repaints the saved time");
  } finally {
    preferences().setClock("system");
  }
});

test("the open file menu refreshes from the changes it shows, and a closed one is left alone", () => {
  open(onImport);
  el("fm-card-meta").innerHTML = "stale";
  noteSessionEdit();
  assert.equal(currentHome().dirty, true);
  assert.equal(el("fm-card-meta").innerHTML, "stale", "a closed menu is not repainted");
  confirmSavedNow();
  amendHome(currentHome(), { dirty: false });
  toggleFileMenu(true);
  assert.match(el("fm-card-meta").textContent, /Up to date/);
  noteSessionEdit();
  assert.match(el("fm-card-meta").textContent, /Not written back yet/);
  toggleFileMenu(false);
});

function lastText(cell) {
  const walker = document.createTreeWalker(cell, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function typeChar(cell, ch) {
  cell.focus();
  const node = lastText(cell);
  node.data += ch;
  const range = document.createRange();
  range.setStart(node, node.data.length);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
}

test("typing paints the save buttons once per key and the status line once per paint", () => {
  const target = createHeldFileHandle({ name: "listening.splitpage" });
  open(onFile(target.handle));
  const cell = document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
  let labels = 0;
  let lines = 0;
  const label = Object.getOwnPropertyDescriptor(window.Node.prototype, "textContent");
  Object.defineProperty(button(), "textContent", { configurable: true, get() { return label.get.call(this); }, set(v) { labels++; label.set.call(this, v); } });
  Object.defineProperty(status(), "textContent", { configurable: true, get() { return label.get.call(this); }, set(v) { lines++; label.set.call(this, v); } });
  try {
    for (const ch of "abcde") typeChar(cell, ch);
    flushEdits();
  } finally {
    delete button().textContent;
    delete status().textContent;
  }
  assert.equal(labels, 5);
  assert.equal(lines, 5);
});

test("location and server status changes repaint the status line, and the link stays off for the rest of this file", () => {
  open(null);
  noteSessionEdit();
  assert.equal(status().title, "Press Save to choose where this script is kept.");
  const target = createHeldFileHandle({ name: "moved.splitpage" });
  setHome("file", { format: "splitpage", name: "moved.splitpage", handle: target.handle });
  assert.equal(status().title, "Autosave is off — press Save to write these to moved.splitpage.");
  setHome("none");
  documentLocation().setConnection({ serverUrl: "http://localhost:7777/", token: "token", role: "edit" });
  setHome("server", { id: "listening", rev: 2 });
  assert.equal(status().textContent, "Unsaved changes");
  serverStatus().turnLinkOff();
  assert.equal(status().textContent, "Not saving");
  assert.match(status().title, /turned off the link/);
});
