import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();

const { updateFileChip } = await import("../js/18-local-files.js");
const { haltAutoSave, resumeAutoSave } = await import("../js/14-export.js");
const { saveToServer } = await import("../js/13-hosted.js");

after(closeApp);

const DOC_ID = "d" + "a".repeat(32);
const chip = () => document.getElementById("file-chip");
const stateText = () => document.getElementById("file-chip-state").textContent;
const warns = () => chip().hasAttribute("data-warning");

function onServer(rev) {
  window.__hostedTest.setSession({ docId: DOC_ID, rev });
  S.dirty = false;
  updateFileChip();
}

test("a server document that is up to date or saving is not a warning", () => {
  onServer(3);
  assert.equal(chip().hidden, false);
  assert.equal(stateText(), "· v3, everyone sees this");
  assert.equal(warns(), false);
  S.dirty = true;
  updateFileChip();
  assert.equal(stateText(), "· saving…");
  assert.equal(document.getElementById("file-chip-state").classList.contains("unsaved"), true);
  assert.equal(warns(), false, "saving is the normal state of an edit, so it keeps no space");
  S.dirty = false;
});

test("autosave halted with unsaved work is a warning, and clears when it resumes", () => {
  onServer(4);
  S.dirty = true;
  haltAutoSave("test");
  assert.equal(stateText(), "· not saved yet");
  assert.equal(warns(), true);
  resumeAutoSave();
  assert.equal(stateText(), "· saving…");
  assert.equal(warns(), false);
  S.dirty = false;
  updateFileChip();
  assert.equal(warns(), false);
});

test("a halt with nothing unsaved is not a warning", () => {
  onServer(5);
  haltAutoSave("test");
  assert.equal(stateText(), "· v5, everyone sees this");
  assert.equal(warns(), false);
  resumeAutoSave();
});

test("a chip that leaves the server loses the warning", () => {
  onServer(6);
  S.dirty = true;
  haltAutoSave("test");
  assert.equal(warns(), true);
  window.__hostedTest.setSession({ docId: null });
  S.dirty = false;
  resumeAutoSave();
  updateFileChip();
  assert.equal(chip().hidden, true);
  assert.equal(warns(), false);
});

test("a refused sign-in is a warning (last: the flag has no reset)", async () => {
  onServer(7);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 401,
    ok: false,
    redirected: false,
    headers: { get: () => "application/json" },
    json: async () => ({ error: "sign in" })
  });
  try {
    S.dirty = true;
    await saveToServer();
  } finally {
    globalThis.fetch = realFetch;
  }
  updateFileChip();
  assert.equal(stateText(), "· signed out — reload");
  assert.equal(warns(), true);
});
