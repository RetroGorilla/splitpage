import assert from "node:assert/strict";
import { after, test } from "node:test";
import { encodeStateAsUpdate, encodeStateVector } from "yjs";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { trackGlobalListeners } from "./_global-listener-inventory.mjs";
import { sharedUndoRoute, undoOwner } from "../bootstrap/wiring/undo.ts";
import { adoptReplacement, currentDocument, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml, scriptCellOf } from "../bootstrap/richtext.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { nativeCellView } from "../adapters/collab/native/inline.ts";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession, nativeEditorRecords } from "../bootstrap/wiring/shared-session.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { appActions } from "../bootstrap/wiring/ports/actions.ts";
import { currentBrollRecords } from "../bootstrap/wiring/broll.ts";
import { openBrollPanel } from "../features/broll/panel.ts";
import { buildSplitpageCopy } from "../adapters/formats/project-file.ts";
import { captureExportDocument } from "../bootstrap/wiring/export-capture.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { nativeEntrySwitchFixture as entrySwitchFixture } from "../../tests/bootstrap/native-entry-switch-support.ts";
import { render, renderRow } from "../features/rows/render.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const listenerCounts = trackGlobalListeners();
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const writer = writerControls();
const root = () => document.getElementById("writer-doc");
const cell = (id = "r1", field = "audioText") => document.querySelector(`#rows .cell-editable[data-id="${id}"][data-field="${field}"]`);
const beat = id => document.querySelector(`#writer-doc .wr-beat[data-id="${id}"]`);
const seed = [["r1", "Hello"], ["r2", "World"]];
const newBeat = "new beat";
const rowsOf = rows => rows.map(([id, audioText, visualText = ""]) => ({ id, audioText, visualText }));
const beatName = (id, originalIds) => originalIds && !originalIds.has(id) ? newBeat : id;
const snapshot = (doc, originalIds) => doc.rows.map(({ id, audioText }) => [beatName(id, originalIds), audioText]);
const docOf = rows => migrateRows({ title: "Shared script", paragraphsDecided: true, rows: rowsOf(rows) });
const refused = [["This is not available in a shared session yet.", "warn"]];

function source(t, rows = seed) {
  const doc = docOf(rows);
  const native = openNativeSession({ kind: "document", document: doc, conversion: {
    cells: scriptCellOf, creation: doc.docId, at: "2026-11-20", by: "Writer"
  } }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(native.close);
  return native;
}

function openCopy(t, state) {
  const copy = openNativeSession({ kind: "state", state }, { actor: "Peer", sanitize: sanitizeHtml });
  t.after(copy.close);
  return copy;
}

async function enter(t, rows = seed, state, stopped = false) {
  writer.closeWriter();
  adoptReplacement(docOf(rows));
  assert.deepEqual(await (state ? hook.enterFrom(state) : hook.enter()), { ok: true });
  t.after(() => {
    writer.closeWriter();
    if (!sharedSession()) return;
    if (!stopped) {
      assert.deepEqual(hook.leave(), { ok: true });
      return;
    }
    forceLeaveSharedSession();
    const allowed = () => ({ allowed: true });
    adoptReplacement(docOf([]), createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
  });
}

function leave(expected) {
  assert.deepEqual(hook.leave(), { ok: true });
  assert.deepEqual(snapshot(currentDocument()), expected);
}

function press(target, key, modifiers = {}) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...modifiers });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function input(target, inputType, data = null, range) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data });
  if (range) Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function place(view, from, to = from, id = "r1", head = id) {
  if (view === "Writer") {
    root().focus();
    writer.writerFlowControl().place({
      anchor: { kind: "beat", rowId: id, offset: from },
      head: { kind: "beat", rowId: head, offset: to }
    });
    document.dispatchEvent(new window.Event("selectionchange"));
  } else {
    cell(id).focus();
    setCellSelection(cell(id), from, to);
  }
}

function selection(view) {
  if (view === "Writer") {
    const range = writer.writerFlowControl().selection();
    return range && [range.anchor, range.head].map(({ kind, rowId, offset }) => [kind, rowId, offset]);
  }
  const active = document.activeElement;
  const range = cellSelection(active);
  return range && [range.from, range.to].map(offset => [active.dataset.field, active.dataset.id, offset]);
}

function expectedSelection(view, from, to = from, id = "r1", head = id) {
  const kind = view === "Writer" ? "beat" : "audioText";
  return [[kind, id, from], [kind, head, to]];
}

async function agreed(expected) {
  await Promise.resolve();
  const { app, peer } = hook.read();
  assert.deepEqual(snapshot(app), expected, "editor");
  assert.deepEqual(snapshot(peer), expected, "peer");
  assert.deepEqual(app, peer);
}

function written(result) {
  assert.equal(result.kind, "written");
  return result;
}

function type(native, beatId, offset, text) {
  const anchored = native.commands.anchorText({ beat: beatId, cell: "narration" }, offset);
  assert.equal(anchored.kind, "anchored");
  return written(native.commands.typeText(anchored.range, text, {}));
}

async function enterWithPeer(t) {
  writer.closeWriter();
  const fixture = entrySwitchFixture();
  adoptReplacement(migrateRows({ title: "Shared script", paragraphsDecided: true, rows: [
    { id: "r1", audioText: "Hello", visualText: "Desk" },
    { id: "r2", audioText: "World", visualText: "Window", paragraphStart: true }
  ] }));
  let editor;
  const { ports, errors } = fixture;
  const result = await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    editor = opened.native;
    return opened.backend;
  });
  assert.deepEqual(result, { ok: true }, errors.map(String).join("\n"));
  t.after(() => {
    writer.closeWriter();
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  });
  const peer = openCopy(t, editor.encodeState());
  return { editor, peer };
}

