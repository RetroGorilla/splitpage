import { test } from "node:test";
import assert from "node:assert/strict";
import { SAVE_DIRTY_LABEL, SAVE_LABEL, SAVING_LABEL, saveButtonView, saveStatus } from "../../src/application/save/status.ts";
import type { SaveStatusInput } from "../../src/application/save/status.ts";
import { autoSaveMay, autoSaveWhere } from "../../src/application/save/autosave.ts";

const IDLE: SaveStatusInput = Object.freeze({
  busy: false, dirty: false, halted: "", autoSaveOn: true, target: "file", where: "a.md",
  homeKind: "file", onServer: false, signedOut: false, linkOff: false
});

function at(change: Partial<SaveStatusInput>): SaveStatusInput {
  return Object.assign({}, IDLE, change);
}

test("INV-20: the Save buttons render one view: busy wins, then dirty, and only a busy save disables them", () => {
  assert.deepEqual({ ...saveButtonView({ busy: true, dirty: true }) }, { label: SAVING_LABEL, dirty: false, disabled: true });
  assert.deepEqual({ ...saveButtonView({ busy: false, dirty: true }) }, { label: SAVE_DIRTY_LABEL, dirty: true, disabled: false });
  assert.deepEqual({ ...saveButtonView({ busy: false, dirty: false }) }, { label: SAVE_LABEL, dirty: false, disabled: false });
  assert.deepEqual(saveStatus(at({ busy: true })).button, saveButtonView({ busy: true, dirty: false }));
});

test("the status line for each state, in today's words", () => {
  assert.equal(saveStatus(at({ onServer: true, signedOut: true, busy: true })).line?.text, "Not saving");
  assert.equal(saveStatus(at({ onServer: true, linkOff: true })).line?.cls, "warn");
  assert.deepEqual({ ...saveStatus(at({ busy: true })).line }, { text: "Saving…", cls: "busy", title: "Writing your changes to a.md." });
  assert.deepEqual({ ...saveStatus(at({ halted: "Autosave is paused" })).line }, { text: "Not saving", cls: "warn", title: "Autosave is paused" });
  assert.deepEqual({ ...saveStatus(IDLE).line }, { text: "Saved", cls: "ok", title: "", where: "a.md" });
  assert.equal(saveStatus(at({ target: null, homeKind: "none", where: "" })).line, null, "nothing to say about an unsaved-anywhere clean script");
  assert.match(saveStatus(at({ dirty: true })).line?.title || "", /^Autosave will write these to a\.md/);
  assert.match(saveStatus(at({ dirty: true, autoSaveOn: false })).line?.title || "", /^Autosave is off/);
  assert.match(saveStatus(at({ dirty: true, target: null })).line?.title || "", /choose where this script is kept/);
});

test("INV-51 where: autosave writes only to a picked handle or the server, never an .html file, and nowhere once signed out or the link is off", () => {
  const file = { handle: {}, format: "md" };
  assert.equal(autoSaveWhere({ onServer: false, signedOut: false, linkOff: false, file: file }), "file");
  assert.equal(autoSaveWhere({ onServer: false, signedOut: false, linkOff: false, file: { handle: null, format: "md" } }), null);
  assert.equal(autoSaveWhere({ onServer: false, signedOut: false, linkOff: false, file: { handle: {}, format: "html" } }), null);
  assert.equal(autoSaveWhere({ onServer: false, signedOut: false, linkOff: false, file: null }), null);
  assert.equal(autoSaveWhere({ onServer: true, signedOut: false, linkOff: false, file: null }), "server");
  assert.equal(autoSaveWhere({ onServer: true, signedOut: false, linkOff: true, file: null }), null);
  assert.equal(autoSaveWhere({ onServer: false, signedOut: true, linkOff: false, file: file }), null);
});

test("INV-51 when: only while on, never while halted, never without a target", () => {
  assert.equal(autoSaveMay({ on: true, halted: "", target: "file" }), true);
  assert.equal(autoSaveMay({ on: false, halted: "", target: "file" }), false);
  assert.equal(autoSaveMay({ on: true, halted: "Autosave is paused", target: "server" }), false);
  assert.equal(autoSaveMay({ on: true, halted: "", target: null }), false);
});
