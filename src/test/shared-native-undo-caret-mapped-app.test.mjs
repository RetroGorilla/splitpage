import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { trackGlobalListeners } from "./_global-listener-inventory.mjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { beatPos } from "../core/flow/flow.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml } from "../bootstrap/richtext.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { nativeEntrySwitchFixture as entrySwitchFixture } from "../../tests/bootstrap/native-entry-switch-support.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const listenerInventory = trackGlobalListeners();
await bootApp();
after(closeApp);

const WARNING = ["This is not available in a shared session yet.", "warn"];
const BROLL = id => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const flush = () => window.dispatchEvent(new window.Event("pagehide"));
const app = () => currentDocument();
const rowsOf = doc => doc.rows.map(({ id, audioText, visualText }) => [id, audioText, visualText]);
const plainText = node => node.textContent.replace(/\u200b/g, "");

function written(result) {
  assert.equal(result.kind, "written");
  return result;
}

function send(from, to) {
  assert.equal(applyNativePeerUpdate(to, from.encodeState()), true);
}

function exchange(f) {
  send(f.peer, f.native);
  send(f.native, f.peer);
}

async function enter(t, rows, view = "split") {
  const writer = writerControls();
  writer.closeWriter();
  const fixture = entrySwitchFixture();
  const doc = migrateRows({
    schema: 2,
    title: "Undo caret parity",
    paragraphsDecided: true,
    rows: rows.map(([id, audioText, visualText = ""]) => ({ id, audioText, visualText, status: "todo" }))
  });
  adoptReplacement(doc);
  const show = t.mock.method(notices, "show", () => {});
  const ports = { ...fixture.ports, commandRefused: sharedCommandRefusalNotice(notices) };
  let native;
  const baseline = listenerInventory();
  assert.deepEqual(await enterSharedSession(ports, (script, failed) => {
    const opened = openNativeEditor(ports, script, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  t.after(() => {
    try {
      assert.deepEqual(fixture.errors, []);
    } finally {
      if (sharedSession() && !leaveRunningSharedSession().ok) {
        forceLeaveSharedSession();
        const allowed = () => ({ allowed: true });
        adoptReplacement(migrateRows({ title: "Standby", rows: [] }),
          createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
      }
      writer.closeWriter();
    }
  });
  const peer = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml });
  t.after(peer.close);
  if (view !== "split") writer.openWriter();
  return {
    native,
    peer,
    writer,
    baseline,
    notices: () => show.mock.calls.map(call => call.arguments)
  };
}

function writerRoot() {
  return document.getElementById("writer-doc");
}

function field(view, rowId, key = "audioText") {
  const selector = view === "writer"
    ? `#writer-doc .wr-beat[data-id="${rowId}"]`
    : `#rows .cell-editable[data-id="${rowId}"][data-field="${key}"]`;
  const element = document.querySelector(selector);
  assert.ok(element, `${view} shows ${rowId}/${key}`);
  return element;
}

function place(view, rowId, from, to = from) {
  if (view === "writer") {
    writerRoot().focus();
    writerControls().writerFlowControl().place({ anchor: beatPos(rowId, from), head: beatPos(rowId, to) });
    document.dispatchEvent(new window.Event("selectionchange"));
  } else {
    const cell = field(view, rowId);
    cell.focus();
    setCellSelection(cell, from, to);
  }
  return window.getSelection().getRangeAt(0).cloneRange();
}

function domRange(host, from, to) {
  const start = posToDom(host, from), end = posToDom(host, to), range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function readCaret(view) {
  if (view === "writer") {
    const range = writerControls().writerFlowControl().selection();
    return {
      focused: document.activeElement === writerRoot(),
      range: range && range.anchor.kind === "beat" && range.head.kind === "beat"
        ? [range.anchor.rowId, range.anchor.offset, range.head.offset, range.head.rowId]
        : null
    };
  }
  const active = document.activeElement?.closest?.(".cell-editable") ?? null;
  const range = active ? cellSelection(active) : null;
  return {
    focused: active !== null,
    range: active && range ? [active.getAttribute("data-id"), range.from, range.to, active.getAttribute("data-field")] : null
  };
}

function expectCaret(view, rowId, from, to = from, fieldName = "audioText") {
  const live = readCaret(view);
  assert.equal(live.focused, true, `${view} keeps focus`);
  if (view === "writer") {
    assert.deepEqual(live.range, [rowId, from, to, rowId]);
  } else {
    assert.deepEqual(live.range, [rowId, from, to, fieldName]);
  }
}

function keydown(target, key, modifiers = {}) {
  const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function nativeBeforeInput(view, rowId, from, to, text, inputType, collapsedAt) {
  const element = field(view, rowId);
  const surface = view === "writer" ? writerRoot() : element;
  const target = collapsedAt === undefined
    ? place(view, rowId, from, to)
    : (place(view, rowId, collapsedAt, collapsedAt), domRange(element, from, to));
  const key = text ? text[0] : inputType === "deleteContentForward" ? "Delete" : "Backspace";
  keydown(surface, key);
  const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data: text || null });
  Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
  element.dispatchEvent(before);
  surface.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true }));
  return before.defaultPrevented;
}