async function agreedWithPeer(editor, peer, expected, late) {
  await Promise.resolve();
  for (const doc of [editor.document(), peer.document()]) assert.deepEqual(snapshot(doc), expected);
  const app = JSON.parse(JSON.stringify(currentDocument()));
  const edit = JSON.parse(JSON.stringify(editor.document()));
  const other = JSON.parse(JSON.stringify(peer.document()));
  assert.deepEqual(app, edit);
  assert.deepEqual(other, edit);
  if (late) assert.deepEqual(JSON.parse(JSON.stringify(late.document())), edit);
}

for (const { name, edit, expected } of [
  {
    name: "splits",
    edit: peer => {
      const at = peer.commands.anchorText({ beat: "r1", cell: "narration" }, 2);
      assert.equal(at.kind, "anchored");
      return peer.commands.splitRow(at.range);
    },
    expected: id => [["r1", "He"], [id, "llo"], ["r2", "World"]]
  },
  { name: "adds", edit: peer => peer.commands.insertAdjacentBeat("r2", "below"), expected: id => [...seed, [id, ""]] },
  { name: "joins", edit: peer => peer.commands.joinRow("r2", "r1", " "), expected: () => [["r1", "Hello World"]] }
]) {
  test(`native peer ${name} a beat, then undoes it on the editor, peer and late readers`, async t => {
    const { editor, peer } = await enterWithPeer(t);
    const change = written(edit(peer));
    if (name !== "joins") {
      assert.equal(typeof change.created, "string");
      assert.ok(!seed.some(([id]) => id === change.created));
    }
    for (const rows of [expected(change.created), seed]) {
      assert.equal(applyNativePeerUpdate(editor, peer.encodeState()), true);
      await Promise.resolve();
      const late = openCopy(t, editor.encodeState());
      await agreedWithPeer(editor, peer, rows, late);
      if (rows !== seed) written(peer.commands.undo());
    }
  });
}

test("native peer cannot split or insert at a missing beat, or join beyond the last beat", async t => {
  const { editor, peer } = await enterWithPeer(t);
  const unchanged = JSON.parse(JSON.stringify(currentDocument()));
  const stored = peer.encodeState();
  const changes = [];
  t.after(peer.subscribe(change => changes.push(change)));
  assert.deepEqual(peer.commands.anchorText({ beat: "gone", cell: "narration" }, 1), { kind: "refused", reason: "missing" });
  assert.deepEqual(peer.commands.insertAdjacentBeat("gone", "below"), { kind: "refused", reason: "missing" });
  assert.deepEqual(peer.commands.joinRow("r1", "r2", " "), { kind: "refused", reason: "above" });
  assert.deepEqual(peer.commands.undo(), { kind: "unchanged" });
  assert.deepEqual(peer.encodeState(), stored);
  assert.equal(applyNativePeerUpdate(editor, peer.encodeState()), true);
  await Promise.resolve();
  await agreedWithPeer(editor, peer, seed);
  assert.deepEqual(changes, []);
  assert.deepEqual(currentDocument(), unchanged);
});

test("Split: anchored insert, undo and redo each publish one change", async t => {
  await enter(t);
  const changes = [];
  t.after(onSessionChange(change => changes.push(change)));
  place("Split", 1, 1, "r2");
  assert.equal(press(cell("r2"), "Enter", { ctrlKey: true }), true);
  const added = currentDocument().rows[2].id;
  assert.ok(!seed.some(([id]) => id === added));
  const inserted = [...seed, [added, ""]];
  await agreed(inserted);
  assert.equal(changes.length, 1);
  assert.equal(press(document.activeElement, "z", { ctrlKey: true }), true);
  await agreed(seed);
  assert.equal(changes.length, 2);
  assert.equal(press(document.activeElement, "y", { ctrlKey: true }), true);
  await agreed(inserted);
  assert.equal(changes.length, 3);
});

test("held native peer edits arrive in one publication and agree with individual delivery", async t => {
  const expected = [["r1", "ABCHello"], ["r2", "World"]];
  for (const held of [true, false]) {
    await enter(t);
    const changes = [];
    const stop = onSessionChange(change => changes.push(change));
    const peer = hook.nativePeer;
    try {
      if (held) peer.hold();
      for (const [offset, letter] of [..."ABC"].entries()) {
        written(peer.type("r1", offset, letter));
        await Promise.resolve();
        assert.equal(changes.length, held ? 0 : offset + 1);
      }
      if (held) {
        assert.deepEqual(snapshot(hook.read().app), seed);
        assert.deepEqual(snapshot(hook.read().peer), expected);
        peer.deliver();
      }
      await agreed(expected);
      assert.equal(changes.length, held ? 1 : 3);
      peer.deliver();
      assert.equal(changes.length, held ? 1 : 3);
    } finally { stop(); }
    assert.deepEqual(hook.leave(), { ok: true });
  }
});

for (const field of ["audioText", "visualText"]) {
  test(`Split ${field}: leave keeps the reused cell and standalone space and clipboard behavior`, async t => {
    const text = "Word\u00a0";
    const rows = [["r1", text, text]];
    adoptReplacement(docOf(rows));
    const target = cell("r1", field);
    const payload = type => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      const writes = [];
      Object.defineProperty(event, type === "copy" ? "clipboardData" : "dataTransfer", {
        value: { setData: (kind, value) => writes.push([kind, value]) }
      });
      target.focus();
      setCellSelection(target, 0, text.length);
      target.dispatchEvent(event);
      return [event.defaultPrevented, writes];
    };
    const copy = [true, [["text/html", "Word&nbsp;"], ["text/plain", "Word "]]];
    assert.deepEqual(payload("copy"), copy);
    assert.deepEqual(payload("dragstart"), [false, []]);
    assert.deepEqual(await hook.enter(), { ok: true });
    t.after(() => { if (sharedSession()) assert.deepEqual(hook.leave(), { ok: true }); });
    assert.equal(cell("r1", field), target);
    assert.deepEqual(payload("copy"), copy);
    assert.deepEqual(payload("dragstart"), [false, []]);
    assert.deepEqual(hook.leave(), { ok: true });
    assert.equal(cell("r1", field), target);
    assert.equal(document.querySelector("[data-shared-cell-space-form], [data-shared-cell-space]"), null);
    assert.deepEqual(payload("copy"), copy);
    assert.deepEqual(payload("dragstart"), [false, []]);
    for (const repaint of [render, () => renderRow("r1")]) {
      repaint();
      assert.equal(cell("r1", field), target);
      assert.equal(document.querySelector("[data-shared-cell-space-form], [data-shared-cell-space]"), null);
      assert.deepEqual(payload("copy"), copy);
      assert.deepEqual(payload("dragstart"), [false, []]);
    }
  });
}

