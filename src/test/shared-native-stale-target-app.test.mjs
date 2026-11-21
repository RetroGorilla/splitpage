import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { sanitizeHtml } from "../bootstrap/richtext.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";
import { setTimeout as delay } from "node:timers/promises";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const source = [
  { id: "r1", audioText: "Lead", visualText: "First" },
  { id: "r2", audioText: "World", visualText: "Scene" },
  { id: "r3", audioText: "Tail", visualText: "Final" }
];
const unavailable = "native-input-unavailable";
const pending = "native-input-pending";
const tick = () => Promise.resolve();
const text = node => node.textContent.replace(/\u200b/g, "");
const shape = doc => doc.rows.map(({ id, audioText, visualText }) => [id, audioText, visualText]);

function written(result) {
  assert.equal(result.kind, "written");
  return result;
}

function send(from, to) {
  assert.equal(applyNativePeerUpdate(to, from.encodeState()), true);
}

function clone(native, t) {
  const peer = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml });
  t.after(peer.close);
  return peer;
}

function split(native, beat, offset) {
  const at = native.commands.anchorText({ beat, cell: "narration" }, offset);
  assert.equal(at.kind, "anchored");
  return written(native.commands.splitRow(at.range)).created;
}

async function enter(t, view, field, state = "live") {
  const fixture = entrySwitchFixture();
  const refuse = t.mock.fn();
  const ports = { ...fixture.ports, commandRefused: refuse };
  adoptReplacement(migrateRows({ schema: 2, title: "Stale targets", rows: source }));
  let native;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  const controls = writerControls();
  t.after(() => {
    if (sharedSession() && !leaveRunningSharedSession().ok) {
      forceLeaveSharedSession();
      const allowed = () => ({ allowed: true });
      adoptReplacement(migrateRows({ title: "Standby", rows: [] }),
        createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
    }
    controls.closeWriter();
  });
  const peer = clone(native, t);
  const id = state === "hidden" ? split(peer, "r2", 0) : "r2";
  if (state === "hidden") {
    const visual = clone(peer, t);
    const at = visual.commands.anchorText({ beat: id, cell: "visual" }, 0);
    assert.equal(at.kind, "anchored");
    written(visual.commands.typeText(at.range, "Scene", {}));
    send(visual, peer);
    send(peer, native);
    await tick();
  }
  const editor = () => document.querySelector(view === "Writer" && field === "narration"
    ? `#writer-doc .wr-beat[data-id="${id}"]`
    : view === "Writer" ? `#writer .wr-flow-visual-text[data-id="${id}"]`
      : `#rows .cell-editable[data-id="${id}"][data-field="${field === "visual" ? "visualText" : "audioText"}"]`);
  let target;
  if (view === "Writer") {
    controls.openWriter();
    const flow = controls.writerFlowControl();
    if (field === "visual") flow.openVisual(id);
    target = field === "narration" ? document.getElementById("writer-doc") : editor();
  } else target = editor();
  target.focus();
  setCellSelection(editor(), 2);
  return { native, peer, id, editor, get target() { return view === "Writer" && field === "narration" ? target : editor(); },
    refuse, errors: fixture.errors };
}

function input(target, inputType, data, options = {}) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data, ...options });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function composition(target, stage, data = "") {
  const event = new window.CompositionEvent("composition" + stage, { bubbles: true, cancelable: true, data });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function beginComposition(target, value) {
  assert.equal(composition(target, "start"), false);
  composition(target, "update", value);
  const selection = document.getSelection(), range = selection.getRangeAt(0);
  const candidate = document.createTextNode(value);
  range.deleteContents();
  range.insertNode(candidate);
  selection.setBaseAndExtent(candidate, value.length, candidate, value.length);
  target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: value, isComposing: true }));
}

function key(target, name, options) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: name, ...options });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function transfer(target, type, plain = false) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  const write = () => assert.fail("Refused clipboard route wrote data");
  Object.defineProperty(event, type === "drop" ? "dataTransfer" : "clipboardData", { value: {
    files: [], types: plain ? ["text/plain"] : ["text/plain", "text/html"],
    getData: format => format === "text/plain" ? "paste" : "<strong>paste</strong>",
    setData: write
  } });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function reasons(f) {
  return f.refuse.mock.calls.map(call => call.arguments[0]);
}