function composeReplace(view, rowId, from, to, text) {
  const element = field(view, rowId);
  const surface = view === "writer" ? writerRoot() : element;
  const target = place(view, rowId, from, to);
  surface.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, cancelable: true, data: "" }));
  surface.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, cancelable: true, data: text }));
  const before = new window.InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: "insertCompositionText", data: text, isComposing: true
  });
  Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
  if (element.dispatchEvent(before)) {
    target.deleteContents();
    const node = document.createTextNode(text);
    target.insertNode(node);
    window.getSelection().setBaseAndExtent(node, text.length, node, text.length);
    element.dispatchEvent(new window.InputEvent("input", {
      bubbles: true, inputType: "insertCompositionText", data: text, isComposing: true
    }));
  }
  surface.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, cancelable: true, data: text }));
}

function historyKey(view, rowId, key, onPage = false) {
  if (view === "writer") {
    const target = document.querySelector(`#writer-doc .wr-beat[data-id="${rowId}"]`) ?? writerRoot();
    assert.equal(keydown(target, key, { ctrlKey: true }), true);
    return;
  }
  const target = onPage ? document.body : document.activeElement;
  assert.equal(keydown(target, key, { ctrlKey: true }), true);
}

async function agree(f, expectedRows) {
  exchange(f);
  await Promise.resolve();
  assert.deepEqual(rowsOf(app()), expectedRows);
  assert.deepEqual(f.native.document(), app());
  assert.deepEqual(f.peer.document(), app());
}

function land(f, expectedRows, { waitOnLeave = false } = {}) {
  const sharedDocId = app().docId;
  const finalSnapshot = structuredClone(app());
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.equal(sharedSession(), false);
  assert.equal(f.native.isClosingOrClosed(), true);
  assert.notEqual(app().docId, sharedDocId);
  assert.deepEqual(app(), migrateRows({ ...finalSnapshot, docId: app().docId }));
  assert.deepEqual(rowsOf(app()), expectedRows);
  assert.equal(document.body.hasAttribute("data-native-caret-unplaced"), waitOnLeave);
  if (waitOnLeave) {
    field("split", expectedRows[0][0]).dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    assert.equal(document.body.hasAttribute("data-native-caret-unplaced"), false);
  }
  f.writer.closeWriter();
  assert.deepEqual(listenerInventory(), f.baseline);
}