for (const size of [2, 50]) {
  test(`Split: one keystroke in ${size} rows changes only its cell and leave has no shared space paint`, async t => {
    const rows = Array.from({ length: size }, (_, index) => ["r" + index, "Word ", "Wide "]);
    await enter(t, rows);
    const target = cell("r0");
    target.focus();
    setCellSelection(target, 4);
    const watched = [...document.querySelectorAll("#rows .cell-editable")];
    assert.equal(watched.length, size * 2);
    const observer = new window.MutationObserver(() => {});
    for (const editable of watched) observer.observe(editable, { childList: true, characterData: true, subtree: true });
    t.after(() => observer.disconnect());
    assert.equal(input(target, "insertText", "x"), true);
    assert.equal(target.textContent, "Wordx ");
    assert.equal(currentDocument().rows[0].audioText, "Word ");
    window.dispatchEvent(new window.Event("pagehide"));
    const touched = new Set(observer.takeRecords().map(({ target }) =>
      (target.nodeType === window.Node.ELEMENT_NODE ? target : target.parentElement)?.closest(".cell-editable")));
    assert.deepEqual([...touched], [target]);
    assert.ok(watched.every(editable => editable.isConnected));
    const expected = rowsOf([["r0", "Wordx ", "Wide "], ...rows.slice(1)]);
    const expectRows = doc => assert.deepEqual(doc.rows.map(({ id, audioText, visualText }) => ({ id, audioText, visualText })), expected);
    await Promise.resolve();
    for (const copy of Object.values(hook.read())) expectRows(copy);
    assert.deepEqual(hook.leave(), { ok: true });
    expectRows(currentDocument());
    assert.equal(document.querySelector("[data-shared-cell-space-form], [data-shared-cell-space]"), null);
  });
}

for (const view of ["Writer", "Split"]) {
  for (const glue of [false, true]) test(`${view}: refusing deletion ${glue ? "of synthetic join space" : "across joined members"} keeps the editor usable`, async t => {
    const rows = glue ? [["r1", "a "], ["r2", " b"]] : [["r1", "abcd"], ["r2", "ef"]];
    const [from, to] = glue ? [2, 3] : [2, 6];
    await enter(t, rows);
    written(hook.nativePeer.join("r2", "r1"));
    await Promise.resolve();
    const show = t.mock.method(notices, "show", () => {});
    if (view === "Writer") writer.openWriter();
    const surface = view === "Writer" ? root() : cell();
    const editable = view === "Writer" ? beat("r1") : cell();
    const historyTarget = view === "Writer" ? editable : document.body;
    const committed = hook.read().app;
    place(view, from, to);
    const range = document.getSelection().getRangeAt(0).cloneRange();
    press(surface, "Backspace");
    assert.equal(input(editable, "deleteContentBackward", null, range), true);
    surface.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Backspace", bubbles: true }));
    const original = rows.map(([, text]) => text).join(" ");
    const shown = () => (view === "Writer" ? beat("r1") : cell()).textContent.replaceAll("\u00a0", " ");
    await agreed([["r1", original]]);
    assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), refused);
    assert.equal(shown(), original);
    assert.deepEqual(selection(view), expectedSelection(view, from, to));
    for (const key of glue ? ["z", "y"] : ["z", "y", "z"]) {
      assert.equal(press(historyTarget, key, { ctrlKey: true }), true);
      assert.deepEqual(selection(view), expectedSelection(view, from, to));
      assert.equal(shown(), original);
      assert.deepEqual(hook.read(), { app: committed, peer: committed });
    }
    place(view, from);
    assert.equal(input(surface, "insertText", "X"), true);
    window.dispatchEvent(new window.Event("pagehide"));
    const entered = original.slice(0, from) + "X" + original.slice(from);
    await agreed([["r1", entered]]);
    assert.equal(shown(), entered);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), refused);
    const edited = hook.read().app;
    leave([["r1", entered]]);
    const landed = hook.read().app;
    assert.notEqual(landed.docId, edited.docId);
    assert.deepEqual(landed, { ...edited, docId: landed.docId });
  });

  for (const pageHistory of view === "Split" ? [false, true] : [false]) {
    test(`${view}: typing and two forward Deletes undo in separate steps from ${pageHistory ? "the page" : "the editing surface"}`, async t => {
      await enter(t, [["r1", "abcd"]]);
      if (view === "Writer") writer.openWriter();
      place(view, 1);
      assert.equal(input(document.activeElement, "insertText", "Z"), true);
      for (const repeat of [false, true]) {
        const surface = document.activeElement;
        const host = view === "Writer" ? beat("r1") : cell();
        assert.equal(press(surface, "Delete", { repeat }), false);
        const from = posToDom(host, 2), to = posToDom(host, 3);
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        assert.equal(input(surface, "deleteContentForward", null, range), true);
      }
      window.dispatchEvent(new window.Event("pagehide"));
      await agreed([["r1", "aZd"]]);
      for (const [key, text, offset] of [["z", "aZbcd", 2], ["z", "abcd", 1], ["y", "aZbcd", 2], ["y", "aZd", 2]]) {
        const target = pageHistory ? document.body : view === "Writer" ? beat("r1") : document.activeElement;
        assert.equal(press(target, key, { ctrlKey: true }), true);
        assert.deepEqual(selection(view), expectedSelection(view, offset), key + " " + text);
        await agreed([["r1", text]]);
      }
      leave([["r1", "aZd"]]);
    });
  }

  test(`${view}: replacing bc with Z restores the original selection on each undo`, async t => {
    await enter(t, [["r1", "abcd"]]);
    if (view === "Writer") writer.openWriter();
    place(view, 1, 3);
    assert.equal(input(document.activeElement, "insertText", "Z"), true);
    window.dispatchEvent(new window.Event("pagehide"));
    await agreed([["r1", "aZd"]]);
    for (const [key, text, from, to] of [["z", "abcd", 1, 3], ["y", "aZd", 2, 2], ["z", "abcd", 1, 3]]) {
      assert.equal(document.activeElement, view === "Writer" ? root() : cell());
      assert.equal(press(document.activeElement, key, { ctrlKey: true }), true);
      assert.deepEqual(selection(view), expectedSelection(view, from, to));
      await agreed([["r1", text]]);
    }
    leave([["r1", "abcd"]]);
  });
}