function peerChange(t, { native, peer, id }, state) {
  if (state === "hidden") {
    const remover = clone(peer, t);
    written(remover.commands.removeRows([id]));
    send(remover, peer);
    send(remover, native);
    written(peer.commands.undo());
    send(peer, remover);
    written(remover.commands.undo());
    send(remover, peer);
  } else {
    written(peer.commands.removeRows([id]));
    if (state === "replaced") written(peer.commands.insertAdjacentBeat("r1", "below"));
    if (state === "restored") {
      send(peer, native);
      assert.equal(native.document().rows.some(row => row.id === id), false);
      written(peer.commands.undo());
    }
  }
  send(peer, native);
}

for (const view of ["Split", "Writer"]) for (const field of ["narration", "visual"]) {
  for (const mode of field === "visual" ? ["composition"] : ["buffered typing", "composition"]) {
    for (const state of ["removed", "replaced", "restored", "hidden"]) {
      test(`${view} ${field}: ${mode} when the peer has ${state} the target`, async t => {
        const f = await enter(t, view, field, state);
        const shown = f.editor(), before = text(shown), preview = before.slice(0, 2) + "X" + before.slice(2);
        const original = shape(currentDocument());
        if (mode === "composition") beginComposition(f.target, "X");
        else assert.equal(input(f.target, "insertText", "X"), true);
        assert.equal(text(shown), preview);
        assert.deepEqual(shape(f.native.document()), original);
        peerChange(t, f, state);
        await tick();
        assert.deepEqual(shape(currentDocument()), original, "pending input holds the published projection");
        assert.ok(shown.isConnected);
        const peerOnly = shape(f.peer.document());
        const peerState = f.native.encodeState();
        assert.deepEqual(shape(f.native.document()), peerOnly);
        assert.equal(peerOnly.some(([id]) => id === f.id), state === "restored");
        if (state === "hidden") assert.deepEqual(peerOnly[1], ["r2", "World", "Scene"]);
        if (state === "replaced") {
          assert.equal(peerOnly.length, original.length);
          assert.deepEqual(peerOnly[1].slice(1), ["", ""]);
        }
        if (mode === "composition") composition(f.target, "end", "X");
        else await delay(55);
        await tick();
        assert.deepEqual(f.errors, []);
        if (state === "restored") {
          const column = field === "narration" ? 1 : 2;
          const restored = field === "narration" ? before + "X" : preview;
          const expected = peerOnly.map(row => row[0] === f.id ? row.with(column, restored) : row);
          send(f.native, f.peer);
          assert.deepEqual(shape(f.peer.document()), expected);
          assert.deepEqual(shape(currentDocument()), expected);
          assert.equal(text(f.editor()), restored);
          assert.deepEqual(f.refuse.mock.calls, []);
          return;
        }
        if (mode === "buffered typing" && (state === "removed" || state === "replaced")) {
          const expected = peerOnly.map(row => row[0] === "r1" ? row.with(1, row[1] + "X") : row);
          send(f.native, f.peer);
          assert.deepEqual(shape(f.peer.document()), expected);
          assert.deepEqual(shape(f.native.document()), expected);
          assert.deepEqual(shape(currentDocument()), expected);
          assert.equal(shown.isConnected, false);
          assert.deepEqual(reasons(f), []);
          assert.deepEqual(leaveRunningSharedSession(), { ok: true });
          assert.deepEqual(shape(currentDocument()), expected);
          return;
        }
        assert.deepEqual(shape(f.native.document()), peerOnly);
        assert.deepEqual(shape(currentDocument()), original);
        assert.ok(shown.isConnected);
        assert.equal(text(shown), preview);
        assert.deepEqual(reasons(f), ["missing"]);
        assert.equal(input(f.target, "insertText", "Y"), true);
        assert.equal(text(shown), preview);
        assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "missing" });
        assert.deepEqual(f.native.encodeState(), peerState);
      });
    }
  }
}

