import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml, scriptCellOf } from "../bootstrap/richtext.ts";
import { adoptReplacement, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { forceLeaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { beatPos } from "../core/flow/flow.ts";
import { domToPos, posToDom } from "../features/common/cell-dom.ts";

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
const project = (beats = rows) => migrateRows({ schema: 2, title: "Caret round trip", paragraphsDecided: true, rows: beats });

function start(t, writer) {
  t.after(() => {
    if (sharedSession()) forceLeaveSharedSession();
    writerControls().closeWriter();
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
  narration(false, head.rowId).focus();
  document.getSelection().setBaseAndExtent(a.node, a.offset, h.node, h.offset);
}

function check(writer, anchor, head) {
  assert.equal(document.activeElement, writer ? writerRoot() : narration(false, head.rowId), "editing host has focus");
  if (writer) {
    assert.deepEqual(flow().selection(), { anchor, head });
  } else {
    const selection = document.getSelection();
    assert.equal(domToPos(narration(false, anchor.rowId), selection.anchorNode, selection.anchorOffset), anchor.offset);
    assert.equal(domToPos(narration(false, head.rowId), selection.focusNode, selection.focusOffset), head.offset);
  }
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

  test(`${surface} places the caret at the end of the first beat when the selected beat is absent`, async t => {
    start(t, writer);
    place(writer, beatPos("r1", 2), beatPos("r1", 5));
    assert.deepEqual(await hook.enterFrom(stored([rows[1]])), success);
    const end = beatPos("r2", rows[1].audioText.length);
    check(writer, end, end);
    const input = new window.InputEvent("beforeinput", {
      bubbles: true, cancelable: true, inputType: "insertText", data: "!"
    });
    document.activeElement.dispatchEvent(input);
    assert.equal(input.defaultPrevented, true);
    assert.deepEqual(hook.leave(), success);
    assert.equal(hook.read().app.rows[0].audioText, "World again!");
  });
}
