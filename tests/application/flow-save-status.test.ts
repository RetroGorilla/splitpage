import { test } from "node:test";
import assert from "node:assert/strict";
import { flowSaveStatus } from "../../src/application/save/status.ts";
import type { SaveStatusInput } from "../../src/application/save/status.ts";

const saved: SaveStatusInput = { busy: false, dirty: false, halted: "", autoSaveOn: true, target: "file", where: "Script.splitpage", homeKind: "file" };

test("flow save status is quiet for saved, autosaving and busy files", () => {
  assert.deepEqual(flowSaveStatus(saved), { text: "Saved", actionable: false, problem: false });
  assert.deepEqual(flowSaveStatus({ ...saved, dirty: true }), { text: "Unsaved changes", actionable: false, problem: false });
  assert.deepEqual(flowSaveStatus({ ...saved, busy: true }), { text: "Saving…", actionable: false, problem: false });
});

test("flow save status offers a destination even for an untouched new script", () => {
  assert.deepEqual(flowSaveStatus({ ...saved, homeKind: "none", target: null, where: "" }), { text: "Not saved yet", actionable: true, problem: false });
});

test("flow save status calls out Autosave off even when the file is clean", () => {
  assert.deepEqual(flowSaveStatus({ ...saved, autoSaveOn: false }), { text: "Autosave off", actionable: true, problem: false });
});

test("flow save status makes a save problem actionable until a retry is running", () => {
  assert.deepEqual(flowSaveStatus({ ...saved, halted: "Access denied" }), { text: "Not saving", actionable: true, problem: true });
  assert.deepEqual(flowSaveStatus({ ...saved, halted: "Access denied", busy: true }), { text: "Saving…", actionable: false, problem: false });
});
