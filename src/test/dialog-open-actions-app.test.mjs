import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();

const { appActions } = await import("../legacy/app-actions.ts");
const { migrateRows } = await import("../legacy/document-ports.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const flushEdits = () => undoOwner().flush();
const { closeGdocModal } = (await import("../bootstrap/wiring/imports.ts")).importControls();
const { closeSettings, settingsOpen } = await import("../features/settings/settings.js");
const { fileMenuOpen, toggleFileMenu } = await import("../bootstrap/wiring/file-menu-controls.ts");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const el = (id) => document.getElementById(id);

function open() {
  loadTestDocument(migrateRows({
    title: "Dialogs",
    docId: "d" + "f".repeat(32),
    rows: [{ id: "r1", visualText: "Wide", audioText: "One two.", status: "todo" }]
  }));
  flushEdits();
}

test("closing the file menu and the Google Docs opener are actions no menu lists", () => {
  for (const id of ["close-file-menu", "show-gdoc-import"]) {
    assert.equal(appActions.view(id).visible, false, id);
    assert.equal(appActions.view(id).enabled, true, id);
  }
});

test("running settings with a field to focus opens settings on that field, and a menu opens it plainly", () => {
  open();
  try {
    assert.equal(appActions.invoke("settings", "button", { focus: "settings-name" }).kind, "ran");
    assert.equal(settingsOpen(), true);
    assert.equal(document.activeElement, el("settings-name"));
  } finally {
    closeSettings();
  }
  try {
    assert.equal(appActions.invoke("settings", "menu").kind, "ran");
    assert.equal(settingsOpen(), true);
    assert.notEqual(document.activeElement, el("settings-name"));
  } finally {
    closeSettings();
  }
});

test("running gdoc-import opens the Google Docs import", () => {
  open();
  try {
    assert.equal(appActions.invoke("gdoc-import", "button").kind, "ran");
    assert.equal(el("gdoc-modal").hidden, false);
  } finally {
    closeGdocModal();
  }
});

test("show-gdoc-import opens the Google Docs import over an open dialog, where gdoc-import refuses", () => {
  open();
  try {
    assert.equal(appActions.invoke("settings", "button").kind, "ran");
    assert.notEqual(appActions.invoke("gdoc-import", "button").kind, "ran");
    assert.equal(el("gdoc-modal").hidden, true);
    assert.equal(appActions.invoke("show-gdoc-import", "button").kind, "ran");
    assert.equal(el("gdoc-modal").hidden, false);
  } finally {
    closeGdocModal();
    closeSettings();
  }
});

test("running close-file-menu closes the open file menu", () => {
  open();
  toggleFileMenu(true);
  assert.equal(fileMenuOpen(), true);
  assert.equal(appActions.invoke("close-file-menu", "button").kind, "ran");
  assert.equal(fileMenuOpen(), false);
});
