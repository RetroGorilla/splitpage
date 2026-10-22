import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { adoptReplacement, noteServerUpdate, runCommand } = await import("../legacy/session-bridge.ts");
const { documentLocation, setHome, amendHome, currentHome, serverStatus } = await import("../legacy/location-bridge.ts");
const { preferences, viewFlags } = await import("../legacy/preferences-bridge.ts");
const { autoSavePolicy, confirmSavedNow, noteSaveChange } = await import("../legacy/save-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { titleCommand } = await import("../application/commands/title.ts");
const { mountDocumentChromeFeature, stopDocumentChromeFeature } = await import("../bootstrap/wiring/document-chrome.ts");
const writer = await import("../js/19-writer.js");

const desktop = window.__desktopTest.makeFakeBackend();
window.__desktopTest.setBackend(desktop);
after(() => {
  window.__desktopTest.restoreBackend();
  closeApp();
});

const el = (id) => document.getElementById(id);
const stateText = () => el("file-chip-state").textContent;
const identityColour = () => el("identity-chip").querySelector(".identity-dot").style.getPropertyValue("--person");

function script(title, colour = "#80BDFB") {
  return migrateRows({
    title: title,
    docId: "d" + "a".repeat(32),
    personColors: { Rae: colour },
    rows: [{ id: "r1", visualText: "Wide", audioText: "One two.", status: "todo" }]
  });
}

function open(kind = "import") {
  if (viewFlags().writerOpen()) writer.closeWriter();
  flushEdits();
  setHome("none");
  documentLocation().setConnection({ serverUrl: "http://localhost:7777", token: "token", role: "edit" });
  preferences().setCommentAuthor("Rae");
  preferences().setMyColor(null);
  autoSavePolicy().setEnabled(false);
  autoSavePolicy().resume();
  adoptReplacement(script("Listening"));
  confirmSavedNow();
  if (kind === "server") setHome("server", { id: "listening", rev: 3 });
  else if (kind === "import") setHome("import", { name: "listening.txt", dirty: false });
  else if (kind === "file") setHome("file", { format: "splitpage", name: "listening.splitpage", handle: { _desktopId: "file-1" } });
  documentLocation().markWrittenOut(true);
  flushEdits();
}

function assertMirror() {
  assert.equal(el("wr-file-chip").hidden, el("file-chip").hidden);
  assert.equal(el("wr-file-chip-name").textContent, el("file-chip-name").textContent);
  assert.equal(el("wr-file-chip-state").textContent, stateText());
  assert.equal(el("wr-file-chip-state").classList.contains("unsaved"), el("file-chip-state").classList.contains("unsaved"));
}

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

test("a session arrival refreshes both file chips, identity and desktop state before returning", () => {
  open();
  el("file-chip-name").textContent = "Stale file";
  el("wr-file-chip-name").textContent = "Stale mirror";
  el("identity-name").textContent = "Stale identity";
  noteServerUpdate(script("Arrived", "#73D4AC"));
  assert.equal(el("file-chip-name").textContent, "listening.txt");
  assertMirror();
  assert.equal(el("identity-name").textContent, "Rae");
  assert.equal(identityColour(), "#73D4AC");
  assert.equal(desktop._lastDocState.title, "Arrived");
  adoptReplacement(script("Replacement", "#F9B64F"));
  assert.equal(identityColour(), "#F9B64F");
  assert.equal(desktop._lastDocState.title, "Replacement");
});

test("location and connection owners refresh the file chips and desktop state synchronously", () => {
  open();
  amendHome(currentHome(), { dirty: true });
  assert.match(stateText(), /unsaved changes/);
  assertMirror();
  setHome("file", { format: "splitpage", handle: { _desktopId: "file-2" } });
  assert.equal(el("file-chip").hidden, true);
  assert.equal(desktop._lastDocState.fileId, "file-2");
  setHome("server", { id: "owner-change", rev: 4 });
  assert.match(stateText(), /v4/);
  assert.equal(desktop._lastDocState.serverKey, "owner-change");
  documentLocation().updateConnection({ role: "review", token: "review-token" });
  assert.equal(desktop._lastDocState.role, "review");
  assertMirror();
});

test("save coordinator status and autosave policy refresh the chips and desktop state synchronously", () => {
  open("server");
  noteSaveChange();
  assert.match(stateText(), /saving/);
  assert.equal(desktop._lastDocState.dirty, true);
  assertMirror();
  autoSavePolicy().halt("Paused");
  assert.match(stateText(), /not saved yet/);
  assertMirror();
  confirmSavedNow();
  assert.match(stateText(), /v3/);
  assert.equal(desktop._lastDocState.dirty, false);
  assertMirror();
});

test("identity listens to name and colour preferences, and desktop listens to a title command", () => {
  open();
  preferences().setCommentAuthor("Jo");
  assert.equal(el("identity-name").textContent, "Jo");
  preferences().setMyColor("#CBA1FA");
  assert.equal(identityColour(), "#CBA1FA");
  assert.equal(runCommand(titleCommand("Renamed")).kind, "applied");
  assert.equal(desktop._lastDocState.title, "Renamed");
});

test("opening the writer refreshes its file-chip mirror through the view owner", () => {
  open();
  el("wr-file-chip-name").textContent = "Stale";
  writer.openWriter();
  assertMirror();
  writer.closeWriter();
});

for (const surface of ["rows", "writer"]) {
  for (const kind of ["import", "server", "file"]) {
    test("typing in " + surface + " for a " + kind + " document keeps each display's synchronous refresh count per key", (t) => {
      open(kind);
      if (surface === "writer") writer.openWriter();
      const header = t.mock.method(el("file-chip-state").classList, "toggle");
      const mirror = t.mock.method(el("wr-file-chip-state").classList, "toggle");
      const identity = t.mock.method(el("identity-chip").classList, "toggle");
      const sent = t.mock.method(desktop, "setDocumentState");
      const cell = document.querySelector(surface === "writer"
        ? '#writer-doc .wr-para[data-id="r1"]'
        : '#rows .cell-editable[data-id="r1"][data-field="audioText"]');
      const chipCount = kind === "file" ? 0 : 1;
      let keys = 0;
      for (const ch of " typing") {
        typeChar(cell, ch);
        keys += 1;
        assert.deepEqual([
          header.mock.callCount(), mirror.mock.callCount(), identity.mock.callCount(), sent.mock.callCount()
        ], [keys * chipCount, keys * chipCount, 0, keys]);
      }
    });
  }
}

test("stopping and remounting the listeners releases subscriptions and registers each one once", (t) => {
  open();
  stopDocumentChromeFeature();
  t.after(mountDocumentChromeFeature);
  setHome("import", { name: "while-stopped.txt" });
  preferences().setCommentAuthor("While stopped");
  assert.equal(el("file-chip-name").textContent, "listening.txt");
  assert.equal(el("identity-name").textContent, "Rae");
  mountDocumentChromeFeature();
  mountDocumentChromeFeature();
  const header = t.mock.method(el("file-chip-state").classList, "toggle");
  const mirror = t.mock.method(el("wr-file-chip-state").classList, "toggle");
  amendHome(currentHome(), { dirty: true });
  assert.equal(header.mock.callCount(), 1);
  assert.equal(mirror.mock.callCount(), 1);
  assert.equal(el("file-chip-name").textContent, "while-stopped.txt");
  preferences().setCommentAuthor("Back");
  assert.equal(el("identity-name").textContent, "Back");
});

test("server status announcements refresh the readonly banner, link status and expired-session status", () => {
  open("server");
  serverStatus().recordMode({ readOnly: true });
  assert.equal(el("readonly-banner").hidden, false);
  serverStatus().turnLinkOff();
  assert.match(stateText(), /link turned off/);
  assertMirror();
  serverStatus().expireSession();
  assert.match(stateText(), /signed out/);
  assertMirror();
});