for (const view of ["Split", "Writer"]) for (const field of ["narration", "visual"]) {
  test(`${view} ${field}: composing keys and key 229 stay out of the editor handlers`, async t => {
    const f = await enter(t, view, field), shown = f.editor();
    const before = f.native.encodeState(), listener = t.mock.fn(), target = f.target;
    target.addEventListener("keydown", listener);
    t.after(() => target.removeEventListener("keydown", listener));
    for (const name of ["Enter", "Backspace", "Escape", "ArrowLeft"]) {
      for (const inputType of ["insertParagraph", "insertLineBreak"]) {
        assert.equal(key(f.target, name, { keyCode: 229 }), false);
        assert.equal(input(f.target, inputType, null), true);
      }
    }
    assert.deepEqual(reasons(f), Array(8).fill(unavailable));
    f.refuse.mock.resetCalls();
    beginComposition(f.target, "X");
    for (const name of ["Enter", "Backspace", "Escape", "ArrowLeft"]) {
      for (const signal of [{ isComposing: true }, { keyCode: 229 }]) {
        const cancelled = name === "Enter";
        assert.equal(key(f.target, name, signal), cancelled);
      }
    }
    assert.equal(listener.mock.callCount(), 0);
    assert.deepEqual(reasons(f), []);
    assert.deepEqual(f.native.encodeState(), before);
    const preview = text(shown);
    composition(f.target, "end", "X");
    const column = field === "narration" ? 1 : 2;
    assert.equal(shape(currentDocument()).find(row => row[0] === f.id)[column], preview);
    assert.deepEqual(f.errors, []);
  });

  for (const direction of ["forward", "reverse"]) {
    test(`${view} ${field}: drained removal during composition with ${direction} delivery`, async t => {
      const f = await enter(t, view, field), shown = f.editor();
      beginComposition(f.target, "X");
      const preview = text(shown);
      written(f.peer.commands.removeRows([f.id]));
      const removal = f.peer.encodeState();
      const at = f.peer.commands.anchorText({ beat: "r3", cell: "narration" }, 0);
      assert.equal(at.kind, "anchored");
      written(f.peer.commands.typeText(at.range, "Z", {}));
      const later = f.peer.encodeState();
      const updates = direction === "forward" ? [removal, later] : [later, removal];
      for (const update of updates) assert.equal(applyNativePeerUpdate(f.native, update), true);
      await tick();
      composition(f.target, "end", "X");
      assert.deepEqual(shape(f.native.document()), [["r1", "Lead", "First"], ["r3", "ZTail", "Final"]]);
      assert.equal(currentDocument().rows[1].id, f.id);
      assert.ok(shown.isConnected);
      assert.equal(text(shown), preview);
      assert.deepEqual(reasons(f), ["missing"]);
      assert.deepEqual(f.errors, []);
    });
  }

  for (const state of field === "visual" ? ["caret", "selection", "composition"] : ["caret", "selection", "buffered typing", "composition"]) {
    test(`${view} ${field}: unsupported transfer and editing routes preserve ${state}`, async t => {
      const f = await enter(t, view, field), shown = f.editor();
      if (state === "selection") setCellSelection(shown, 1, 3);
      if (state === "buffered typing") assert.equal(input(f.target, "insertText", "X"), true);
      if (state === "composition") beginComposition(f.target, "X");
      const before = f.native.encodeState(), html = shown.innerHTML, active = document.activeElement;
      const selection = document.getSelection();
      const endpoints = () => [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
      const saved = endpoints();
      for (const type of ["paste", "cut", "drop"]) assert.equal(transfer(f.target, type), true);
      const other = view === "Writer" ? document.querySelector('#writer-doc .wr-beat[data-id="r3"]')
        : document.querySelector(`#rows .cell-editable[data-id="r3"][data-field="${field === "narration" ? "audioText" : "visualText"}"]`);
      if (other) assert.equal(transfer(other, "drop"), true);
      const unsupported = ["insertFromPaste", "insertFromDrop", "deleteByCut", "deleteByDrag",
        "insertOrderedList", "insertUnorderedList", "insertTranspose"];
      for (const type of unsupported) assert.equal(input(f.target, type, null), true);
      const transferCount = other ? 4 : 3;
      assert.deepEqual(reasons(f), state === "composition" ? [...Array(transferCount).fill(unavailable), pending]
        : Array(unsupported.length + transferCount).fill(unavailable));
      assert.equal(shown.innerHTML, html);
      assert.equal(document.activeElement, active);
      assert.deepEqual(endpoints(), saved);
      assert.deepEqual(f.native.encodeState(), before);
      if (state === "composition") composition(f.target, "end", "X");
      if (state === "buffered typing") window.dispatchEvent(new window.Event("pagehide"));
      assert.equal(text(f.editor()), state === "composition" || state === "buffered typing"
        ? field === "narration" ? "WoXrld" : "ScXene"
        : field === "narration" ? "World" : "Scene");
      assert.deepEqual(f.errors, []);
    });
  }

  test(`${view} ${field}: plain typing on stale paint retains the preview at its input event`, async t => {
    const f = await enter(t, view, field), shown = f.editor();
    const at = f.peer.commands.anchorText({ beat: f.id, cell: field }, 0);
    assert.equal(at.kind, "anchored");
    written(f.peer.commands.typeText(at.range, "Z", {}));
    send(f.peer, f.native);
    const before = text(shown), character = "\u00a0";
    assert.equal(input(f.target, "insertText", character), true);
    assert.deepEqual(reasons(f), ["native-selection-stale"]);
    assert.equal(text(shown), before.slice(0, 2) + character + before.slice(2));
    await tick();
    const column = field === "narration" ? 1 : 2;
    assert.equal(shape(currentDocument())[1][column], before);
    assert.equal(shape(f.native.document())[1][column], "Z" + before);
    assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "native-selection-stale" });
    assert.deepEqual(f.errors, []);
  });

  for (const [name, tag, shortcut] of [["Bold", "strong", "b"], ["Italic", "em", "i"], ["Underline", "u", "u"]]) {
    test(`${view} ${field}: ${name} refuses at a caret and formats an addressable selection`, async t => {
      const f = await enter(t, view, field);
      const original = text(f.editor()), column = field === "narration" ? 1 : 2;
      const value = () => shape(currentDocument())[1][column];
      assert.equal(key(f.target, shortcut, { ctrlKey: true }), true);
      assert.equal(value(), original);
      assert.deepEqual(reasons(f), [unavailable]);
      setCellSelection(f.editor(), 1, 3);
      assert.equal(input(f.target, "format" + name, null), true);
      assert.equal(value(), `${original[0]}<${tag}>${original.slice(1, 3)}</${tag}>${original.slice(3)}`);
      assert.equal(input(f.target, "historyUndo", null), true);
      assert.equal(value(), original);
      assert.equal(input(f.target, "historyRedo", null), true);
      assert.match(value(), new RegExp("<" + tag + ">"));
      assert.deepEqual(reasons(f), [unavailable]);
      assert.deepEqual(f.errors, []);
    });
  }

  test(`${view} ${field}: plain paste and a line break replace the live selection`, async t => {
    const f = await enter(t, view, field);
    const original = text(f.editor()), column = field === "narration" ? 1 : 2;
    setCellSelection(f.editor(), 1, 3);
    assert.equal(transfer(f.target, "paste", true), true);
    assert.equal(shape(currentDocument())[1][column], original[0] + "paste" + original.slice(3));
    setCellSelection(f.editor(), 1, 6);
    assert.equal(input(f.target, "insertLineBreak", null), true);
    assert.equal(shape(currentDocument())[1][column], original[0] + "<br>" + original.slice(3));
    assert.deepEqual(reasons(f), []);
    assert.deepEqual(f.errors, []);
  });
}