test("Writer: undo and redo of Enter in abcd replay the original and new beat carets", async t => {
  const rows = [["r1", "abcd"], ["r2", "ef"]];
  await enter(t, rows);
  writer.openWriter();
  place("Writer", 2);
  assert.equal(press(root(), "Enter"), true);
  const added = currentDocument().rows[1].id;
  assert.ok(!rows.some(([id]) => id === added));
  const split = [["r1", "ab"], [added, "cd"], ["r2", "ef"]];
  await agreed(split);
  assert.deepEqual(selection("Writer"), expectedSelection("Writer", 0, 0, added));
  for (const [key, expected, id, at] of [["z", rows, "r1", 2], ["y", split, added, 0], ["z", rows, "r1", 2]]) {
    assert.equal(press(root(), key, { ctrlKey: true }), true);
    assert.deepEqual(selection("Writer"), expectedSelection("Writer", at, at, id));
    await agreed(expected);
  }
  leave(rows);
});

function flushInput() {
  window.dispatchEvent(new window.Event("pagehide"));
}

function typeWriter(text) {
  for (const letter of text) assert.equal(input(root(), "insertText", letter), true);
}

function refuseBadPeerBytes(editor, peer) {
  for (const target of [editor, peer]) {
    const before = target.encodeState();
    for (const bytes of [Uint8Array.of(1), Uint8Array.of(1, 2, 3)]) {
      assert.throws(() => applyNativePeerUpdate(target, bytes), /Unexpected end of array/);
      assert.deepEqual(target.encodeState(), before);
    }
  }
}

test("Writer: a peer prefix and local typing both survive unusable peer bytes", async t => {
  const { editor, peer } = await enterWithPeer(t);
  writer.openWriter();
  type(peer, "r1", 0, "Y");
  assert.equal(applyNativePeerUpdate(editor, peer.encodeState()), true);
  await agreedWithPeer(editor, peer, [["r1", "YHello"], ["r2", "World"]]);
  refuseBadPeerBytes(editor, peer);
  await agreedWithPeer(editor, peer, [["r1", "YHello"], ["r2", "World"]]);
  place("Writer", 6);
  typeWriter("?");
  flushInput();
  assert.equal(applyNativePeerUpdate(peer, editor.encodeState()), true);
  await agreedWithPeer(editor, peer, [["r1", "YHello?"], ["r2", "World"]]);
  writer.closeWriter();
});

test("Writer: one typed character changes just its beat", async t => {
  await enter(t);
  writer.openWriter();
  place("Writer", 5);
  typeWriter("!");
  flushInput();
  await agreed([["r1", "Hello!"], ["r2", "World"]]);
  leave([["r1", "Hello!"], ["r2", "World"]]);
});

test("Writer: both characters land when an earlier keyup listener stops propagation", async t => {
  await enter(t);
  writer.openWriter();
  place("Writer", 5);
  const target = root();
  let stopped = 0, later = 0, bubbled = 0;
  const listen = new window.AbortController();
  t.after(() => listen.abort());
  target.addEventListener("keyup", event => { stopped++; event.stopPropagation(); }, { signal: listen.signal });
  target.addEventListener("keyup", () => { later++; }, { signal: listen.signal });
  window.addEventListener("keyup", () => { bubbled++; }, { signal: listen.signal });
  for (const letter of "!?") {
    typeWriter(letter);
    target.dispatchEvent(new window.KeyboardEvent("keyup", { key: letter, bubbles: true }));
  }
  assert.deepEqual([stopped, later, bubbled], [2, 2, 0]);
  flushInput();
  await agreed([["r1", "Hello!?"], ["r2", "World"]]);
  leave([["r1", "Hello!?"], ["r2", "World"]]);
});

