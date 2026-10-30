import { test } from "node:test";
import assert from "node:assert/strict";
import { SAVE_DIRTY_LABEL, SAVE_LABEL, SAVING_LABEL, saveButtonView, saveStatus } from "../../src/application/save/status.ts";
import type { SaveStatusInput } from "../../src/application/save/status.ts";

const IDLE: SaveStatusInput = Object.freeze({
  busy: false, dirty: false, halted: "", autoSaveOn: true, target: "file", where: "a.md", homeKind: "file"
});

function lineOf(change: Partial<SaveStatusInput>): Record<string, unknown> | null {
  const line = saveStatus(Object.assign({}, IDLE, change)).line;
  return line ? { ...line } : null;
}

test("the three button labels are the words people see", () => {
  assert.equal(SAVE_LABEL, "Save");
  assert.equal(SAVE_DIRTY_LABEL, "Save •");
  assert.equal(SAVING_LABEL, "Saving…");
});

test("the status and its parts are frozen, whichever way the line goes", () => {
  [IDLE, Object.assign({}, IDLE, { busy: true }), Object.assign({}, IDLE, { dirty: true })].forEach(function (input) {
    const status = saveStatus(input);
    assert.equal(Object.isFrozen(status), true);
    assert.equal(Object.isFrozen(status.line), true);
    assert.equal(Object.isFrozen(status.button), true);
  });
  const empty = saveStatus(Object.assign({}, IDLE, { target: null, homeKind: "none", where: "" }));
  assert.equal(empty.line, null);
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(Object.isFrozen(saveButtonView({ busy: true, dirty: false })), true);
  assert.equal(Object.isFrozen(saveButtonView({ busy: false, dirty: true })), true);
});

test("the status line says saving first, with or without a place to name", () => {
  assert.deepEqual(lineOf({ busy: true }), { text: "Saving…", cls: "busy", title: "Writing your changes to a.md." });
  assert.deepEqual(lineOf({ busy: true, where: "" }), { text: "Saving…", cls: "busy", title: "Writing your changes." });
  assert.deepEqual(lineOf({ busy: true, halted: "Paused", dirty: true }), { text: "Saving…", cls: "busy", title: "Writing your changes to a.md." });
});

test("a halt shows its reason, ahead of every clean or dirty state", () => {
  assert.deepEqual(lineOf({ halted: "Disk full" }), { text: "Not saving", cls: "warn", title: "Disk full" });
  assert.deepEqual(lineOf({ halted: "Disk full", dirty: true }), { text: "Not saving", cls: "warn", title: "Disk full" });
});

test("a clean script says saved when anything says where it lives, and nothing only when nothing does", () => {
  const saved = { text: "Saved", cls: "ok", title: "" };
  assert.deepEqual(lineOf({}), { ...saved, where: "a.md" });
  assert.deepEqual(lineOf({ homeKind: "none", where: "" }), { ...saved, where: "" }, "an autosave target alone is enough");
  assert.deepEqual(lineOf({ target: null, where: "" }), { ...saved, where: "" }, "a file home alone is enough");
  assert.deepEqual(lineOf({ target: null, homeKind: "none" }), { ...saved, where: "a.md" }, "a place name alone is enough");
  assert.deepEqual(lineOf({ target: null, homeKind: "file", where: "" }), { ...saved, where: "" });
  assert.equal(lineOf({ target: null, homeKind: "none", where: "" }), null);
  assert.equal(lineOf({ target: null, homeKind: "folder", where: "" }), null);
});

test("an unsaved script explains what happens next in each of the three situations", () => {
  assert.deepEqual(lineOf({ dirty: true }), {
    text: "Unsaved changes", cls: "pending", title: "Autosave will write these to a.md a moment after you stop typing."
  });
  assert.deepEqual(lineOf({ dirty: true, autoSaveOn: false }), {
    text: "Unsaved changes", cls: "pending", title: "Autosave is off — press Save to write these to a.md."
  });
  assert.deepEqual(lineOf({ dirty: true, target: null }), {
    text: "Unsaved changes", cls: "pending", title: "Press Save to choose where this script is kept."
  });
  assert.deepEqual(lineOf({ dirty: true, target: null, autoSaveOn: false }), {
    text: "Unsaved changes", cls: "pending", title: "Press Save to choose where this script is kept."
  });
});
