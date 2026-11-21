import assert from "node:assert/strict";
import { after, test } from "node:test";
import { encodeStateAsUpdate, encodeStateVector } from "yjs";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { adoptReplacement, currentDocument, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml, scriptCellOf } from "../bootstrap/richtext.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { appActions } from "../bootstrap/wiring/ports/actions.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
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

async function enter(t, rows = seed, state) {
  writer.closeWriter();
  adoptReplacement(docOf(rows));
  assert.deepEqual(await (state ? hook.enterFrom(state) : hook.enter()), { ok: true });
  t.after(() => {
    writer.closeWriter();
    if (!sharedSession() || hook.leave().ok) return;
    forceLeaveSharedSession();
    const allowed = () => ({ allowed: true });
    adoptReplacement(docOf([]), createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
  });
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

function selection(view, originalIds) {
  if (view === "Writer") {
    const range = writer.writerFlowControl().selection();
    return range && [range.anchor, range.head].map(({ kind, rowId, offset }) => [kind, beatName(rowId, originalIds), offset]);
  }
  const active = document.activeElement;
  const range = cellSelection(active);
  return range && [range.from, range.to].map(offset => [active.dataset.field, active.dataset.id, offset]);
}

function expectedSelection(view, from, to = from, id = "r1", head = id) {
  const kind = view === "Writer" ? "beat" : "audioText";
  return [[kind, id, from], [kind, head, to]];
}

async function agreed(expected, originalIds) {
  await Promise.resolve();
  const { app, peer } = hook.read();
  assert.deepEqual(snapshot(app, originalIds), expected, "editor");
  assert.deepEqual(snapshot(peer, originalIds), expected, "peer");
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
  const fixture = entrySwitchFixture();
  adoptReplacement(docOf(seed));
  let editor;
  const { ports, errors } = fixture;
  const result = await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    editor = opened.native;
    return opened.backend;
  });
  assert.deepEqual(result, { ok: true }, errors.map(String).join("\n"));
  t.after(() => assert.deepEqual(leaveRunningSharedSession(), { ok: true }));
  const peer = openCopy(t, editor.encodeState());
  return { editor, peer };
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
      for (const doc of [currentDocument(), editor.document(), peer.document(), late.document()]) {
        assert.deepEqual(snapshot(doc), rows);
      }
      if (rows !== seed) written(peer.commands.undo());
    }
  });
}

test("native peer cannot split or insert at a missing beat, or join beyond the last beat", async t => {
  const { editor, peer } = await enterWithPeer(t);
  const updates = [];
  peer.ydoc.on("update", update => updates.push(update));
  assert.deepEqual(peer.commands.anchorText({ beat: "gone", cell: "narration" }, 1), { kind: "refused", reason: "missing" });
  assert.deepEqual(peer.commands.insertAdjacentBeat("gone", "below"), { kind: "refused", reason: "missing" });
  assert.equal(peer.commands.joinRow("gone", "r2", " ").kind, "refused");
  assert.deepEqual(peer.commands.undo(), { kind: "unchanged" });
  assert.deepEqual(updates, []);
  assert.equal(applyNativePeerUpdate(editor, peer.encodeState()), true);
  await Promise.resolve();
  for (const doc of [currentDocument(), editor.document(), peer.document()]) assert.deepEqual(snapshot(doc), seed);
});

