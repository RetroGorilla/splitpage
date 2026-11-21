import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml, scriptCellOf } from "../bootstrap/richtext.ts";
import { draftsTesting } from "../bootstrap/wiring/drafts.ts";
import { flushDraftNow } from "../bootstrap/wiring/recovery-owners.ts";
import { adoptReplacement, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { forceLeaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { beatPos, headingPos } from "../core/flow/flow.ts";
import { domToPos, posToDom, readSelection } from "../features/common/cell-dom.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const rows = [{ id: "r1", audioText: "Hello there", visualText: "Look again" }, { id: "r2", audioText: "World again" }];
const success = { ok: true };
const writerRoot = () => document.getElementById("writer-doc");
const flow = () => writerControls().writerFlowControl();
const narration = (writer, id) => document.querySelector(writer
  ? `#writer-doc .wr-beat[data-id="${id}"]`
  : `#rows .cell-editable[data-field="audioText"][data-id="${id}"]`);
const project = (beats = rows, sections = []) => migrateRows({
  schema: 2, title: "Caret round trip", paragraphsDecided: true, rows: structuredClone(beats), sections
});

function start(t, writer, doc = project()) {
  t.after(() => {
    if (sharedSession()) forceLeaveSharedSession();
    writerControls().closeWriter();
    document.activeElement.blur?.();
  });
  adoptReplacement(doc);
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

function stored(beats, change = () => {}) {
  const document = project(beats);
  const native = openNativeSession({ kind: "document", document, conversion: {
    cells: scriptCellOf, creation: document.docId, at: "2026-11-20", by: "Editor"
  } }, { actor: "Editor", sanitize: sanitizeHtml });
  try { change(native); return native.encodeState(); } finally { native.close(); }
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
    const changed = rows.map(row => ({ ...row, audioText: "<strong>" + row.audioText + "</strong>" }));
    assert.deepEqual(await hook.enterFrom(stored(changed)), success);
    assert.notEqual(narration(writer, "r1").firstChild, oldText);
    check(writer, anchor, head);
  });

  test(`${surface} does not select different text after an insertion before the range`, async t => {
    start(t, writer);
    place(writer, beatPos("r1", 0), beatPos("r1", 5));
    const changed = [{ ...rows[0], audioText: "New Hello there" }, rows[1]];
    assert.deepEqual(await hook.enterFrom(stored(changed)), success);
    const end = beatPos("r1", changed[0].audioText.length);
    check(writer, end, end);
    typeNative("!");
    assert.deepEqual(hook.leave(), success);
    assert.equal(hook.read().app.rows[0].audioText, "New Hello there!");
  });

  test(`${surface} does not select newly inserted text between unchanged endpoints`, async t => {
    start(t, writer);
    place(writer, beatPos("r1", 6), beatPos("r2", 5));
    const changed = [rows[0], { id: "inserted", audioText: "Added beat" }, rows[1]];
    assert.deepEqual(await hook.enterFrom(stored(changed)), success);
    const end = beatPos("r1", rows[0].audioText.length);
    check(writer, end, end);
  });

  test(`${surface} maps a joined member's range to the assembled row`, async t => {
    const beats = [{ id: "first", audioText: "Unrelated first beat" }, ...rows];
    start(t, writer, project(beats));
    place(writer, beatPos("r2", 0), beatPos("r2", 5));
    const bytes = stored(beats, native => assert.equal(native.commands.joinRow("r2", "r1", " ").kind, "written"));
    assert.deepEqual(await hook.enterFrom(bytes), success);
    check(writer, beatPos("r1", 12), beatPos("r1", 17));
    typeNative("!");
    assert.deepEqual(hook.leave(), success);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Unrelated first beat", "Hello there ! again"]);
  });

  test(`${surface} does not accept identical paint when the original beat is now split across members`, async t => {
    start(t, writer, project([{ ...rows[0], audioText: "Hello there World again" }]));
    place(writer, beatPos("r1", 12), beatPos("r1", 17));
    const bytes = stored(rows, native => assert.equal(native.commands.joinRow("r2", "r1", " ").kind, "written"));
    assert.deepEqual(await hook.enterFrom(bytes), success);
    const end = beatPos("r1", 23);
    check(writer, end, end);
  });

  test(`${surface} keeps a directed Visual range on entry and leave`, async t => {
    start(t, writer);
    const visual = () => document.querySelector(writer ? ".wr-flow-visual-text" : '#rows [data-id="r1"][data-field="visualText"]');
    if (writer) flow().openVisual("r1");
    const cell = visual();
    cell.focus();
    const a = posToDom(cell, 8), h = posToDom(cell, 5);
    document.getSelection().setBaseAndExtent(a.node, a.offset, h.node, h.offset);
    const verify = () => {
      assert.equal(document.activeElement, visual());
      const { anchor, head } = readSelection(visual(), document.getSelection());
      assert.deepEqual([anchor, head], [8, 5]);
    };
    assert.deepEqual(await hook.enter(), success);
    verify();
    assert.deepEqual(hook.leave(), success);
    verify();
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

test("Writer keeps a directed heading-name range on entry and leave", async t => {
  start(t, true, project(rows, [{ id: "intro", name: "Introduction", firstSceneId: "r1" }]));
  const range = { anchor: headingPos("intro", 8), head: headingPos("intro", 2) };
  flow().place(range);
  assert.deepEqual(await hook.enter(), success);
  assert.equal(document.activeElement, writerRoot());
  assert.deepEqual(flow().selection(), range);
  assert.deepEqual(hook.leave(), success);
  assert.equal(document.activeElement, writerRoot());
  assert.deepEqual(flow().selection(), range);
});

test("Split leaves the focused second beat alone when there is no source range", async t => {
  start(t, false);
  const cell = narration(false, "r2");
  cell.focus();
  document.getSelection().removeAllRanges();
  assert.deepEqual(await hook.enter(), success);
  assert.equal(document.activeElement, cell);
  assert.equal(document.getSelection().rangeCount, 0);
  assert.deepEqual(hook.leave(), success);
  assert.equal(document.activeElement, cell);
  assert.equal(document.getSelection().rangeCount, 0);
});

for (const [name, id, container] of [
  ["title", "doc-title"], ["Find", "find-input", "findbar"],
  ["panel input", "gear-quickadd-input", "gear-panel"], ["dialog", "comment-name", "comment-modal"]
]) {
  test(`the ${name} keeps focus if activated during entry and at leave`, async t => {
    start(t, false);
    place(false, beatPos("r1", 2), beatPos("r1", 5));
    const target = document.getElementById(id);
    const surface = container && document.getElementById(container);
    if (surface) {
      surface.hidden = false;
      t.after(() => { surface.hidden = true; });
    }
    const stop = onSessionChange(change => {
      if (change.kind === "adopt" && sharedSession()) queueMicrotask(() => target.focus());
    });
    t.after(stop);
    assert.deepEqual(await hook.enter(), success);
    assert.equal(document.activeElement, target);
    assert.deepEqual(hook.leave(), success);
    assert.equal(document.activeElement, target);
  });
}

for (const moveFocus of [true, false]) {
  test(moveFocus ? "rollback leaves focus in the title after a move during entry" : "rollback restores the range in Writer", async t => {
    start(t, !moveFocus);
    const anchor = beatPos("r1", 2), head = beatPos("r1", 5);
    place(!moveFocus, anchor, head);
    const title = document.getElementById("doc-title");
    if (moveFocus) t.after(onSessionChange(change => {
      if (change.kind === "adopt" && sharedSession()) queueMicrotask(() => title.focus());
    }));
    const adopt = t.mock.method(undoOwner(), "adopt", () => { throw new Error("Undo reset failed"); });
    t.mock.method(console, "error", () => {});
    assert.deepEqual(await hook.enter(), { ok: false, reason: "enter-failed" });
    adopt.mock.restore();
    assert.equal(sharedSession(), false);
    if (moveFocus) assert.equal(document.activeElement, title);
    else check(true, anchor, head);
  });
}
