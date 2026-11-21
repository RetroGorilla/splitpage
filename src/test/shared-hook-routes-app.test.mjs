import { bootApp, closeApp, rewireApp } from "./_legacy-shared-app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const globalListeners = new Map();
const listenerProto = window.EventTarget.prototype, realAdd = listenerProto.addEventListener, realRemove = listenerProto.removeEventListener;
const listenerSlot = (target, type, options) => (target === window ? "window " : "document ") + type
  + ((typeof options === "boolean" ? options : Boolean(options?.capture)) ? "/C" : "/B");
listenerProto.addEventListener = function (type, listener, options) {
  if ((this === window || this === document) && listener) {
    const slot = listenerSlot(this, type, options);
    if (!globalListeners.has(slot)) globalListeners.set(slot, new Set());
    globalListeners.get(slot).add(listener);
  }
  return realAdd.call(this, type, listener, options);
};
listenerProto.removeEventListener = function (type, listener, options) {
  if (this === window || this === document) globalListeners.get(listenerSlot(this, type, options))?.delete(listener);
  return realRemove.call(this, type, listener, options);
};
const listenerCounts = () => Object.fromEntries([...globalListeners].map(([slot, set]) => [slot, set.size]).filter(([, size]) => size > 0).sort());
await bootApp();
after(() => { listenerProto.addEventListener = realAdd; listenerProto.removeEventListener = realRemove; closeApp(); });

const app = await import("../bootstrap/app.ts");
const { startupReady } = await import("../application/startup-signal.ts");
const { changeSet } = await import("../application/session/change-set.ts");
const { adoptReplacement, currentDocument, runCommand, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { flushDraftNow } = await import("../bootstrap/wiring/recovery-owners.ts");
const { draftSource, draftsTesting } = await import("../bootstrap/wiring/drafts.ts");
const { useDesktopForTest, restoreDesktop } = await import("../adapters/desktop/desktop-port.ts");
const { unsavedChanges } = await import("../bootstrap/wiring/save-owners.ts");
const { sharedSessionParts } = await import("../bootstrap/wiring/shared-session.ts");
let hook = window.__legacySharedTest;

const ROWS = [{ id: "r1", audioText: "Hello", visualText: "" }];

function script(rows) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Routes", rows }));
  undoOwner().flush();
  writerControls().openWriter();
}

function draftStore() {
  const store = { writes: [], accepting: true };
  useDesktopForTest({ writeDraft: async payload => {
    const doc = JSON.parse(payload.stateJson);
    store.writes.push({ seq: payload.seq, docId: doc.docId, rows: doc.rows.map(row => row.audioText), shared: sharedSession(), kept: store.accepting });
    return store.accepting ? { ok: true, seq: payload.seq } : { ok: false, code: "ENOSPC" };
  }, discardDraft: async () => ({ ok: true }), setDocumentState: () => {}, draftRestoreDone: () => {}, openFileDialog: async () => null, listRecents: async () => [] });
  return store;
}

async function restartApp() {
  restoreDesktop();
  app.startApp(await rewireApp({}));
  await startupReady();
  hook = window.__legacySharedTest;
}

function caretAtEnd() {
  const root = document.getElementById("writer-doc"), element = root.querySelector('.wr-beat[data-id="r1"]'), node = element.lastChild;
  root.focus();
  const range = document.createRange();
  range.setStart(node, node.data.length); range.collapse(true);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  return { element, node, range };
}

function retitle(title) {
  assert.equal(runCommand({ name: "route-title", needs: "edit", plan: () => ({ changes: changeSet({ docFields: ["title"] }), apply: live => { live.title = title; } }) }).kind, "applied");
  undoOwner().flush();
}

function selectionVisualComposition() {
  const root = document.getElementById("writer-doc"), node = root.querySelector('.wr-beat[data-id="r1"]').lastChild;
  root.focus();
  const range = document.createRange();
  range.setStart(node, node.data.length - 5); range.setEnd(node, node.data.length);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  document.getElementById("wr-visual").click();
  const cell = document.querySelector(".wr-flow-visual-text");
  assert.equal(cell?.dataset.field, "selection-visual");
  cell.focus();
  cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
  cell.textContent = "held";
  cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, isComposing: true, data: "held" }));
  assert.equal(writerControls().writerFlowControl().settle(), false, "the selection-visual edit is open");
}

