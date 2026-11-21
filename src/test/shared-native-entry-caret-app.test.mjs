import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml, scriptCellOf } from "../bootstrap/richtext.ts";
import { draftsTesting } from "../bootstrap/wiring/drafts.ts";
import { flushDraftNow } from "../bootstrap/wiring/recovery-owners.ts";
import { adoptReplacement, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { forceLeaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { beatPos } from "../core/flow/flow.ts";
import { domToPos, posToDom } from "../features/common/cell-dom.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const rows = [{ id: "r1", audioText: "Hello there" }, { id: "r2", audioText: "World again" }];
const success = { ok: true };
const writerRoot = () => document.getElementById("writer-doc");
const flow = () => writerControls().writerFlowControl();
const narration = (writer, id) => document.querySelector(writer
  ? `#writer-doc .wr-beat[data-id="${id}"]`
  : `#rows .cell-editable[data-field="audioText"][data-id="${id}"]`);
const project = (beats = rows) => migrateRows({
  schema: 2, title: "Caret round trip", paragraphsDecided: true, rows: structuredClone(beats)
});

function start(t, writer) {
  t.after(() => {
    if (sharedSession()) forceLeaveSharedSession();
    writerControls().closeWriter();
    document.activeElement.blur?.();
  });
  adoptReplacement(project());
  if (writer) writerControls().openWriter();
}

function place(writer, anchor, head) {
  if (writer) {
    flow().place({ anchor, head });
    return;
  }
  const a = posToDom(narration(false, anchor.rowId), anchor.offset);
  const h = posToDom(narration(false, head.rowId), head.offset);
  narration(false, anchor.rowId).focus();
  document.getSelection().setBaseAndExtent(a.node, a.offset, h.node, h.offset);
}

function check(writer, anchor, head) {
  assert.equal(document.activeElement, writer ? writerRoot() : narration(false, anchor.rowId), "editing host has focus");
  if (writer) {
    assert.deepEqual(flow().selection(), { anchor, head });
  } else {
    const selection = document.getSelection();
    assert.equal(domToPos(narration(false, anchor.rowId), selection.anchorNode, selection.anchorOffset), anchor.offset);
    assert.equal(domToPos(narration(false, head.rowId), selection.focusNode, selection.focusOffset), head.offset);
  }
}

function typeNative(text) {
  const input = new window.InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: "insertText", data: text
  });
  document.activeElement.dispatchEvent(input);
  assert.equal(input.defaultPrevented, true);
}

function stored(beats) {
  const document = project(beats);
  const native = openNativeSession({ kind: "document", document, conversion: {
    cells: scriptCellOf, creation: document.docId, at: "2026-11-20", by: "Editor"
  } }, { actor: "Editor", sanitize: sanitizeHtml });
  try { return native.encodeState(); } finally { native.close(); }
}

for (const writer of [true, false]) {
  const surface = writer ? "Writer" : "Split";
  for (const [name, anchor, head] of [
    ["caret", beatPos("r1", 5), beatPos("r1", 5)],
    ["backward range", beatPos("r1", 5), beatPos("r1", 2)],
    ["cross-beat range", beatPos("r1", 3), beatPos("r2", 4)]
  ]) {
    test(`${surface} keeps the ${name} on native entry`, async t => {
      start(t, writer);
      place(writer, anchor, head);
      assert.deepEqual(await hook.enter(), success);
      check(writer, anchor, head);
    });
    test(`${surface} keeps the ${name} on native leave`, async t => {
      start(t, writer);
      assert.deepEqual(await hook.enter(), success);
      place(writer, anchor, head);
      assert.deepEqual(hook.leave(), success);
      check(writer, anchor, head);
    });
  }

  test(`${surface} restores both ends of a cross-beat range on a changed paint`, async t => {
    start(t, writer);
    const anchor = beatPos("r2", 4), head = beatPos("r1", 3);
    place(writer, anchor, head);
    const oldText = narration(writer, "r1").firstChild;
    const changed = rows.map(row => ({ ...row, audioText: row.audioText + "!" }));
    assert.deepEqual(await hook.enterFrom(stored(changed)), success);
    assert.notEqual(narration(writer, "r1").firstChild, oldText);
    check(writer, anchor, head);
  });

  test(`${surface} places the caret at the end of the first beat when the selected beat is absent`, async t => {
    start(t, writer);
    place(writer, beatPos("r1", 2), beatPos("r1", 5));
    assert.deepEqual(await hook.enterFrom(stored([rows[1]])), success);
    const end = beatPos("r2", rows[1].audioText.length);
    check(writer, end, end);
    typeNative("!");
    assert.deepEqual(hook.leave(), success);
    assert.equal(hook.read().app.rows[0].audioText, "World again!");
  });

  test(`${surface} restores focus when a peer removes the selected beat just before leave`, async t => {
    start(t, writer);
    assert.deepEqual(await hook.enter(), success);
    place(writer, beatPos("r1", 2), beatPos("r2", 5));
    assert.equal(hook.nativePeer.removeBeat("r1").kind, "written");
    assert.deepEqual(hook.leave(), success);
    const end = beatPos("r2", rows[1].audioText.length);
    check(writer, end, end);
  });

  test(`${surface} flushes pending standalone typing on entry and keeps the caret after it`, async t => {
    const writes = [];
    useDesktopForTest({
      writeDraft: async payload => {
        writes.push({ text: JSON.parse(payload.stateJson).rows[0].audioText, shared: sharedSession() });
        return { ok: true, seq: payload.seq };
      },
      discardDraft: async () => ({ ok: true }),
      setDocumentState: () => {}
    });
    start(t, writer);
    t.after(async () => {
      try { await flushDraftNow(); } finally { restoreDesktop(); }
    });
    const initial = beatPos("r1", 5);
    place(writer, initial, initial);
    assert.equal(narration(writer, "r1").textContent, "Hello there");
    const { node, offset } = posToDom(narration(writer, "r1"), initial.offset);
    node.insertData(offset, "!");
    document.getSelection().collapse(node, offset + 1);
    document.activeElement.dispatchEvent(new window.InputEvent("input", {
      bubbles: true, inputType: "insertText", data: "!"
    }));
    assert.equal(draftsTesting().status().pending, true);
    assert.deepEqual(writes, []);
    assert.deepEqual(await hook.enter(), success);
    assert.deepEqual(writes, [{ text: "Hello! there", shared: false }]);
    assert.equal(hook.read().peer.rows[0].audioText, "Hello! there");
    const afterTyping = beatPos("r1", 6);
    check(writer, afterTyping, afterTyping);
    typeNative("?");
    assert.deepEqual(hook.leave(), success);
    assert.equal(hook.read().app.rows[0].audioText, "Hello!? there");
    const afterLeave = beatPos("r1", 7);
    check(writer, afterLeave, afterLeave);
  });
}
