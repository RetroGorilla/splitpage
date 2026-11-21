import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { forceLeaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { posToDom } from "../features/common/cell-dom.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const splitCell = () => document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
const writerBeat = () => document.querySelector('#writer-doc .wr-beat[data-id="r1"]');
const writerRoot = () => document.getElementById("writer-doc");
const shown = cell => cell.textContent.replace(/\u200b/g, "").replace(/\u00a0/g, " ");

async function enterJoined(t, first, second) {
  adoptReplacement(migrateRows({ title: "Script", rows: [{ id: "r1", audioText: first }, { id: "r2", audioText: second }] }));
  assert.deepEqual(await hook.enter(), { ok: true });
  t.after(() => {
    if (!sharedSession() || hook.leave().ok) return;
    forceLeaveSharedSession();
    const allowed = () => ({ allowed: true });
    adoptReplacement(migrateRows({ title: "Standby", rows: [] }), createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
  });
  assert.equal(hook.nativePeer.join("r2", "r1").kind, "written");
  await Promise.resolve();
  return t.mock.method(notices, "show", () => {});
}

function openEditor(t, name) {
  if (name === "Split") {
    return {
      cell: splitCell,
      surface: splitCell,
      select(from, to = from) {
        splitCell().focus();
        setCellSelection(splitCell(), from, to);
      },
      selection() {
        assert.equal(document.activeElement, splitCell());
        const { from, to } = cellSelection(splitCell());
        return [from, to];
      }
    };
  }
  const controls = writerControls();
  controls.openWriter();
  t.after(controls.closeWriter);
  return {
    cell: writerBeat,
    surface: writerRoot,
    select(from, to = from) {
      writerRoot().focus();
      controls.writerFlowControl().place({
        anchor: { kind: "beat", rowId: "r1", offset: from },
        head: { kind: "beat", rowId: "r1", offset: to }
      });
      document.dispatchEvent(new window.Event("selectionchange"));
    },
    selection() {
      assert.equal(document.activeElement, writerRoot());
      const { anchor, head } = controls.writerFlowControl().selection();
      assert.deepEqual([anchor.rowId, head.rowId], ["r1", "r1"]);
      return [anchor.offset, head.offset];
    }
  };
}

function press(editor, key, ctrlKey = false) {
  return !editor.surface().dispatchEvent(new window.KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }));
}

function erase(editor, from, to, afterKeyDown = () => {}) {
  editor.select(from, to);
  const cell = editor.cell(), start = posToDom(cell, from), end = posToDom(cell, to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  if (press(editor, "Delete")) return;
  afterKeyDown();
  const inputType = "deleteContentForward";
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType });
  Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  if (!cell.dispatchEvent(event)) return;
  range.deleteContents();
  document.getSelection().collapse(range.startContainer, range.startOffset);
  cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType }));
}

function type(editor, data) {
  assert.equal(editor.surface().dispatchEvent(new window.InputEvent("beforeinput", {
    inputType: "insertText", data, bubbles: true, cancelable: true
  })), false);
}

async function expectText(editor, text) {
  await Promise.resolve();
  const { app, peer } = hook.read();
  assert.deepEqual(app.rows.map(row => row.audioText), [text]);
  assert.deepEqual(peer.rows.map(row => row.audioText), [text]);
  assert.equal(shown(editor.cell()), text);
}

for (const name of ["Writer", "Split"]) {
  for (const [description, first, second, from, to] of [
    ["Delete across a join", "abcd", "ef", 2, 6],
    ["Delete synthetic join space", "a ", " b", 2, 3]
  ]) {
    test(name + ": " + description + " leaves both copies and the editor usable", async t => {
      const warn = await enterJoined(t, first, second);
      const editor = openEditor(t, name);
      const joined = first + " " + second;
      const entered = first.slice(0, from) + "!" + first.slice(from) + " " + second;

      erase(editor, from, to);
      for (const key of ["z", "y", "z"]) {
        assert.equal(press(editor, key, true), true);
        await expectText(editor, joined);
        assert.deepEqual(editor.selection(), [from, to]);
      }
      assert.deepEqual(warn.mock.calls.map(call => call.arguments), [["This is not available in a shared session yet.", "warn"]]);

      editor.select(from);
      type(editor, "!");
      await delay(55);
      await expectText(editor, entered);
      assert.deepEqual(editor.selection(), [from + 1, from + 1]);
      assert.equal(press(editor, "z", true), true);
      await expectText(editor, joined);
      assert.deepEqual(editor.selection(), [from, from]);
      assert.equal(press(editor, "y", true), true);
      await expectText(editor, entered);
      assert.deepEqual(editor.selection(), [from + 1, from + 1]);
      assert.deepEqual(hook.leave(), { ok: true });
      assert.deepEqual(hook.read().app.rows.map(row => row.audioText), [entered]);
    });
  }

  for (const peerFirst of [false, true]) {
    test(name + ": refusing a joined deletion keeps peer typing delivered " + (peerFirst ? "before" : "after") + " beforeinput", async t => {
      const first = "abcd", second = "ef", added = "P";
      const warn = await enterJoined(t, first, second);
      const editor = openEditor(t, name);
      const peer = hook.nativePeer;
      peer.hold();
      const deliver = () => {
        assert.equal(peer.type("r2", 1, added).kind, "written");
        peer.deliver();
      };

      erase(editor, 2, first.length + 2, peerFirst ? deliver : undefined);
      if (!peerFirst) deliver();
      const text = first + " " + second.slice(0, 1) + added + second.slice(1);
      await expectText(editor, text);
      assert.deepEqual(warn.mock.calls.map(call => call.arguments), [["This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(hook.leave(), { ok: true });
      assert.deepEqual(hook.read().app.rows.map(row => row.audioText), [text]);
    });
  }
}