const WAYS_OUT = [
  { name: "stopping the app with a pending buffered edit", landed: ["Shared Hello!"], arrange: () => {
    const { element, node, range } = caretAtEnd();
    const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "!" });
    const target = range.cloneRange();
    Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
    assert.equal(element.dispatchEvent(before), true);
    node.data += "!";
    assert.equal(writerControls().writerFlowControl().selection() !== null, true);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Shared Hello"], "the typed text is still only in the buffer");
  } },
  { name: "stopping the app during a Writer composition", landed: ["Shared Hello"], arrange: () => {
    const { element, node } = caretAtEnd();
    element.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    node.data += " held";
    element.dispatchEvent(new window.InputEvent("input", { bubbles: true, isComposing: true, data: " held" }));
    assert.equal(writerControls().writerFlowControl().settle(), false);
  } },
  { name: "stopping the app during a composition in the selection-visual box", landed: ["Shared Hello"], arrange: selectionVisualComposition }
];

function landing() {
  const doc = currentDocument();
  return { rows: doc.rows.map(row => row.audioText), docId: doc.docId, unsaved: unsavedChanges(), parts: sharedSessionParts() !== null, shared: sharedSession(),
    peer: window.__legacySharedTest?.read().peer ?? null, drafting: draftSource.detachRefusal(), seq: draftsTesting().status().seq, undo: undoOwner().sizes(),
    title: doc.title, abandonable: window.__legacySharedTest?.counters().abandonable };
}

for (const way of WAYS_OUT) {
  test(`way out: ${way.name} lands the session's last text as an unsaved copy, resumes drafting, disposes the peer, keeps only the inventory listeners, and a later enter succeeds`, async () => {
    draftStore();
    const remove = document.removeEventListener;
    try {
      script(ROWS);
      retitle("Before entry");
      assert.equal(undoOwner().sizes().undo > 0, true);
      await flushDraftNow();
      const listeners = listenerCounts();
      assert.deepEqual(await hook.enter(), { ok: true });
      const session = hook.read().app;
      hook.peer.type("r1", 0, "Shared "); hook.peer.deliver();
      way.arrange();
      const floor = draftsTesting().status().seq;
      let landed = null;
      let started = null;
      document.removeEventListener = function (type, listener, options) {
        if (type === "compositionstart" && options === true) started = listener;
        else if (type === "compositionend" && options === true && listener === started) landed ??= landing();
        return remove.call(this, type, listener, options);
      };
      try { app.stopApp(); } finally { delete document.removeEventListener; }
      assert.ok(landed, "the way out was observed");
      assert.deepEqual([landed.rows, landed.unsaved, landed.shared, landed.parts, landed.peer], [way.landed, true, false, false, null]);
      assert.equal(landed.abandonable, 0);
      assert.notEqual(landed.docId, session.docId);
      assert.deepEqual([landed.drafting, landed.seq], ["pending", floor], "drafting resumed with the landed copy's draft scheduled and no sequence number used");
      assert.deepEqual([landed.undo, landed.title], [{ undo: 0, redo: 0 }, "Before entry"], "D34: the landed copy starts a fresh undo history");
      assert.equal(sharedSessionParts() === null, true, "no shared parts");
      assert.equal(window.__legacySharedTest, undefined);
      await restartApp();
      draftStore();
      script(ROWS);
      assert.deepEqual(listenerCounts(), listeners);
      assert.deepEqual(await hook.enter(), { ok: true });
      assert.deepEqual(hook.leave(), { ok: true });
      assert.deepEqual(listenerCounts(), listeners);
    } finally {
      if (document.removeEventListener !== remove) delete document.removeEventListener;
      if (!window.__legacySharedTest) await restartApp();
      if (sharedSession()) hook.leave();
      await flushDraftNow();
      restoreDesktop();
    }
  });
}