for (const field of ["narration", "visual"]) {
  test(`Writer ${field}: close ${field === "narration" ? "keeps typing from a removed beat" : "keeps a refused composition visible"}`, async t => {
    const f = await enter(t, "Writer", field), shown = f.editor();
    if (field === "visual") beginComposition(f.target, "X");
    else assert.equal(input(f.target, "insertText", "X"), true);
    peerChange(t, f, "removed");
    if (field === "visual") composition(f.target, "end", "X");
    writerControls().closeWriter();
    if (field === "visual") {
      assert.equal(document.getElementById("writer").hidden, false);
      assert.ok(shown.isConnected);
      assert.equal(text(shown), "ScXene");
      assert.deepEqual(reasons(f), ["missing"]);
    } else {
      assert.equal(document.getElementById("writer").hidden, true);
      assert.equal(shown.isConnected, false);
      send(f.native, f.peer);
      assert.deepEqual(shape(currentDocument()), shape(f.peer.document()));
      assert.deepEqual(shape(currentDocument()), [["r1", "LeadX", "First"], ["r3", "Tail", "Final"]]);
      assert.deepEqual(reasons(f), []);
    }
    assert.deepEqual(f.errors, []);
  });
}

test("Split Visual: Alt+Enter refuses while Ctrl+Enter inserts a blank at the live anchor", async t => {
  const f = await enter(t, "Split", "visual");
  assert.equal(key(f.target, "Enter", { altKey: true }), true);
  assert.deepEqual(shape(currentDocument()), shape(f.peer.document()));
  assert.deepEqual(reasons(f), [unavailable]);
  assert.equal(key(f.target, "Enter", { ctrlKey: true }), true);
  const created = currentDocument().rows[2];
  assert.notEqual(created.id, "r3");
  assert.deepEqual([created.audioText, created.visualText], ["", ""]);
  assert.equal(document.activeElement.dataset.id, created.id);
  assert.equal(document.activeElement.dataset.field, "visualText");
  assert.deepEqual(reasons(f), [unavailable]);
});

