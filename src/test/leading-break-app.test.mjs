import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { render } = await import("../js/05-render.js");
const { registryKey } = await import("../core/document/tags.ts");
const { openProductionPanel, closeProductionPanel } = await import("../js/08-production-panels.js");
const { closeBrollPage, closeBrollPanel, openBrollPage, openBrollPanel } = await import("../js/08d-broll-panel.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = function () {};

const LEAD = "\nSecond line first.";

function load() {
  loadTestDocument(migrateRows({
    schema: 2, title: "Breaks",
    rows: [{ id: "r1", status: "todo", audioText: "the mug", visualText: "" }],
    comments: [], people: [],
    productionTags: [{ cat: "prop", name: "Kettle", notes: LEAD }],
    brollShots: [{ id: "bs1", name: "Harbour wide", origin: "list", notes: LEAD, audioRef: LEAD }]
  }));
  render();
  clearDirty();
}

function shot() { return S.state.brollShots[0]; }

function typeInto(box, value) {
  box.value = value;
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

function leave(close) {
  const active = document.activeElement;
  if (active && active !== document.body) active.blur();
  close();
}

test("the model keeps a leading line break in a note, a reference and a tag's notes", () => {
  load();
  assert.equal(shot().notes, LEAD);
  assert.equal(shot().audioRef, LEAD);
  assert.equal(S.state.productionTags[0].notes, LEAD);
});

test("the b-roll panel's note and reference boxes show a leading line break", () => {
  load();
  const panel = document.getElementById("broll-panel");
  try {
    openBrollPanel();
    if (!panel.querySelector('.broll-card[data-id="bs1"]')) panel.querySelector('.broll-row-main[data-id="bs1"]').click();
    const note = panel.querySelector('.broll-notes-input[data-id="bs1"]');
    assert.equal(note.value, LEAD);
    assert.equal(note.defaultValue, LEAD);
    panel.querySelector('[data-action="broll-ref-edit"][data-id="bs1"]').click();
    const ref = panel.querySelector('.broll-ref-input[data-id="bs1"]');
    assert.equal(ref.value, LEAD);
    assert.equal(ref.defaultValue, LEAD);
  } finally {
    leave(closeBrollPanel);
  }
});

test("editing the b-roll panel's note after it shows a leading line break keeps the line break", () => {
  load();
  const panel = document.getElementById("broll-panel");
  try {
    openBrollPanel();
    if (!panel.querySelector('.broll-card[data-id="bs1"]')) panel.querySelector('.broll-row-main[data-id="bs1"]').click();
    const note = panel.querySelector('.broll-notes-input[data-id="bs1"]');
    note.focus();
    typeInto(note, note.value + " More.");
    note.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    assert.equal(shot().notes, LEAD + " More.");
  } finally {
    leave(closeBrollPanel);
  }
});

test("the b-roll page note box shows a leading line break and keeps it on edit", () => {
  load();
  try {
    openBrollPage();
    const box = document.querySelector('#broll-page .broll-page-note[data-id="bs1"]');
    assert.equal(box.value, LEAD);
    assert.equal(box.defaultValue, LEAD);
    box.focus();
    typeInto(box, box.value + " More.");
    box.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    assert.equal(shot().notes, LEAD + " More.");
  } finally {
    leave(closeBrollPage);
  }
});

test("a tag's notes box shows a leading line break and keeps it on edit", () => {
  load();
  try {
    openProductionPanel();
    document.querySelector('#production-panel [data-action="tag-expand"].tag-entity-head').click();
    const box = document.querySelector("#production-panel .tag-notes-input");
    assert.ok(box, "the notes box shows");
    assert.equal(box.value, LEAD);
    box.focus();
    typeInto(box, box.value + " More.");
    assert.equal(S.state.productionTags[0].notes, LEAD + " More.");
    assert.equal(registryKey("prop", "Kettle"), box.getAttribute("data-key"));
  } finally {
    leave(closeProductionPanel);
  }
});