test("Writer to Split: buffered characters, peer prefixes, undo and two inserts all land", async t => {
  const { editor, peer } = await enterWithPeer(t);
  const originalIds = new Set(seed.map(([id]) => id));
  const exchange = () => {
    assert.equal(applyNativePeerUpdate(editor, peer.encodeState()), true);
    assert.equal(applyNativePeerUpdate(peer, editor.encodeState()), true);
  };
  writer.openWriter();
  place("Writer", 5);
  typeWriter("!");
  type(peer, "r2", 0, "Z");
  exchange();
  typeWriter("?");
  type(peer, "r2", 0, "Y");
  exchange();
  refuseBadPeerBytes(editor, peer);
  flushInput();
  exchange();
  await agreedWithPeer(editor, peer, [["r1", "Hello!?"], ["r2", "YZWorld"]]);
  assert.equal(press(root(), "z", { ctrlKey: true }), true);
  exchange();
  await agreedWithPeer(editor, peer, [["r1", "Hello"], ["r2", "YZWorld"]]);
  place("Writer", 5);
  assert.equal(press(root(), "Enter"), true);
  exchange();
  const first = [["r1", "Hello"], [newBeat, ""], ["r2", "YZWorld"]];
  for (const doc of [currentDocument(), peer.document()]) assert.deepEqual(snapshot(doc, originalIds), first);
  writer.closeWriter();
  place("Split", 5);
  assert.equal(input(cell(), "insertText", "%"), true);
  flushInput();
  exchange();
  const typed = [["r1", "Hello%"], [newBeat, ""], ["r2", "YZWorld"]];
  for (const doc of [currentDocument(), peer.document()]) assert.deepEqual(snapshot(doc, originalIds), typed);
  assert.equal(input(cell(), "insertText", "^"), true);
  type(peer, "r2", 0, "X");
  exchange();
  assert.equal(press(cell(), "Enter", { ctrlKey: true }), true);
  exchange();
  const expected = [["r1", "Hello%^"], [newBeat, ""], [newBeat, ""], ["r2", "XYZWorld"]];
  for (const doc of [currentDocument(), peer.document()]) assert.deepEqual(snapshot(doc, originalIds), expected);
});

test("Writer: a buffered key and valid peer update survive an unusable update", async t => {
  const { editor, peer } = await enterWithPeer(t);
  writer.openWriter();
  place("Writer", 5);
  typeWriter("!");
  refuseBadPeerBytes(editor, peer);
  await agreedWithPeer(editor, peer, seed);
  type(peer, "r2", 0, "€€€€");
  assert.equal(applyNativePeerUpdate(editor, peer.encodeState()), true);
  assert.deepEqual(snapshot(currentDocument()), seed);
  flushInput();
  assert.equal(applyNativePeerUpdate(peer, editor.encodeState()), true);
  await agreedWithPeer(editor, peer, [["r1", "Hello!"], ["r2", "€€€€World"]]);
  writer.closeWriter();
});

test("Writer: local typing survives a held three-edit peer delivery", async t => {
  await enter(t);
  const peer = hook.nativePeer;
  peer.hold();
  for (const [offset, letter] of [..."ABC"].entries()) written(peer.type("r2", offset, letter));
  writer.openWriter();
  place("Writer", 5);
  typeWriter("!");
  flushInput();
  assert.deepEqual(snapshot(hook.read().app), [["r1", "Hello!"], ["r2", "World"]]);
  assert.deepEqual(snapshot(hook.read().peer), [["r1", "Hello"], ["r2", "ABCWorld"]]);
  peer.deliver();
  await agreed([["r1", "Hello!"], ["r2", "ABCWorld"]]);
});

test("Writer: buffered typing keeps a held peer prefix and a later edit", async t => {
  const { editor, peer } = await enterWithPeer(t);
  writer.openWriter();
  place("Writer", 5);
  typeWriter("!");
  type(peer, "r2", 0, "€€€€");
  const held = peer.encodeState();
  type(peer, "r1", 0, "FUTURE");
  assert.equal(applyNativePeerUpdate(editor, held), true);
  assert.deepEqual(snapshot(currentDocument()), seed);
  flushInput();
  assert.deepEqual(snapshot(currentDocument()), [["r1", "Hello!"], ["r2", "€€€€World"]]);
  assert.deepEqual(snapshot(peer.document()), [["r1", "FUTUREHello"], ["r2", "€€€€World"]]);
  assert.equal(applyNativePeerUpdate(editor, peer.encodeState()), true);
  assert.equal(applyNativePeerUpdate(peer, editor.encodeState()), true);
  await agreedWithPeer(editor, peer, [["r1", "FUTUREHello!"], ["r2", "€€€€World"]]);
});

for (const afterSwitch of [false, true]) {
  test(`Writer: cross-beat bold leaves both beats unchanged ${afterSwitch ? "after switching to Split" : "through history presses"}`, async t => {
    const rows = [["r1", "abcd"], ["r2", "efgh"]];
    await enter(t, rows);
    const show = t.mock.method(notices, "show", () => {});
    writer.openWriter();
    place("Writer", 2, 2, "r1", "r2");
    assert.equal(press(beat("r1"), "b", { ctrlKey: true }), true);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), refused);
    assert.deepEqual(selection("Writer"), expectedSelection("Writer", 2, 2, "r1", "r2"));
    await agreed(rows);
    if (afterSwitch) {
      writer.closeWriter();
      assert.deepEqual(selection("Split"), expectedSelection("Split", 2, 2, "r2"));
    }
    for (const key of ["z", "y", "z"]) {
      assert.equal(press(afterSwitch ? document.body : beat("r1"), key, { ctrlKey: true }), true);
      await agreed(rows);
      if (afterSwitch) assert.deepEqual(selection("Split"), expectedSelection("Split", 2, 2, "r2"));
      else assert.deepEqual(selection("Writer"), expectedSelection("Writer", 2, 2, "r1", "r2"));
    }
    assert.deepEqual(show.mock.calls.map(call => call.arguments), refused);
    leave(rows);
  });
}