for (const view of ["Split", "Writer"]) {
  for (const state of ["removed", "replaced", "restored", "hidden"]) {
    test(`${view} Visual: plain typing is synchronous when the peer has ${state} the painted target`, async t => {
      const f = await enter(t, view, "visual", state), shown = f.editor();
      const original = shape(currentDocument());
      peerChange(t, f, state);
      assert.deepEqual(shape(currentDocument()), original);
      const stateBeforeTyping = f.native.encodeState();
      assert.equal(input(f.target, "insertText", "X"), true);
      assert.equal(text(shown), "ScXene");
      if (state === "restored") {
        assert.equal(shape(currentDocument()).find(row => row[0] === f.id)[2], "ScXene");
        send(f.native, f.peer);
        assert.deepEqual(shape(currentDocument()), shape(f.peer.document()));
        assert.deepEqual(reasons(f), []);
      } else {
        assert.deepEqual(f.native.encodeState(), stateBeforeTyping);
        assert.deepEqual(shape(currentDocument()), original);
        assert.ok(shown.isConnected);
        assert.deepEqual(reasons(f), ["native-selection-stale"]);
      }
      assert.deepEqual(f.errors, []);
    });
  }

  test(`${view}: a structure press on a removed beat writes only the pending typing`, async t => {
    const f = await enter(t, view, "narration"), shown = f.editor();
    assert.equal(input(f.target, "insertText", "X"), true);
    peerChange(t, f, "removed");
    const split = () => key(f.target, "Enter", { altKey: view === "Split" });
    assert.equal(split(), true);
    assert.deepEqual(reasons(f), []);
    send(f.native, f.peer);
    const expected = [["r1", "LeadX", "First"], ["r3", "Tail", "Final"]];
    assert.deepEqual(shape(f.peer.document()), expected);
    assert.deepEqual(shape(currentDocument()), expected);
    assert.equal(shown.isConnected, false);
    if (view === "Writer") {
      writerControls().closeWriter();
      assert.equal(document.getElementById("writer").hidden, true);
    }
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    assert.deepEqual(shape(currentDocument()), expected);
    assert.deepEqual(f.errors, []);
  });

  test(`${view}: a peer field edit paints together with a committed composition`, async t => {
    const f = await enter(t, view, "narration");
    setCellSelection(f.editor(), 1, 3);
    beginComposition(f.target, "X");
    written(f.peer.commands.setField({ kind: "beat", id: "r3", field: "lengthSeconds" }, 9));
    send(f.peer, f.native);
    await tick();
    assert.equal(currentDocument().rows[2].lengthSeconds, undefined);
    assert.equal(text(f.editor()), "WXld");
    composition(f.target, "end", "X");
    send(f.native, f.peer);
    assert.equal(currentDocument().rows[2].lengthSeconds, 9);
    assert.equal(currentDocument().rows[1].audioText, "WXld");
    assert.equal(text(f.editor()), "WXld");
    assert.deepEqual(shape(currentDocument()), shape(f.peer.document()));
    assert.deepEqual(reasons(f), []);
    assert.deepEqual(f.errors, []);
  });
}