for (const view of ["writer", "split"]) {
  test(`${view}: replacing bc with Zc retains final c and replays exact replacement selection`, async t => {
    const f = await enter(t, [["R1", "abcd"]], view);
    assert.equal(nativeBeforeInput(view, "R1", 1, 3, "Zc", "insertText"), true);
    flush();
    await agree(f, [["R1", "aZcd", ""]]);
    assert.equal(plainText(field(view, "R1")), "aZcd");
    expectCaret(view, "R1", 3, 3);

    historyKey(view, "R1", "z");
    await agree(f, [["R1", "abcd", ""]]);
    expectCaret(view, "R1", 1, 3);

    historyKey(view, "R1", "y");
    await agree(f, [["R1", "aZcd", ""]]);
    expectCaret(view, "R1", 3, 3);

    historyKey(view, "R1", "z");
    await agree(f, [["R1", "abcd", ""]]);
    expectCaret(view, "R1", 1, 3);

    assert.deepEqual(f.notices(), []);
    land(f, [["R1", "abcd", ""]]);
  });

  for (const collapsed of [false, true]) {
    test(`${view}: deleting middle a of aaa (${collapsed ? "collapsed Backspace" : "selected range"}) replays exact endpoints`, async t => {
      const f = await enter(t, [["R1", "aaa"]], view);
      assert.equal(nativeBeforeInput(view, "R1", 1, 2, "", "deleteContentBackward", collapsed ? 2 : undefined), true);
      flush();
      await agree(f, [["R1", "aa", ""]]);
      assert.equal(plainText(field(view, "R1")), "aa");
      expectCaret(view, "R1", 1, 1);

      historyKey(view, "R1", "z");
      await agree(f, [["R1", "aaa", ""]]);
      expectCaret(view, "R1", collapsed ? 2 : 1, 2);

      historyKey(view, "R1", "y");
      await agree(f, [["R1", "aa", ""]]);
      expectCaret(view, "R1", 1, 1);

      assert.deepEqual(f.notices(), []);
      land(f, [["R1", "aa", ""]]);
    });

    test(`${view}: deleting after a line break (${collapsed ? "collapsed Backspace" : "selected range"}) replays exact endpoints`, async t => {
      const f = await enter(t, [["R1", "a<br>bc"]], view);
      assert.equal(nativeBeforeInput(view, "R1", 2, 3, "", "deleteContentBackward", collapsed ? 3 : undefined), true);
      flush();
      await agree(f, [["R1", "a<br>c", ""]]);
      expectCaret(view, "R1", 2, 2);

      historyKey(view, "R1", "z");
      await agree(f, [["R1", "a<br>bc", ""]]);
      expectCaret(view, "R1", collapsed ? 3 : 2, 3);

      historyKey(view, "R1", "y");
      await agree(f, [["R1", "a<br>c", ""]]);
      expectCaret(view, "R1", 2, 2);

      assert.deepEqual(f.notices(), []);
      land(f, [["R1", "a<br>c", ""]]);
    });

    test(`${view}: deleting the first of two B-roll atoms (${collapsed ? "collapsed Backspace" : "selected range"}) refuses once and leaves history empty`, async t => {
      const initial = BROLL("bs1") + BROLL("bs2");
      const f = await enter(t, [["R1", initial]], view);
      const beforeBytes = f.native.encodeState();
      assert.equal(nativeBeforeInput(view, "R1", 0, 1, "", "deleteContentBackward", collapsed ? 1 : undefined), true);
      flush();
      await agree(f, [["R1", initial, ""]]);
      assert.deepEqual(f.native.encodeState(), beforeBytes);
      assert.deepEqual(f.notices(), [WARNING]);
      const atoms = [...field(view, "R1").querySelectorAll('.broll-key[contenteditable="false"]')].map(el => el.dataset.brollId);
      assert.deepEqual(atoms, ["bs1", "bs2"]);
      expectCaret(view, "R1", collapsed ? 1 : 0, 1);

      for (const key of ["z", "y", "z"]) {
        historyKey(view, "R1", key);
        await agree(f, [["R1", initial, ""]]);
        expectCaret(view, "R1", collapsed ? 1 : 0, 1);
      }
      assert.deepEqual(f.notices(), [WARNING]);

      assert.equal(nativeBeforeInput(view, "R1", 2, 2, "!", "insertText"), true);
      flush();
      await agree(f, [["R1", initial + "!", ""]]);
      expectCaret(view, "R1", 3, 3);

      historyKey(view, "R1", "z");
      await agree(f, [["R1", initial, ""]]);
      expectCaret(view, "R1", 2, 2);
      assert.deepEqual(f.notices(), [WARNING]);
      land(f, [["R1", initial, ""]]);
    });
  }

  for (const [label, seed, from, text, afterText, undoOffset, redoOffset] of [
    ["change at the start only", [["R1", "abcd"]], 0, "X", [["R1", "Xabcd", ""]], 0, 1],
    ["change at the end only", [["R1", "abcd"]], 4, "X", [["R1", "abcdX", ""]], 4, 5],
    ["type into an empty row", [["R1", ""], ["R2", "next"]], 0, "x", [["R1", "x", ""], ["R2", "next", ""]], 0, 1]
  ]) {
    test(`${view}: ${label} replays exact start and end carets`, async t => {
      const f = await enter(t, seed, view);
      const original = seed.map(([id, audioText, visualText = ""]) => [id, audioText, visualText]);
      assert.equal(nativeBeforeInput(view, "R1", from, from, text, "insertText"), true);
      flush();
      await agree(f, afterText);
      expectCaret(view, "R1", redoOffset, redoOffset);

      historyKey(view, "R1", "z");
      await agree(f, original);
      expectCaret(view, "R1", undoOffset, undoOffset);

      historyKey(view, "R1", "y");
      await agree(f, afterText);
      expectCaret(view, "R1", redoOffset, redoOffset);

      assert.deepEqual(f.notices(), []);
      land(f, afterText);
    });
  }

  for (const order of ["mine first", "peer first"]) {
    test(`${view}: concurrent bold on retained char (${order}) preserves mark, peer anchor and Undo/Redo endpoints`, async t => {
      const f = await enter(t, [["R1", "abcd"]], view);
      const peerBold = () => {
        const range = f.peer.commands.anchorText({ beat: "R1", cell: "narration" }, 3, 4);
        assert.equal(range.kind, "anchored");
        written(f.peer.commands.formatText(range.range, { kind: "plain", mark: "b", on: true }));
      };
      if (order === "peer first") {
        peerBold();
        exchange(f);
        await Promise.resolve();
      }
      assert.equal(nativeBeforeInput(view, "R1", 1, 3, "", "deleteContentBackward"), true);
      flush();
      if (order === "mine first") peerBold();
      await agree(f, [["R1", "a<strong>d</strong>", ""]]);
      const watched = f.peer.commands.anchorText({ beat: "R1", cell: "narration" }, 1);
      assert.equal(watched.kind, "anchored");

      const checkWatched = expectedOffset => {
        const resolved = f.peer.resolveTextSelection(watched.range);
        assert.ok(resolved);
        assert.equal(resolved.anchor.target.beat, "R1");
        assert.equal(resolved.anchor.offset, expectedOffset);
        assert.equal(f.peer.document().rows[0].audioText.replace(/<[^>]+>/g, "")[expectedOffset], "d");
      };

      historyKey(view, "R1", "z");
      await agree(f, [["R1", "abc<strong>d</strong>", ""]]);
      expectCaret(view, "R1", 1, 3);
      checkWatched(3);

      historyKey(view, "R1", "y");
      await agree(f, [["R1", "a<strong>d</strong>", ""]]);
      expectCaret(view, "R1", 1, 1);
      checkWatched(1);

      historyKey(view, "R1", "z");
      await agree(f, [["R1", "abc<strong>d</strong>", ""]]);
      expectCaret(view, "R1", 1, 3);
      checkWatched(3);

      assert.deepEqual(f.notices(), []);
      land(f, [["R1", "abc<strong>d</strong>", ""]]);
    });

    test(`${view}: delete inside a row the other person joins (${order}) replays Undo and omits empty-member Redo selection`, async t => {
      const f = await enter(t, [["R1", "aa"], ["R2", "a"]], view);
      if (order === "peer first") {
        written(f.peer.commands.joinRow("R2", "R1", ""));
        exchange(f);
        await Promise.resolve();
        assert.equal(nativeBeforeInput(view, "R1", 2, 3, "", "deleteContentBackward"), true);
        flush();
      } else {
        assert.equal(nativeBeforeInput(view, "R2", 0, 1, "", "deleteContentBackward"), true);
        flush();
        written(f.peer.commands.joinRow("R2", "R1", ""));
      }
      await agree(f, [["R1", "aa", ""]]);

      historyKey(view, "R1", "z", view === "split");
      await agree(f, [["R1", "aaa", ""]]);
      expectCaret(view, "R1", 2, 3);

      historyKey(view, "R1", "y", view === "split");
      await agree(f, [["R1", "aa", ""]]);
      if (view === "writer") {
        assert.deepEqual(readCaret("writer"), { focused: true, range: null });
      } else {
        expectCaret("split", "R1", 2, 2);
      }

      assert.deepEqual(f.notices(), []);
      land(f, [["R1", "aa", ""]], { waitOnLeave: view === "split" });
    });
  }
}