test("Split: leaving Visual keys each typed B-roll line and shares the shots in one undo step", async t => {
  await enter(t, [["r1", "Hello", "Desk<br>Desk"], ["r2", "World"]]);
  const target = cell("r1", "visualText");
  target.focus();
  setCellSelection(target, 5);
  assert.equal(input(target, "insertText", "B-roll: "), true);
  window.dispatchEvent(new window.Event("pagehide"));
  setCellSelection(target, 0);
  for (const letter of "B-roll: ") assert.equal(input(target, "insertText", letter), true);
  cell("r2").focus();
  await new Promise(setImmediate);
  const { app, peer } = hook.read();
  assert.deepEqual(app, peer);
  assert.deepEqual(app.brollShots.map(shot => shot.name), ["Desk", "Desk"]);
  assert.equal(new Set(app.brollShots.map(shot => shot.id)).size, 2);
  assert.equal(cell("r1", "visualText").querySelectorAll('.broll-key[contenteditable="false"]').length, 2);
  written(hook.nativePeer.step("undo"));
  await Promise.resolve();
  const undone = hook.read();
  assert.deepEqual(undone.app, undone.peer);
  assert.equal(undone.app.rows[0].visualText, "B-roll: Desk<br>B-roll: Desk");
  assert.deepEqual(undone.app.brollShots, []);
  written(hook.nativePeer.step("redo"));
  await Promise.resolve();
  assert.deepEqual(hook.read().app, hook.read().peer);
  assert.equal(hook.read().app.rows[0].visualText, app.rows[0].visualText);
  assert.deepEqual(hook.read().app.brollShots, app.brollShots);
});

async function holdTwoBrollCloses(t, beforeClose = () => {}) {
  await enter(t, [["r1", "Hello", "Desk"], ["r2", "World"]]);
  const target = cell("r1", "visualText"), peer = hook.nativePeer;
  target.focus();
  setCellSelection(target, 0);
  assert.equal(input(target, "insertText", "B-roll: "), true);
  window.dispatchEvent(new window.Event("pagehide"));
  await new Promise(setImmediate);
  peer.hold("updates");
  beforeClose(peer);
  written(peer.closeBroll("r1"));
  const remote = hook.read().peer;
  cell("r2").focus();
  await new Promise(setImmediate);
  return { peer, remote };
}

test("an offline list shot and concurrent Visual closes keep the list shot and one keyed script shot", async t => {
  const { peer } = await holdTwoBrollCloses(t, p => written(p.registry({
    kind: "create", collection: "shots", fields: { name: "Desk" }
  })));
  peer.release("reverse");
  await new Promise(setImmediate);
  const { app, peer: replica } = hook.read();
  assert.deepEqual(app, replica);
  assert.deepEqual(app.brollShots.map(({ origin }) => origin).sort(), ["list", "script"]);
  assert.equal(cell("r1", "visualText").querySelectorAll(".broll-key").length, 1);
});

test("entering sharing preserves repeated legacy B-roll labels", async t => {
  const key = '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span>';
  const visualText = `${key} Desk<br>${key} Wide`, rows = [["r1", "Hello", visualText]];
  const migrated = docOf(rows);
  const doc = { ...migrated, rows: [{ ...migrated.rows[0], visualText }],
    brollShots: [{ ...migrated.brollShots[0], id: "S1" }] };
  const seed = openNativeSession({ kind: "document", document: doc, conversion: {
    cells: scriptCellOf, creation: doc.docId, at: "2026-11-20", by: "Writer"
  } }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(seed.close);
  await enter(t, rows, seed.encodeState());
  assert.equal(cell("r1", "visualText").querySelectorAll('.broll-key[data-broll-id="S1"]').length, 2);
  assert.deepEqual(hook.read().app, hook.read().peer);
  assert.equal(hook.read().app.rows[0].visualText, visualText);
});

test("ordinary edits beside a B-roll chip do not rescan the rendered cell for folds", () => {
  const label = { insert: { k: "bs-visual-1-2-3-4-0", label: "B-roll:" } };
  for (const text of [" Desk", " Desks", " Desk"]) {
    const delta = [label, { insert: text }];
    delta.map = function (callback) {
      const views = Array.prototype.map.call(this, callback);
      views.map = () => assert.fail("an unchanged marker must not trigger a second full-cell pass");
      return views;
    };
    assert.equal(nativeCellView(delta).runs[1].text, text);
  }
});

for (const [suffix, marker] of [["Desk", "B-roll:"], ["", "B-roll: "]]) {
  test(`Split: closing ${suffix ? "a joined marker and name" : "a nameless marker"} matches standalone`, async t => {
    await enter(t, [["r1", "Hello", suffix], ["r2", "World"]]);
    const target = cell("r1", "visualText");
    target.focus();
    setCellSelection(target, 0);
    assert.equal(input(target, "insertText", marker), true);
    cell("r2").focus();
    await new Promise(setImmediate);
    assert.equal(cell("r1", "visualText").querySelectorAll(".broll-key").length, 1);
    assert.match(hook.read().app.rows[0].visualText, new RegExp(`</span> ${suffix}$`));
    assert.deepEqual(hook.read().app.brollShots.map(({ name }) => name), suffix ? [suffix] : []);
    assert.deepEqual(hook.read().app, hook.read().peer);
  });
}

for (const note of ["Use the wide angle", "None"]) {
  test(`folded shot displays the ${note === "None" ? "literal None" : "alternate"} note and saves the ordinary shot shape`, async t => {
    const { peer, remote } = await holdTwoBrollCloses(t);
    written(peer.registry({ kind: "set", collection: "shots", ids: [remote.brollShots[0].id], fields: { notes: note } }));
    peer.release("duplicate");
    await new Promise(setImmediate);
    openBrollPanel();
    document.querySelector('#broll-panel [data-action="broll-expand"]').click();
    assert.match(document.getElementById("broll-panel").textContent, /Unmerged edit · Note/);
    const saved = JSON.parse(buildSplitpageCopy(captureExportDocument())).brollShots;
    const ordinary = docOf([["r1", "Hello", "B-roll: Desk"]]).brollShots[0];
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.keys(saved[0]).sort(), Object.keys(ordinary).sort());
    const primary = hook.read().app.brollShots[0];
    assert.deepEqual(nativeEditorRecords().registry.shotUnmergedEdits(primary.id), [{ field: "notes", value: primary.notes ? "Blank" : note }]);
  });
}

