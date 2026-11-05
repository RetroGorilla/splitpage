import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();

const { mountWriterRuntimeFeature, stopWriterRuntimeFeature, writerControls } = await import("../bootstrap/wiring/writer.ts");
const { adoptReplacement, currentDocument, onRefresh } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const flushEdits = () => undoOwner().flush();
const breakUndoCoalescing = () => undoOwner().breakCoalescing();
const { viewFlags } = await import("../bootstrap/wiring/preferences-owner.ts");
const { appActions } = await import("../bootstrap/wiring/ports/actions.ts");

after(closeApp);

function type(cell, character) {
  (cell.matches(".wr-beat") ? document.getElementById("writer-doc") : cell).focus();
  const node = cell.firstChild;
  node.data += character;
  const range = document.createRange();
  range.setStart(node, node.data.length);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: character }));
  flushEdits();
}

function key(cell, name, modifiers = {}) {
  (cell.matches(".wr-beat") ? document.getElementById("writer-doc") : cell).focus();
  const event = new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...modifiers });
  cell.dispatchEvent(event);
  return event;
}

test("stopping Writer disconnects main-editor stats and undo, and remount reconnects every retained control", async () => {
  adoptReplacement(migrateRows({ title: "Writer lifecycle", rows: [{ id: "r1", audioText: "Hello", visualText: "", status: "todo" }] }));
  flushEdits();
  breakUndoCoalescing();
  const errors = [];
  const capture = (event) => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener("error", capture);
  let unhear = () => {};
  try {
    writerControls().openWriter();
    const previousSize = document.getElementById("wr-size").value;
    writerControls().scheduleWriterStats();
    stopWriterRuntimeFeature();
    assert.equal(viewFlags().writerOpen(), false);
    const refreshed = new Promise(resolve => { unhear = onRefresh(resolve); });
    const main = document.querySelector('#rows .cell-editable[data-field="audioText"]');
    type(main, "X");
    assert.equal(currentDocument().rows[0].audioText, "HelloX");
    assert.deepEqual(errors, [], "main-editor typing completes after Writer stops");
    const jobs = await refreshed;
    unhear();
    assert.equal(jobs.has("writerStats"), false);
    assert.equal(key(main, "z", { ctrlKey: true }).defaultPrevented, true);
    assert.equal(currentDocument().rows[0].audioText, "Hello");
    key(document.querySelector('#rows .cell-editable[data-field="audioText"]'), "z", { ctrlKey: true, shiftKey: true });
    assert.equal(currentDocument().rows[0].audioText, "HelloX");
    assert.equal(appActions.view("write", "command-menu").enabled, false);
    assert.equal(appActions.invoke("write", "button").kind, "unavailable");
    window.__settingsTest.open();
    assert.equal(document.querySelector("#settings-writer-size").value, previousSize);
    window.__settingsTest.close();
    assert.equal((await window.__appDataTest.build()).format, "splitpage-app-data");

    const first = mountWriterRuntimeFeature();
    const second = mountWriterRuntimeFeature();
    first.dispose();
    assert.equal(appActions.view("write", "command-menu").enabled, true, JSON.stringify({ view: appActions.view("write", "command-menu"), dialogs: Array.from(document.querySelectorAll(".modal-backdrop:not([hidden])"), el => el.id) }));
    assert.equal(appActions.invoke("write", "button").kind, "ran");
    assert.equal(viewFlags().writerOpen(), true);
    const paragraph = document.querySelector("#writer-doc .wr-beat");
    type(paragraph, "Y");
    assert.equal(currentDocument().rows[0].audioText, "HelloXY");
    key(paragraph, "Enter");
    assert.equal(currentDocument().rows.length, 2);
    key(document.querySelectorAll("#writer-doc .wr-beat")[1], "z", { ctrlKey: true });
    assert.equal(currentDocument().rows.length, 1);
    assert.equal(viewFlags().writerOpen(), true);
    const size = document.getElementById("wr-size");
    size.value = "24";
    size.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(document.getElementById("writer").style.getPropertyValue("--wr-font"), "24px");
    document.getElementById("wr-close").click();
    assert.equal(viewFlags().writerOpen(), false);
    appActions.invoke("write", "button");
    key(document.querySelector("#writer-doc .wr-beat"), "Escape");
    assert.equal(viewFlags().writerOpen(), false);
    appActions.invoke("write", "button");
    document.getElementById("wr-close").click();
    assert.equal(viewFlags().writerOpen(), false);
    window.__settingsTest.open();
    const settingSize = document.getElementById("settings-writer-size");
    settingSize.value = "26";
    settingSize.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(document.getElementById("writer").style.getPropertyValue("--wr-font"), "26px");
    window.__settingsTest.close();
    second.dispose();
    assert.equal(appActions.view("write", "command-menu").enabled, false);
    mountWriterRuntimeFeature();
    assert.equal(appActions.view("write", "command-menu").enabled, true);
    assert.deepEqual(errors, []);
  } finally {
    unhear();
    window.removeEventListener("error", capture);
    mountWriterRuntimeFeature();
  }
});