test("Split: anchored insert, undo and redo each publish one change", async t => {
  await enter(t);
  const originalIds = new Set(seed.map(([id]) => id));
  const changes = [];
  t.after(onSessionChange(change => changes.push(change)));
  place("Split", 1, 1, "r2");
  assert.equal(press(cell("r2"), "Enter", { ctrlKey: true }), true);
  const inserted = [...seed, [newBeat, ""]];
  await agreed(inserted, originalIds);
  assert.equal(changes.length, 1);
  assert.equal(press(document.activeElement, "z", { ctrlKey: true }), true);
  await agreed(seed);
  assert.equal(changes.length, 2);
  assert.equal(press(document.activeElement, "y", { ctrlKey: true }), true);
  await agreed(inserted, originalIds);
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
  for (const glue of [false, true]) test(`${view}: deleting ${glue ? "synthetic join space" : "across joined members"} stops at the uncommitted preview`, async t => {
    const rows = glue ? [["r1", "a "], ["r2", " b"]] : [["r1", "abcd"], ["r2", "ef"]];
    const [from, to] = glue ? [2, 3] : [2, 6];
    const joined = source(t, rows);
    written(joined.commands.joinRow("r2", "r1", " "));
    await enter(t, rows, joined.encodeState());
    const show = t.mock.method(notices, "show", () => {});
    t.mock.method(console, "error", () => {});
    if (view === "Writer") writer.openWriter();
    const surface = view === "Writer" ? root() : cell();
    place(view, from, to);
    const range = document.getSelection().getRangeAt(0).cloneRange();
    assert.equal(input(surface, "deleteContentBackward", null, range), true);
    const original = rows.map(([, text]) => text).join(" ");
    const preview = original.slice(0, from) + original.slice(to);
    await agreed([["r1", original]]);
    assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), refused);
    assert.equal((view === "Writer" ? beat("r1") : cell()).textContent.replaceAll("\u00a0", " "), preview);
    assert.deepEqual(selection(view), expectedSelection(view, from));
    assert.equal(press(surface, "z", { ctrlKey: true }), true);
    assert.deepEqual(selection(view), expectedSelection(view, from));
    assert.equal(hook.leave().ok, false);
    await agreed([["r1", original]]);
  });

  test(`${view}: typing and two forward Deletes undo in separate steps from the editing surface`, async t => {
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
      assert.equal(press(document.activeElement, key, { ctrlKey: true }), true);
      assert.deepEqual(selection(view), expectedSelection(view, offset), key + " " + text);
      await agreed([["r1", text]]);
    }
  });

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
  });
}

test("Writer: undo and redo of Enter in abcd replay the original and new beat carets", async t => {
  const rows = [["r1", "abcd"], ["r2", "ef"]];
  const originalIds = new Set(rows.map(([id]) => id));
  await enter(t, rows);
  writer.openWriter();
  place("Writer", 2);
  assert.equal(press(root(), "Enter"), true);
  const split = [["r1", "ab"], [newBeat, "cd"], ["r2", "ef"]];
  await agreed(split, originalIds);
  assert.deepEqual(selection("Writer", originalIds), expectedSelection("Writer", 0, 0, newBeat));
  for (const [key, expected, id, at] of [["z", rows, "r1", 2], ["y", split, newBeat, 0], ["z", rows, "r1", 2]]) {
    assert.equal(press(root(), key, { ctrlKey: true }), true);
    assert.deepEqual(selection("Writer", originalIds), expectedSelection("Writer", at, at, id));
    await agreed(expected, originalIds);
  }
});

for (const afterSwitch of [false, true]) {
  test(`Writer: cross-beat bold leaves both beats unchanged ${afterSwitch ? "after switching to Split" : "through history presses"}`, async t => {
    const rows = [["r1", "abcd"], ["r2", "efgh"]];
    await enter(t, rows);
    const show = t.mock.method(notices, "show", () => {});
    writer.openWriter();
    place("Writer", 2, 2, "r1", "r2");
    assert.equal(press(root(), "b", { ctrlKey: true }), true);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), refused);
    assert.deepEqual(selection("Writer"), expectedSelection("Writer", 2, 2, "r1", "r2"));
    await agreed(rows);
    if (afterSwitch) writer.closeWriter();
    for (const key of ["z", "y", "z"]) {
      assert.equal(press(afterSwitch ? document.body : root(), key, { ctrlKey: true }), true);
      await agreed(rows);
      if (!afterSwitch) assert.deepEqual(selection("Writer"), expectedSelection("Writer", 2, 2, "r1", "r2"));
    }
    assert.deepEqual(show.mock.calls.map(call => call.arguments), refused);
  });
}

for (const view of ["Split", "Writer"]) {
  test(`${view}: leaving a Visual edit keeps the typed B-roll line unkeyed`, async t => {
    await enter(t, [["r1", "Hello", "Close up"], ["r2", "World"]]);
    if (view === "Writer") {
      writer.openWriter();
      writer.writerFlowControl().openVisual("r1");
    }
    const box = document.querySelector(".wr-flow-visual-box");
    const target = view === "Writer" ? box.querySelector(".wr-flow-visual-text") : cell("r1", "visualText");
    target.focus();
    setCellSelection(target, 0);
    for (const letter of "B-roll: ") assert.equal(input(target, "insertText", letter), true);
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
  const rows = [["local", "Still open"]];
  adoptReplacement(docOf(rows));
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
    assert.deepEqual(snapshot(hook.read().app), rows);
    assert.equal(hook.read().peer, null);
  }
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
});