for (const order of ["forward", "reverse", "duplicate"]) {
  test(`Split: concurrent B-roll closes fold the same marker on both copies (${order})`, async t => {
    await enter(t, [["r1", "Hello", "Desk"], ["r2", "World"]]);
    const target = cell("r1", "visualText"), peer = hook.nativePeer;
    target.focus();
    setCellSelection(target, 0);
    assert.equal(input(target, "insertText", "B-roll: "), true);
    window.dispatchEvent(new window.Event("pagehide"));
    await new Promise(setImmediate);
    peer.hold("updates");
    written(peer.closeBroll("r1"));
    const peerId = hook.read().peer.brollShots[0].id;
    written(peer.registry({ kind: "set", collection: "shots", ids: [peerId], fields: { notes: "Use the wide angle" } }));
    cell("r2").focus();
    await new Promise(setImmediate);
    const appId = hook.read().app.brollShots[0].id;
    assert.notEqual(appId, peerId);
    peer.release(order);
    await new Promise(setImmediate);
    const agreedShot = (afterUndo = false) => {
      const { app, peer: remote } = hook.read();
      assert.deepEqual(app, remote);
      assert.deepEqual(app.brollShots.map(shot => shot.name), ["Desk"]);
      const entries = currentBrollRecords().brollEntries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, app.brollShots[0].id);
      if (afterUndo) assert.equal(cell("r1", "visualText").textContent.replace(/\u200b/g, ""), "B-roll:B-roll: Desk");
      else assert.equal(entries[0].name, "Desk");
      assert.equal(cell("r1", "visualText").querySelectorAll(".broll-key").length, 1);
      return app.brollShots[0];
    };
    const shot = agreedShot();
    assert.equal(shot.id, [appId, peerId].sort()[0]);
    assert.deepEqual(nativeEditorRecords().registry.shotUnmergedEdits(shot.id), [{ field: "notes", value: shot.id === peerId ? "Blank" : "Use the wide angle" }]);
    openBrollPanel();
    const card = document.querySelector('#broll-panel [data-action="broll-expand"]');
    assert.ok(card);
    card.click();
    assert.match(document.getElementById("broll-panel").textContent, /Unmerged edit · Note/);
    written(peer.registry({ kind: "set", collection: "shots", ids: [peerId], fields: { notes: "Keep this angle" } }));
    await new Promise(setImmediate);
    assert.equal(agreedShot().notes, "Keep this angle");
    assert.deepEqual(nativeEditorRecords().registry.shotUnmergedEdits(agreedShot().id), []);
    written(peer.undoPeer());
    await new Promise(setImmediate);
    assert.deepEqual(agreedShot(), shot);
    written(peer.step("undo"));
    await new Promise(setImmediate);
    assert.equal(agreedShot(true).id, peerId);
    written(peer.step("redo"));
    await new Promise(setImmediate);
    assert.equal(agreedShot().id, shot.id);
    written(peer.undoPeer());
    written(peer.undoPeer());
    await new Promise(setImmediate);
    assert.equal(agreedShot(true).id, appId);
    written(peer.redoPeer());
    written(peer.redoPeer());
    await new Promise(setImmediate);
    assert.deepEqual(agreedShot(), shot);
  });
}

for (const remove of [false, true]) {
  test(`Split: B-roll close racing a peer ${remove ? "beat deletion" : "line edit"}`, async t => {
    await enter(t, [["r1", "Hello", "Desk"], ["r2", "World"]]);
    const target = cell("r1", "visualText"), peer = hook.nativePeer;
    target.focus();
    setCellSelection(target, 0);
    assert.equal(input(target, "insertText", "B-roll: "), true);
    window.dispatchEvent(new window.Event("pagehide"));
    await new Promise(setImmediate);
    peer.hold("updates");
    if (remove) written(peer.removeBeat("r1"));
    else written(peer.type("r1", 12, " lamp", "visualText"));
    cell("r2").focus();
    await new Promise(setImmediate);
    peer.release("reverse");
    await new Promise(setImmediate);
    const { app, peer: remote } = hook.read();
    assert.deepEqual(app, remote);
    if (remove) {
      assert.ok(!app.rows.some(row => row.id === "r1"));
      written(peer.undoPeer());
      await new Promise(setImmediate);
      assert.deepEqual(hook.read().app, hook.read().peer);
      assert.match(hook.read().app.rows[0].visualText, /broll-key.*Desk/);
    } else {
      assert.match(app.rows[0].visualText, /broll-key.*Desk lamp/);
      assert.deepEqual(currentBrollRecords().brollEntries().map(({ name }) => name), ["Desk lamp"]);
      written(peer.step("undo"));
      await new Promise(setImmediate);
      assert.equal(hook.read().app.rows[0].visualText, "B-roll: Desk lamp");
      assert.deepEqual(hook.read().app, hook.read().peer);
    }
  });
}

