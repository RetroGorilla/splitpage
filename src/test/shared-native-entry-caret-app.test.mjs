import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { NativeScriptReader } from "../adapters/collab/native/reader.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml, scriptCellOf } from "../bootstrap/richtext.ts";
import { draftsTesting } from "../bootstrap/wiring/drafts.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { flushDraftNow } from "../bootstrap/wiring/recovery-owners.ts";
import { adoptReplacement, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { beatPos, headingPos } from "../core/flow/flow.ts";
import { domToPos, posToDom, readSelection } from "../features/common/cell-dom.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";

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

function checkUnplaced(writer, id = "r1") {
  const before = hook.read().app.rows;
  const cell = writer ? writerRoot() : narration(false, id);
  cell.focus();
  assert.equal(document.activeElement, cell);
  assert.equal(document.getSelection().rangeCount, 0);
  typeNative("!");
  assert.equal(document.getSelection().rangeCount, 0);
  assert.deepEqual(hook.read().app.rows, before);
}

function stored(beats, change = () => {}, sections = []) {
  const document = project(beats, sections);
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
    checkUnplaced(writer);
    assert.deepEqual(hook.leave(), success);
    checkUnplaced(writer);
    assert.equal(hook.read().app.rows[0].audioText, "New Hello there");
  });

  test(`${surface} does not select newly inserted text between unchanged endpoints`, async t => {
    start(t, writer);
    place(writer, beatPos("r1", 6), beatPos("r2", 5));
    const changed = [rows[0], { id: "inserted", audioText: "Added beat" }, rows[1]];
    assert.deepEqual(await hook.enterFrom(stored(changed)), success);
    checkUnplaced(writer);
  });

  test(`${surface} never types over a replacement beat with identical narration`, async t => {
    const middle = { id: "original", audioText: "Identical narration", visualText: "Original Visual" };
    const replacement = { ...middle, id: "replacement", visualText: "Replacement Visual" };
    start(t, writer, project([rows[0], middle, rows[1]]));
    place(writer, beatPos("r2", 5), beatPos("r1", 6));
    assert.deepEqual(await hook.enterFrom(stored([rows[0], replacement, rows[1]])), success);
    checkUnplaced(writer);
    assert.deepEqual(hook.leave(), success);
    checkUnplaced(writer);
    assert.deepEqual(hook.read().app.rows.map(row => [row.id, row.visualText]),
      [["r1", "Look again"], ["replacement", "Replacement Visual"], ["r2", ""]]);
  });

  test(`${surface} rejects changed Visual text in an interior beat`, async t => {
    const middle = { id: "middle", audioText: "Unchanged narration", visualText: "Original Visual" };
    start(t, writer, project([rows[0], middle, rows[1]]));
    place(writer, beatPos("r1", 3), beatPos("r2", 4));
    const changed = [rows[0], { ...middle, visualText: "Updated Visual" }, rows[1]];
    assert.deepEqual(await hook.enterFrom(stored(changed)), success);
    checkUnplaced(writer);
  });

  test(`${surface} rejects a changed heading identity inside the range even when its name matches`, async t => {
    const heading = { id: "old-heading", name: "Same name", firstSceneId: "r2" };
    start(t, writer, project(rows, [heading]));
    place(writer, beatPos("r1", 3), beatPos("r2", 4));
    assert.deepEqual(await hook.enterFrom(stored(rows, undefined, [{ ...heading, id: "new-heading" }])), success);
    checkUnplaced(writer);
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

  test(`${surface} leaves a range unplaced when joining inserts text between its members`, async t => {
    start(t, writer);
    place(writer, beatPos("r1", 8), beatPos("r2", 4));
    const bytes = stored(rows, native => assert.equal(native.commands.joinRow("r2", "r1", " ").kind, "written"));
    assert.deepEqual(await hook.enterFrom(bytes), success);
    checkUnplaced(writer);
  });

  test(`${surface} does not accept identical paint when the original beat is now split across members`, async t => {
    start(t, writer, project([{ ...rows[0], audioText: "Hello there World again" }]));
    place(writer, beatPos("r1", 12), beatPos("r1", 17));
    const bytes = stored(rows, native => assert.equal(native.commands.joinRow("r2", "r1", " ").kind, "written"));
    assert.deepEqual(await hook.enterFrom(bytes), success);
    checkUnplaced(writer);
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

  test(`${surface} leaves the caret unplaced when the selected beat is absent`, async t => {
    start(t, writer);
    place(writer, beatPos("r1", 2), beatPos("r1", 5));
    assert.deepEqual(await hook.enterFrom(stored([rows[1]])), success);
    checkUnplaced(writer, "r2");
    const target = writer ? writerRoot() : narration(false, "r2");
    target.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    const point = beatPos("r2", 5);
    place(writer, point, point);
    typeNative("!");
    assert.deepEqual(hook.leave(), success);
    assert.equal(hook.read().app.rows[0].audioText, "World! again");
  });

  test(`${surface} leaves the caret unplaced when a peer removes the selected beat just before leave`, async t => {
    start(t, writer);
    assert.deepEqual(await hook.enter(), success);
    place(writer, beatPos("r1", 2), beatPos("r2", 5));
    assert.equal(hook.nativePeer.removeBeat("r1").kind, "written");
    assert.deepEqual(hook.leave(), success);
    checkUnplaced(writer, "r2");
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

test("Writer does not reopen Visual to place a range when its beat changed", async t => {
  start(t, true);
  flow().openVisual("r1");
  const cell = document.querySelector(".wr-flow-visual-text");
  const startPoint = posToDom(cell, 1), endPoint = posToDom(cell, 5);
  document.getSelection().setBaseAndExtent(startPoint.node, startPoint.offset, endPoint.node, endPoint.offset);
  const changed = [{ ...rows[0], audioText: "Changed narration" }, rows[1]];
  assert.deepEqual(await hook.enterFrom(stored(changed)), success);
  assert.equal(document.querySelector(".wr-flow-visual-box").hidden, true);
  checkUnplaced(true);
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
  ["panel input", "broll-add-input", "broll-panel"], ["dialog", "comment-name", "comment-modal"]
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
      if (change.kind === "adopt" && sharedSession()) queueMicrotask(() => {
        target.focus();
        target.value = "Field selection";
        target.setSelectionRange(1, 5, "backward");
      });
    });
    t.after(stop);
    const verify = () => {
      assert.equal(document.activeElement, target);
      assert.deepEqual([target.selectionStart, target.selectionEnd, target.selectionDirection], [1, 5, "backward"]);
    };
    assert.deepEqual(await hook.enter(), success);
    verify();
    assert.deepEqual(hook.leave(), success);
    verify();
  });
}

test("focus moving to the title and then to the page does not restore Writer's selection", async t => {
  start(t, true);
  place(true, beatPos("r1", 2), beatPos("r1", 5));
  const title = document.getElementById("writer-title");
  t.after(onSessionChange(change => {
    if (change.kind === "adopt" && sharedSession()) queueMicrotask(() => { title.focus(); title.blur(); });
  }));
  assert.deepEqual(await hook.enter(), success);
  assert.equal(document.activeElement, document.body);
  checkUnplaced(true);
});

for (const moveFocus of [true, false]) {
  test(moveFocus ? "rollback leaves focus in the title after a move during entry" : "rollback does not replay the Writer range", async t => {
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
    else assert.notDeepEqual(flow().selection(), { anchor, head });
  });
}

for (const when of ["refused entry", "rolled back entry", "failed leave", "forced leave", "failed native close"]) {
  test(`${when} never restores selection or reads it after destruction`, async t => {
    const fixture = entrySwitchFixture(), dispose = t.mock.fn();
    let arm = false, leaving = false, serial = 0, native, reader, identifyReader = false;
    const afterClose = [];
    const restore = t.mock.fn(() => { if (native.ydoc.isDestroyed) afterClose.push("restore"); });
    const snapshot = { restore, dispose, get ownsFocus() { throw new Error("A failed switch checked focus"); } };
    for (const key of ["noticeBeat", "row"]) {
      const read = NativeScriptReader.prototype[key];
      t.mock.method(NativeScriptReader.prototype, key, function (...args) {
        if (identifyReader) reader = this;
        if (this === reader && native.ydoc.isDestroyed) afterClose.push(key);
        return read.apply(this, args);
      });
    }
    const ports = {
      ...fixture.ports,
      refusal: () => when === "refused entry" ? "test-refusal" : null,
      detach: () => { if (when === "rolled back entry") throw new Error("Entry rollback"); },
      migrate: raw => {
        const doc = fixture.ports.migrate(raw);
        if (arm) Object.defineProperty(doc, "toJSON", { value: () => ++serial });
        return doc;
      }
    };
    start(t, true);
    place(true, beatPos("r1", 5), beatPos("r1", 2));
    const captured = t.mock.fn(entering => {
      if (native.ydoc.isDestroyed) afterClose.push("capture");
      return entering ? null : snapshot;
    });
    const entering = await enterSharedSession(ports, (doc, failedClose) => {
      const joined = when === "failed leave"
        ? stored(rows, copy => assert.equal(copy.commands.joinRow("r2", "r1", " ").kind, "written")) : undefined;
      const opened = openNativeEditor(ports, doc, failedClose, joined);
      native = opened.native;
      return { ...opened.backend, captureSelection: direction => {
        if (!leaving && when === "rolled back entry") return snapshot;
        return captured(direction);
      } };
    });
    if (when === "refused entry" || when === "rolled back entry") {
      assert.equal(entering.ok, false);
      assert.equal(captured.mock.callCount(), 0);
      assert.equal(dispose.mock.callCount(), when === "rolled back entry" ? 1 : 0);
    } else {
      assert.deepEqual(entering, success);
      identifyReader = true;
      assert.equal(native.readRow("r1")?.id, "r1");
      identifyReader = false;
      leaving = true;
      if (when === "failed native close") {
        arm = true;
        const caret = native.commands.anchorText({ beat: "r1", cell: "narration" }, 0);
        assert.equal(caret.kind, "anchored");
        native.ydoc.once("afterTransactionCleanup", () => { throw new Error("Interrupted cleanup"); });
        assert.throws(() => native.commands.typeText(caret.range, "!", {}), /Interrupted cleanup/);
        await Promise.resolve();
        assert.equal(native.ydoc.isDestroyed, true);
        assert.equal(sharedSession(), true);
      } else if (when === "forced leave") {
        assert.deepEqual(forceLeaveSharedSession(), success);
        await Promise.resolve();
        assert.equal(native.ydoc.isDestroyed, true);
      } else {
        place(true, beatPos("r1", 17), beatPos("r1", 12));
        arm = true;
        assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "leave-failed" });
        assert.equal(sharedSession(), true);
        assert.ok(fixture.errors.some(error => error.message === "The standalone copy did not land as captured"));
      }
      assert.equal(captured.mock.callCount(), when === "failed leave" ? 2 : 1);
      assert.equal(dispose.mock.callCount(), when === "failed leave" ? 1 : 0);
    }
    arm = false;
    assert.equal(restore.mock.callCount(), 0);
    assert.deepEqual(afterClose, []);
  });
}
