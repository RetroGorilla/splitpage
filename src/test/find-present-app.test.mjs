import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument, liveSession } from "../bootstrap/wiring/session-owner.ts";
import { mountPrompterRuntimeFeature, prompterControls } from "../bootstrap/wiring/prompter.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { saveChanges, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
import { draftsTesting } from "../bootstrap/wiring/drafts.ts";

await bootApp();
after(closeApp);
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { openFindBar, closeFindBar, findQueryChanged, replaceAll, openBulkTag, runBulkTag } = await import("../features/find/find.ts");
const el = id => document.getElementById(id);
const key = (target, value, shiftKey = false) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }));

function load() {
  prompterControls().closePrompter();
  closeFindBar();
  loadTestDocument(migrateRows({ schema: 2, title: "Present find", rows: [
    { id: "r1", visualText: "visual secret", audioText: "First needle. A <strong>nee</strong>dle again." },
    { id: "r2", audioText: "Shot secret needle.", status: "shot" },
    { id: "r3", audioText: "Last needle." }
  ], comments: [{ id: "c1", rowId: "r1", field: "audioText", body: "comment secret", author: "Test" }] }));
}

function query(text) {
  el("find-input").value = text;
  findQueryChanged();
}

test("Present Find pauses, searches its projection, wraps, refuses mutations and returns focus before leaving Present", () => {
  load();
  const present = prompterControls();
  present.setSkipShot(true);
  present.openPrompter();
  present.setPrompterPlaying(true);
  const before = JSON.stringify(currentDocument());
  const generation = liveSession().generation();
  const undo = undoOwner().serial();
  const saves = saveChanges();
  const dirty = unsavedChanges();
  const drafts = draftsTesting().status();
  const content = el("prompter-content").innerHTML;
  assert.equal(currentDocument().comments[0].body, "comment secret");
  openFindBar();
  assert.equal(document.activeElement, el("find-input"));
  assert.equal(present.playing(), false);
  present.setPrompterPlaying(true);
  assert.equal(present.playing(), false);
  for (const text of ["visual secret", "comment secret", "Shot secret"]) {
    query(text);
    assert.equal(el("find-count").textContent, "No matches", text);
  }
  query("needle");
  assert.equal(el("find-count").textContent, "1 of 3");
  key(el("find-input"), "Enter");
  assert.equal(el("find-count").textContent, "2 of 3");
  key(el("find-input"), "Enter", true);
  assert.equal(el("find-count").textContent, "1 of 3");
  key(el("find-input"), "Enter", true);
  assert.equal(el("find-count").textContent, "3 of 3");
  el("replace-input").value = "changed";
  el("find-replace").click();
  replaceAll(); openBulkTag(); runBulkTag();
  assert.equal(el("find-tag-row").hidden, true);
  assert.equal(el("prompter-content").innerHTML, content);
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(liveSession().generation(), generation);
  assert.equal(undoOwner().serial(), undo);
  assert.equal(saveChanges(), saves);
  assert.equal(unsavedChanges(), dirty);
  assert.deepEqual(draftsTesting().status(), drafts);
  key(el("find-input"), "Escape");
  assert.equal(el("findbar").hidden, true);
  assert.equal(present.isOpen(), true);
  assert.equal(document.activeElement, el("pp-play"));
  assert.equal(present.playing(), false);
  present.setPrompterPlaying(true);
  assert.equal(present.playing(), true);
  key(el("pp-play"), "Escape");
  assert.equal(present.isOpen(), false);
});

test("Find changes scope on entering Present, refreshes after skip-shot rebuilds, and closes with Present", () => {
  load();
  const present = prompterControls();
  present.setSkipShot(false);
  openFindBar(); query("needle");
  assert.equal(el("find-count").textContent, "1 of 4");
  present.openPrompter();
  assert.equal(el("findbar").classList.contains("is-present"), true);
  assert.equal(document.activeElement, el("find-input"));
  el("pp-skip-shot").click();
  assert.equal(el("find-count").textContent, "1 of 3");
  present.closePrompter();
  assert.equal(el("findbar").hidden, true);
  openFindBar(); query("visual secret");
  assert.equal(el("find-count").textContent, "1 of 1");
  assert.equal(el("findbar").classList.contains("is-present"), false);
  closeFindBar();
});

test("Escape closes Find before Present after focus moves to a Present control", () => {
  load();
  const present = prompterControls();
  present.openPrompter();
  for (const id of ["pp-mirror", "pp-speed"]) {
    openFindBar();
    el(id).click();
    el(id).focus();
    key(el(id), "Escape");
    assert.equal(present.isOpen(), true, id);
    assert.equal(el("findbar").hidden, true, id);
    assert.equal(document.activeElement, el("pp-play"));
  }
  key(el("pp-play"), "Escape");
  assert.equal(present.isOpen(), false);
});

test("Present Find can jump through a script containing only visible stage directions in scene mode", () => {
  load();
  loadTestDocument(migrateRows({ schema: 2, rows: [{ id: "r1", audioText: '<span class="stage-dir">hold still</span>' }] }));
  const present = prompterControls();
  present.openPrompter();
  present.setPrompterSceneMode(true);
  assert.equal(document.querySelectorAll("#prompter-content .w").length, 0);
  openFindBar(); query("hold");
  assert.equal(el("find-count").textContent, "1 of 1");
  const errors = [];
  const onError = event => { errors.push(event.error); };
  window.addEventListener("error", onError);
  try { key(el("find-input"), "Enter"); }
  finally { window.removeEventListener("error", onError); }
  assert.deepEqual(errors, []);
  assert.equal(present.playing(), false);
  closeFindBar(); present.closePrompter();
  present.setPrompterSceneMode(false);
});

for (const method of ["disposeRuntime", "dispose"]) {
  test(method + " closes fullscreen Find and releases its accepted Escape lock", async () => {
    load();
    const present = prompterControls();
    present.openPrompter();
    const fullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    const keyboard = Object.getOwnPropertyDescriptor(window.navigator, "keyboard");
    const requests = [];
    let unlocks = 0;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
    Object.defineProperty(window.navigator, "keyboard", { configurable: true, value: {
      lock: keys => { requests.push(keys); return Promise.resolve(); },
      unlock: () => { unlocks++; }
    } });
    try {
      openFindBar();
      await Promise.resolve();
      assert.deepEqual(requests, [["Escape"]]);
      assert.equal(el("findbar").hidden, false);
      present[method]();
      assert.equal(unlocks, 1);
      assert.equal(el("findbar").hidden, true);
      assert.equal(present.closeFind(), false);
      present[method]();
      assert.equal(unlocks, 1);
    } finally {
      closeFindBar();
      if (fullscreen) Object.defineProperty(document, "fullscreenElement", fullscreen);
      else delete document.fullscreenElement;
      if (keyboard) Object.defineProperty(window.navigator, "keyboard", keyboard);
      else delete window.navigator.keyboard;
      mountPrompterRuntimeFeature();
      prompterControls().closePrompter();
    }
  });
}
