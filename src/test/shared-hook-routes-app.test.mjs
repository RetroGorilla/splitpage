import { bootApp, closeApp, rewireApp } from "./_app-boot.mjs";
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
const { adoptReplacement, currentCapabilities, currentDocument, runCommand, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { flushDraftNow, noteDraftChange } = await import("../bootstrap/wiring/recovery-owners.ts");
const { draftSource, draftsTesting } = await import("../bootstrap/wiring/drafts.ts");
const { useDesktopForTest, restoreDesktop } = await import("../adapters/desktop/desktop-port.ts");
const { confirmSavedNow, noteSaveChange, unsavedChanges } = await import("../bootstrap/wiring/save-owners.ts");
const { documentLocation, setHome } = await import("../bootstrap/wiring/location-owner.ts");
const { enterSharedSession, leaveRunningSharedSession, sharedSessionParts } = await import("../bootstrap/wiring/shared-session.ts");
const { sharedWriterBindings } = await import("../bootstrap/wiring/shared-writer.ts");
const { sharedSplitBindings } = await import("../bootstrap/wiring/shared-split.ts");
const { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState } = await import("../adapters/collab/document.ts");
const { executeSharedOperations } = await import("../adapters/collab/execute.ts");
const { registerSharedOperationFamilies } = await import("../adapters/collab/operation-families.ts");
const { readSharedPaintedText } = await import("../adapters/collab/paint-base.ts");
const { sharedBufferedTarget } = await import("../adapters/collab/buffer.ts");
const { readOperation } = await import("../core/collab/read-operation.ts");
const { fromHtml } = await import("../bootstrap/richtext.ts");
const { mintDocId } = await import("../adapters/identity/ids.ts");
const { getEditorName } = await import("../bootstrap/wiring/preferences-owner.ts");

let peer = null;
const report = error => { throw error; };
const effects = { recovered: () => {}, missingBase: () => {}, report };
const writer = sharedWriterBindings(effects), split = sharedSplitBindings(effects);

async function enterOldWriter() {
  const standalone = currentCapabilities();
  const ports = {
    opening: { openingPending: () => false },
    refusal: () => null,
    settle: () => { writerControls().writerFlowControl()?.settle?.(); undoOwner().flush(); },
    prepare: async () => { assert.equal((await flushDraftNow()).ok, true); return null; },
    detach: () => { assert.equal(draftSource.detachSource().ok, true); setHome("none"); documentLocation().markWrittenOut(false); confirmSavedNow(); },
    left: landed => {
      if (peer) destroySharedDocument(peer);
      peer = null;
      draftSource.resumeWriting();
      if (landed) { noteSaveChange(); noteDraftChange(); }
    },
    bindings: {
      enter: parts => { writer.enter(parts); split.enter(parts); },
      settle: () => writer.settle() ?? split.settle(),
      leave: () => { split.leave(); writer.leave(); },
      abandon: () => { writer.abandon(); split.abandon(); },
      drop: () => { writer.drop(); split.drop(); }
    },
    common: { edit: standalone.edit, comment: standalone.edit }, standalone, migrate: migrateRows, docId: mintDocId, editor: getEditorName,
    structure: { cells: html => fromHtml(html) }, report,
    timers: { now: Date.now, start: setTimeout, stop: clearTimeout },
    now: Date.now
  };
  assert.deepEqual(await enterSharedSession(ports), { ok: true });
  peer = createSharedDocument();
  registerSharedOperationFamilies(peer, ports.structure);
  assert.equal(applySharedUpdate(peer, encodeSharedState(sharedSessionParts().handle)).ok, true);
}

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
    assert.deepEqual(currentDocument().rows.map(row => row.audioText), ["Shared Hello"], "the typed text is still only in the buffer");
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
    peer, drafting: draftSource.detachRefusal(), seq: draftsTesting().status().seq, undo: undoOwner().sizes(),
    title: doc.title, abandonable: writer.abandonable() + split.abandonable() };
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
      await enterOldWriter();
      const sessionId = currentDocument().docId;
      const target = sharedBufferedTarget(peer, "r1"), paint = readSharedPaintedText(peer, target);
      const operation = readOperation({ kind: "text-insert", id: "peer-prefix", by: "Bob", target,
        at: { left: null, right: paint.identity(0), affinity: "before" }, content: [{ value: "Shared ", marks: [] }] });
      assert.deepEqual(executeSharedOperations(peer, [operation]), { ok: true });
      assert.equal(applySharedUpdate(sharedSessionParts().handle, encodeSharedState(peer)).ok, true);
      way.arrange();
      const floor = draftsTesting().status().seq;
      let landed = null, started = null;
      document.removeEventListener = function (type, listener, options) {
        if (type === "compositionstart" && options === true) started = listener;
        else if (type === "compositionend" && options === true && listener === started) landed ??= landing();
        return remove.call(this, type, listener, options);
      };
      try { app.stopApp(); } finally { delete document.removeEventListener; }
      assert.ok(landed, "the way out was observed");
      assert.deepEqual([landed.rows, landed.unsaved, landed.shared, landed.parts, landed.peer], [way.landed, true, false, false, null]);
      assert.equal(landed.abandonable, 0);
      assert.notEqual(landed.docId, sessionId);
      assert.deepEqual([landed.drafting, landed.seq], ["pending", floor], "drafting resumed with the landed copy's draft scheduled and no sequence number used");
      assert.deepEqual([landed.undo, landed.title], [{ undo: 0, redo: 0 }, "Before entry"], "D34: the landed copy starts a fresh undo history");
      assert.equal(window.__sharedTest, undefined);
      await restartApp();
      draftStore();
      script(ROWS);
      assert.deepEqual(listenerCounts(), listeners);
      await enterOldWriter();
      assert.deepEqual(leaveRunningSharedSession(), { ok: true });
      assert.deepEqual(listenerCounts(), listeners);
    } finally {
      if (!window.__sharedTest) await restartApp();
      if (sharedSession()) leaveRunningSharedSession();
      await flushDraftNow();
      restoreDesktop();
    }
  });
}