for (const view of ["Writer"]) {
  test(`${view}: leaving a Visual edit keeps the typed B-roll line unkeyed`, async t => {
    await enter(t, [["r1", "Hello", "Close up"], ["r2", "World"]]);
    if (view === "Writer") {
      writer.openWriter();
      writer.writerFlowControl().openVisual("r1");
    }
    const box = document.querySelector(".wr-flow-visual-box");
    if (view === "Writer") assert.equal(box.hidden, false);
    const target = view === "Writer" ? box.querySelector(".wr-flow-visual-text") : cell("r1", "visualText");
    target.focus();
    setCellSelection(target, 0);
    for (const letter of "B-roll: ") assert.equal(input(target, "insertText", letter), true);
    assert.equal(target.textContent, "B-roll: Close up");
    assert.equal(hook.read().app.rows[0].visualText, "B-roll: Close up");
    await Promise.resolve();
    assert.equal(hook.read().peer.rows[0].visualText, "B-roll: Close up");
    if (view === "Writer") {
      press(target, "Escape");
      assert.equal(box.hidden, true);
    } else cell("r2").focus();
    await Promise.resolve();
    for (const copy of Object.values(hook.read())) {
      assert.equal(copy.rows[0].visualText, "B-roll: Close up");
      assert.deepEqual(copy.rows.map(row => row.audioText), ["Hello", "World"]);
    }
    assert.equal(target.querySelector(".broll-key"), null);
  });
}

test("native stored entry refuses empty, partial, truncated or unreadable bytes", async t => {
  const native = source(t);
  const vector = encodeStateVector(native.ydoc);
  type(native, "r1", 5, "?");
  type(native, "r1", 6, "!");
  const stored = native.encodeState();
  adoptReplacement(docOf([["local", "Still open", "Open visual"], ["local2", "Still here"]]));
  const before = hook.read(), listeners = listenerCounts();
  const history = undoOwner().sizes();
  t.mock.method(console, "error", () => {});
  for (const [name, bytes] of [
    ["empty", new Uint8Array([0, 0])],
    ["without its base", encodeStateAsUpdate(native.ydoc, vector)],
    ["truncated", stored.slice(0, Math.floor(stored.length / 2))],
    ["unreadable", new Uint8Array([1, 2, 3])]
  ]) {
    const result = await hook.enterFrom(bytes);
    if (result.ok) assert.deepEqual(hook.leave(), { ok: true });
    assert.deepEqual(result, { ok: false, reason: "enter-failed" }, name);
    assert.equal(sharedSession(), false);
    assert.deepEqual(hook.leave(), { ok: false, reason: "not-shared" }, name);
    assert.deepEqual(hook.read(), before, name);
    assert.deepEqual(listenerCounts(), listeners, name);
    assert.deepEqual(undoOwner().sizes(), history, name);
    assert.equal(sharedUndoRoute(), null, name);
  }
});

test("native stored entry with Writer open loads the edited snapshot and lands a fresh copy", async t => {
  const native = source(t, [["r1", "Hello", "Desk"], ["r2", "World", "Window"]]);
  type(native, "r1", 5, "?");
  type(native, "r1", 6, "!");
  const end = native.commands.anchorText({ beat: "r1", cell: "narration" }, 6, 7);
  assert.equal(end.kind, "anchored");
  written(native.commands.deleteText(end.range));
  written(native.commands.removeRows(["r2"]));
  const stored = native.encodeState();
  const expected = native.document();
  assert.deepEqual(snapshot(expected), [["r1", "Hello?"]]);

  writer.closeWriter();
  adoptReplacement(docOf([["local", "Still open", "Open visual"], ["local2", "Still here"]]));
  writer.openWriter();
  assert.equal(beat("local").textContent, "Still open");
  const sourceId = currentDocument().docId, listeners = listenerCounts();
  t.after(() => {
    if (sharedSession()) assert.deepEqual(hook.leave(), { ok: true });
    writer.closeWriter();
  });
  assert.deepEqual(await hook.enterFrom(btoa(String.fromCharCode(...stored))), { ok: true });
  assert.equal(sharedSession(), true);
  assert.deepEqual(hook.read(), { app: expected, peer: expected });
  assert.equal(beat("local"), null);
  assert.equal(beat("r1").textContent, "Hello?");
  assert.equal(appActions.has("recovery"), false);
  assert.equal(document.getElementById("shared-recovery-panel"), null);
  const undo = sharedUndoRoute().actions;
  assert.deepEqual(undo.undo(), { ok: false, empty: true });
  assert.deepEqual(undo.redo(), { ok: false, empty: true });
  assert.deepEqual(hook.read(), { app: expected, peer: expected });

  hook.nativePeer.hold();
  written(hook.nativePeer.type("r1", 0, "N"));
  assert.deepEqual(hook.read().app, expected);
  hook.nativePeer.deliver();
  await agreed([["r1", "NHello?"]]);
  assert.equal(beat("r1").textContent, "NHello?");
  const changed = hook.read().app;
  const reopened = openCopy(t, stored);
  assert.deepEqual(reopened.document(), expected);
  type(reopened, "r1", 0, "N");
  assert.deepEqual(changed, reopened.document());
  assert.deepEqual(hook.leave(), { ok: true });
  assert.equal(sharedSession(), false);
  const landed = hook.read();
  assert.notEqual(landed.app.docId, expected.docId);
  assert.notEqual(landed.app.docId, sourceId);
  assert.deepEqual(landed, { app: { ...changed, docId: landed.app.docId }, peer: null });
  assert.equal(beat("r1").textContent, "NHello?");
  assert.deepEqual(listenerCounts(), listeners);
});

test("Split: a peer prefix leaves the captured Find match replaceable on the first click", async t => {
  await enter(t, [["r1", "a cup of tea"]]);
  const show = t.mock.method(notices, "show", () => {});
  appActions.invoke("find", "command-menu");
  t.after(() => document.getElementById("find-close").click());
  const field = document.getElementById("find-input");
  field.value = "cup";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  document.getElementById("replace-input").value = "mug";
  written(hook.nativePeer.type("r1", 0, "X"));
  await agreed([["r1", "Xa cup of tea"]]);
  document.getElementById("find-replace").click();
  await agreed([["r1", "Xa mug of tea"]]);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), []);
  field.blur();
  assert.equal(press(document.body, "z", { ctrlKey: true }), true);
  await agreed([["r1", "Xa cup of tea"]]);
  leave([["r1", "Xa cup of tea"]]);
});
