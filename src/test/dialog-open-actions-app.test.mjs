import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { appActions } = await import("../legacy/app-actions.ts");
const { migrateRows } = await import("../js/02-state.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { closeGdocModal } = await import("../js/11-import.js");
const { preferences } = await import("../legacy/preferences-bridge.ts");
const { closeSettings, settingsOpen } = await import("../js/20s-settings.js");
const { fileMenuOpen, toggleFileMenu } = await import("../js/18b-file-menu.js");
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

test("the guest-name prompt, closing the file menu and the servers and Google Docs openers are actions no menu lists", () => {
  for (const id of ["ask-guest-name", "close-file-menu", "show-servers-dialog", "show-gdoc-import"]) {
    assert.equal(appActions.view(id).visible, false, id);
    assert.equal(appActions.view(id).enabled, true, id);
  }
});

test("running servers opens the servers dialog", () => {
  open();
  try {
    assert.equal(appActions.invoke("servers", "button").kind, "ran");
    assert.equal(el("connect-modal").hidden, false);
  } finally {
    el("connect-modal").querySelector(".modal-close").click();
  }
});

test("show-servers-dialog opens the servers dialog over an open dialog, where servers refuses", () => {
  open();
  try {
    assert.equal(appActions.invoke("gdoc-import", "button").kind, "ran");
    assert.notEqual(appActions.invoke("servers", "button").kind, "ran");
    assert.equal(el("connect-modal").hidden, true);
    assert.equal(appActions.invoke("show-servers-dialog", "button").kind, "ran");
    assert.equal(el("connect-modal").hidden, false);
  } finally {
    el("connect-modal").querySelector(".modal-close").click();
    closeGdocModal();
  }
});

test("running settings with a field to focus opens settings on that field, and a menu opens it plainly", () => {
  open();
  try {
    assert.equal(appActions.invoke("settings", "button", { focus: "settings-collab-server" }).kind, "ran");
    assert.equal(settingsOpen(), true);
    assert.equal(document.activeElement, el("settings-collab-server"));
  } finally {
    closeSettings();
  }
  try {
    assert.equal(appActions.invoke("settings", "menu").kind, "ran");
    assert.equal(settingsOpen(), true);
    assert.notEqual(document.activeElement, el("settings-collab-server"));
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
    assert.equal(appActions.invoke("servers", "button").kind, "ran");
    assert.notEqual(appActions.invoke("gdoc-import", "button").kind, "ran");
    assert.equal(el("gdoc-modal").hidden, true);
    assert.equal(appActions.invoke("show-gdoc-import", "button").kind, "ran");
    assert.equal(el("gdoc-modal").hidden, false);
  } finally {
    closeGdocModal();
    el("connect-modal").querySelector(".modal-close").click();
  }
});

test("running ask-guest-name asks a guest with no saved name once per session", () => {
  open();
  preferences().setCommentAuthor("");
  sessionStorage.removeItem("splitpage-guest-asked");
  assert.equal(appActions.invoke("ask-guest-name", "button").kind, "ran");
  assert.equal(el("guest-modal").hidden, false);
  el("guest-modal").hidden = true;
  appActions.invoke("ask-guest-name", "button");
  assert.equal(el("guest-modal").hidden, true, "asked once per session");
});

test("running close-file-menu closes the open file menu", () => {
  open();
  toggleFileMenu(true);
  assert.equal(fileMenuOpen(), true);
  assert.equal(appActions.invoke("close-file-menu", "button").kind, "ran");
  assert.equal(fileMenuOpen(), false);
});
