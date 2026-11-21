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

async function enter(t, view, field, state) {
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
    controls.closeWriter();
    if (!sharedSession() || leaveRunningSharedSession().ok) return;
    forceLeaveSharedSession();
    const allowed = () => ({ allowed: true });
    adoptReplacement(migrateRows({ title: "Standby", rows: [] }),
      createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
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
  return { native, peer, id, editor, target, refuse, errors: fixture.errors };
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
        assert.deepEqual(shape(f.native.document()), peerOnly);
        assert.deepEqual(shape(currentDocument()), original);
        assert.ok(shown.isConnected);
        assert.equal(text(shown), preview);
        assert.deepEqual(f.refuse.mock.calls.map(call => call.arguments), [["missing"]]);
        assert.equal(input(f.target, "insertText", "Y"), true);
        assert.equal(text(shown), preview);
        assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "missing" });
        assert.deepEqual(f.native.encodeState(), peerState);
      });
    }
  }
}
