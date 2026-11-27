import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement } from "../bootstrap/wiring/session-owner.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const shared = window.__sharedTest;
const peer = shared.nativePeer;
const audio = () => document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
const writer = () => document.querySelector('#writer-doc .wr-beat[data-id="r1"]');
const cue = text => `<span class="audio-cue">${text}</span>`;

async function enter(t, audioText, next = "Next beat") {
  adoptReplacement(migrateRows({ title: "Sound cues", paragraphsDecided: true,
    rows: [{ id: "r1", audioText }, { id: "r2", audioText: next }] }));
  assert.deepEqual(await shared.enter(), { ok: true });
  t.after(() => {
    writerControls().closeWriter();
    assert.deepEqual(shared.leave(), { ok: true });
  });
}

function type(target, data) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data });
  assert.equal(target.dispatchEvent(event), false);
}

function history(target, redo = false) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true, shiftKey: redo });
  assert.equal(target.dispatchEvent(event), false);
}

async function check(cell, expected) {
  window.dispatchEvent(new window.Event("pagehide"));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const { app, peer } = shared.read();
  assert.equal(app.rows[0].audioText, expected);
  assert.deepEqual(peer, app);
  assert.equal(cell().innerHTML.replace(/\u200b/g, ""), expected);
}

test("a cue at the end of Split Audio shares its mark and undoes separately from typing the prefix", async t => {
  await enter(t, "Lead<br>sf");
  audio().focus();
  setCellSelection(audio(), 7);
  type(audio(), "x");
  type(audio(), ":");
  await check(audio, "Lead<br>" + cue("sfx:"));
  assert.deepEqual(cellSelection(audio()), { from: 9, to: 9 });
  history(audio());
  await check(audio, "Lead<br>sfx:");
  assert.deepEqual(cellSelection(audio()), { from: 9, to: 9 });
  history(audio());
  await check(audio, "Lead<br>sf");
  history(audio(), true);
  await check(audio, "Lead<br>sfx:");
  history(audio(), true);
  await check(audio, "Lead<br>" + cue("sfx:"));
  type(audio(), " click");
  await check(audio, "Lead<br>" + cue("sfx: click"));
});

test("Split Audio marks the live middle line and both editors can undo and redo their own changes", async t => {
  await enter(t, "Lead<br>sf click<br>Next");
  audio().focus();
  setCellSelection(audio(), 7);
  type(audio(), "x");
  assert.equal(peer.type("r1", 13, "!").kind, "written");
  await Promise.resolve();
  type(audio(), ":");
  await check(audio, "Lead<br>" + cue("sfx: click!") + "<br>Next");
  assert.deepEqual(cellSelection(audio()), { from: 9, to: 9 });
  history(audio());
  await check(audio, "Lead<br>sfx: click!<br>Next");
  assert.equal(peer.undoPeer().kind, "written");
  await check(audio, "Lead<br>sfx: click<br>Next");
  assert.equal(peer.redoPeer().kind, "written");
  await check(audio, "Lead<br>sfx: click!<br>Next");
  history(audio(), true);
  await check(audio, "Lead<br>" + cue("sfx: click!") + "<br>Next");
});

test("a peer changing the line prefix while typing prevents conversion of the stale cue", async t => {
  await enter(t, "sf click");
  audio().focus();
  setCellSelection(audio(), 2);
  type(audio(), "x");
  assert.equal(peer.type("r1", 0, "A ").kind, "written");
  await Promise.resolve();
  type(audio(), ":");
  await check(audio, "A sfx: click");
  assert.deepEqual(cellSelection(audio()), { from: 6, to: 6 });
});

test("shared Writer narration creates and replays the same cue as Split Audio", async t => {
  await enter(t, "Music theme<br>Next");
  const controls = writerControls();
  controls.openWriter();
  controls.writerFlowControl().caret("r1", 5);
  type(writer(), ":");
  await check(writer, cue("Music: theme") + "<br>Next");
  history(writer());
  await check(writer, "Music: theme<br>Next");
  history(writer(), true);
  await check(writer, cue("Music: theme") + "<br>Next");
});

test("a cue in a joined beat formats and replays on its own line", async t => {
  await enter(t, "Lead", "Words<br>SFX tone");
  assert.equal(peer.join("r2", "r1").kind, "written");
  await check(audio, "Lead Words<br>SFX tone");
  audio().focus();
  setCellSelection(audio(), 14);
  type(audio(), ":");
  await check(audio, "Lead Words<br>" + cue("SFX: tone"));
  history(audio());
  await check(audio, "Lead Words<br>SFX: tone");
  history(audio(), true);
  await check(audio, "Lead Words<br>" + cue("SFX: tone"));
});

test("a peer can uncover the cue prefix while the preceding letter is buffered", async t => {
  await enter(t, "A sf click");
  audio().focus();
  setCellSelection(audio(), 4);
  type(audio(), "x");
  assert.equal(peer.delete("r1", 0, 2).kind, "written");
  await Promise.resolve();
  type(audio(), ":");
  await check(audio, cue("sfx: click"));
  assert.deepEqual(cellSelection(audio()), { from: 4, to: 4 });
});

test("retyping a cue colon records a formatting step even when the line used to be a cue", async t => {
  await enter(t, "SFX tone");
  audio().focus();
  setCellSelection(audio(), 3);
  type(audio(), ":");
  await check(audio, cue("SFX: tone"));
  setCellSelection(audio(), 3, 4);
  assert.equal(audio().dispatchEvent(new window.InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: "deleteContentBackward"
  })), false);
  await check(audio, "SFX tone");
  type(audio(), ":");
  await check(audio, cue("SFX: tone"));
  history(audio());
  await check(audio, "SFX: tone");
  history(audio(), true);
  await check(audio, cue("SFX: tone"));
});

test("a formatting boundary inside the prefix keeps the colon literal", async t => {
  await enter(t, "<strong>SF</strong>X tone");
  audio().focus();
  setCellSelection(audio(), 3);
  type(audio(), ":");
  await check(audio, "<strong>SF</strong>X: tone");
});