test("writer: replacing bc with Zc by composition retains final c and replays exact selection", async t => {
  const f = await enter(t, [["R1", "abcd"]], "writer");
  composeReplace("writer", "R1", 1, 3, "Zc");
  await agree(f, [["R1", "aZcd", ""]]);
  assert.equal(plainText(field("writer", "R1")), "aZcd");
  expectCaret("writer", "R1", 3, 3);

  historyKey("writer", "R1", "z");
  await agree(f, [["R1", "abcd", ""]]);
  expectCaret("writer", "R1", 1, 3);

  historyKey("writer", "R1", "y");
  await agree(f, [["R1", "aZcd", ""]]);
  expectCaret("writer", "R1", 3, 3);

  assert.deepEqual(f.notices(), []);
  land(f, [["R1", "aZcd", ""]]);
});

for (const view of ["writer", "writer>split"]) {
  test(`${view}: Alt+Backspace join refuses once and leaves history untouched`, async t => {
    const f = await enter(t, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]], "writer");
    const beforeBytes = f.native.encodeState();
    place("writer", "R2", 0, 0);
    assert.equal(keydown(field("writer", "R2"), "Backspace", { altKey: true }), true);
    await agree(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
    assert.deepEqual(f.native.encodeState(), beforeBytes);
    assert.deepEqual(f.notices(), [WARNING]);
    expectCaret("writer", "R2", 0, 0);

    if (view === "writer>split") f.writer.closeWriter();
    const at = view === "writer" ? "writer" : "split";
    expectCaret(at, "R2", 0, 0);
    for (const key of ["z", "y", "z"]) {
      historyKey(at, "R1", key, at === "split");
      await agree(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
      expectCaret(at, "R2", 0, 0);
    }
    assert.deepEqual(f.notices(), [WARNING]);
    land(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
  });

  test(`${view}: Writer join with Backspace at R2:0 replays exact narration seam across views`, async t => {
    const f = await enter(t, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]], "writer");
    place("writer", "R2", 0, 0);
    assert.equal(keydown(field("writer", "R2"), "Backspace"), true);
    await agree(f, [["R1", "abcd efgh", "foo<br>bar"]]);
    expectCaret("writer", "R1", 5, 5);

    if (view === "writer>split") f.writer.closeWriter();
    const at = view === "writer" ? "writer" : "split";

    historyKey(at, "R1", "z", at === "split");
    await agree(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
    expectCaret(at, "R2", 0, 0);

    historyKey(at, "R1", "y", at === "split");
    await agree(f, [["R1", "abcd efgh", "foo<br>bar"]]);
    expectCaret(at, "R1", 5, 5);

    historyKey(at, "R1", "z", at === "split");
    await agree(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
    expectCaret(at, "R2", 0, 0);

    assert.deepEqual(f.notices(), []);
    land(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
  });

  test(`${view}: Enter in R1 then Alt+Backspace refuses join while Enter remains undoable`, async t => {
    const f = await enter(t, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]], "writer");
    place("writer", "R1", 2, 2);
    assert.equal(keydown(field("writer", "R1"), "Enter"), true);
    const created = app().rows[1].id;
    assert.ok(created !== "R1" && created !== "R2");
    const split = [["R1", "ab", "foo"], [created, "cd", ""], ["R2", "efgh", "bar"]];
    await agree(f, split);
    expectCaret("writer", created, 0, 0);

    const bytesAfterSplit = f.native.encodeState();
    place("writer", "R2", 0, 0);
    assert.equal(keydown(field("writer", "R2"), "Backspace", { altKey: true }), true);
    await agree(f, split);
    assert.deepEqual(f.native.encodeState(), bytesAfterSplit);
    assert.deepEqual(f.notices(), [WARNING]);
    expectCaret("writer", "R2", 0, 0);

    if (view === "writer>split") f.writer.closeWriter();
    const at = view === "writer" ? "writer" : "split";
    expectCaret(at, "R2", 0, 0);

    historyKey(at, "R1", "z", at === "split");
    await agree(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
    expectCaret(at, "R1", 2, 2);

    historyKey(at, "R1", "y", at === "split");
    await agree(f, split);
    expectCaret(at, created, 0, 0);

    historyKey(at, "R1", "z", at === "split");
    await agree(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
    expectCaret(at, "R1", 2, 2);

    assert.deepEqual(f.notices(), [WARNING]);
    land(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
  });

  test(`${view}: Enter in R1 then Backspace at R2:0 joins into new beat and replays history across views`, async t => {
    const f = await enter(t, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]], "writer");
    place("writer", "R1", 2, 2);
    assert.equal(keydown(field("writer", "R1"), "Enter"), true);
    const created = app().rows[1].id;
    assert.ok(created !== "R1" && created !== "R2");
    const split = [["R1", "ab", "foo"], [created, "cd", ""], ["R2", "efgh", "bar"]];
    await agree(f, split);
    expectCaret("writer", created, 0, 0);

    place("writer", "R2", 0, 0);
    assert.equal(keydown(field("writer", "R2"), "Backspace"), true);
    const joined = [["R1", "ab", "foo"], [created, "cd efgh", "bar"]];
    await agree(f, joined);
    expectCaret("writer", created, 3, 3);

    if (view === "writer>split") f.writer.closeWriter();
    const at = view === "writer" ? "writer" : "split";

    historyKey(at, "R1", "z", at === "split");
    await agree(f, split);
    expectCaret(at, "R2", 0, 0);

    historyKey(at, "R1", "y", at === "split");
    await agree(f, joined);
    expectCaret(at, created, 3, 3);

    historyKey(at, "R1", "z", at === "split");
    await agree(f, split);
    expectCaret(at, "R2", 0, 0);

    historyKey(at, "R1", "z", at === "split");
    await agree(f, [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]]);
    expectCaret(at, "R1", 2, 2);

    historyKey(at, "R1", "y", at === "split");
    await agree(f, split);
    expectCaret(at, created, 0, 0);

    assert.deepEqual(f.notices(), []);
    land(f, split);
  });
}
