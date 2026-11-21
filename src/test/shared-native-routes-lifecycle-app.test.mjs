import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Doc } from "yjs";
import { bootApp, closeApp, rewireApp } from "./_app-boot.mjs";
import { startApp, stopApp } from "../bootstrap/app.ts";
import { startupReady } from "../application/startup-signal.ts";
import { changeSet } from "../application/session/change-set.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument, liveSession, runCommand, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { draftSource, draftsTesting } from "../bootstrap/wiring/drafts.ts";
import { draftResume, flushDraftNow } from "../bootstrap/wiring/recovery-owners.ts";
import { useDesktopForTest, restoreDesktop } from "../adapters/desktop/desktop-port.ts";
import { unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
import { currentHome, documentLocation, setHome } from "../bootstrap/wiring/location-owner.ts";
import { sharedUndoRoute, undoOwner } from "../bootstrap/wiring/undo.ts";
import { localFilesOwner } from "../bootstrap/wiring/local-files.ts";
import { documentOpenings, documentTransitions } from "../bootstrap/wiring/transition-owners.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { documentEntry } from "../bootstrap/wiring/ports/document-entry.ts";
import { openingStatus } from "../bootstrap/wiring/ports/transitions.ts";
import { startNewScript } from "../bootstrap/wiring/file-menu-controls.ts";
import { nativeEditorActive } from "../bootstrap/wiring/shared-session.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
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
after(() => {
  listenerProto.addEventListener = realAdd;
  listenerProto.removeEventListener = realRemove;
  closeApp();
});

const rows = [{ id: "r1", audioText: "Hello", visualText: "Wide" }];

function script(source = rows, writer = true) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Routes", rows: source.map(row => ({ ...row })) }));
  setHome("none");
  undoOwner().flush();
  if (writer) writerControls().openWriter();
}

function fields(doc = currentDocument()) {
  return { text: doc.rows.map(row => row.audioText), visual: doc.rows.map(row => row.visualText ?? "") };
}

function retitle(title) {
  const result = runCommand({ name: "route-title", needs: "edit", plan: () => ({
    changes: changeSet({ docFields: ["title"] }),
    apply: doc => { doc.title = title; }
  }) });
  assert.equal(result.kind, "applied");
  undoOwner().flush();
  assert.ok(undoOwner().sizes().undo > 0);
}

function edit(text) {
  const rowId = currentDocument().rows[0].id;
  const result = runCommand({ name: "route-edit", needs: "edit", plan: () => ({
    changes: changeSet({ cells: [{ rowId, field: "audioText" }] }),
    apply: doc => { doc.rows[0].audioText = text; }
  }) });
  assert.equal(result.kind, "applied");
  undoOwner().flush();
}

function draftStore(t) {
  const store = { writes: [], accepting: true };
  const desktop = {
    writeDraft: async payload => {
      const doc = JSON.parse(payload.stateJson);
      store.writes.push({ seq: payload.seq, docId: doc.docId, ...fields(doc),
        shared: sharedSession(), kept: store.accepting });
      return store.accepting ? { ok: true, seq: payload.seq } : { ok: false, code: "ENOSPC" };
    },
    discardDraft: async () => ({ ok: true }), setDocumentState: () => {}, draftRestoreDone: () => {},
    openFileDialog: async () => null, listRecents: async () => []
  };
  const install = () => useDesktopForTest(desktop);
  install();
  t.after(async () => {
    store.accepting = true;
    try {
      if (sharedSession()) window.__sharedTest.leave();
      writerControls().closeWriter();
      setHome("none");
      await flushDraftNow();
    } finally { restoreDesktop(); }
  });
  return { store, install };
}

function landing(hook) {
  const doc = currentDocument();
  return { ...fields(doc), id: doc.docId, title: doc.title, undo: undoOwner().sizes(), unsaved: unsavedChanges(),
    drafting: draftSource.detachRefusal(), seq: draftsTesting().status().seq,
    shared: sharedSession(), native: nativeEditorActive(), peer: hook.read().peer };
}

async function retryAndLeave(hook, listeners) {
  assert.deepEqual(await hook.enter(), { ok: true });
  assert.deepEqual(hook.leave(), { ok: true });
  assert.deepEqual(listenerCounts(), listeners);
}

test("native leave keeps the whole copy and releases the peer when draft resume throws", async t => {
  draftStore(t);
  script();
  const hook = window.__sharedTest, destroyed = t.mock.method(Doc.prototype, "destroy");
  const report = t.mock.method(console, "error", () => {});
  assert.deepEqual(await hook.enter(), { ok: true });
  assert.equal(hook.nativePeer.type("r1", 0, "Shared ").kind, "written");
  const failure = new Error("the draft writer could not resume");
  const resume = t.mock.method(draftSource, "resumeWriting", () => { throw failure; });
  try {
    assert.deepEqual(hook.leave(), { ok: true });
    assert.deepEqual(fields(), { text: ["Shared Hello"], visual: ["Wide"] });
    assert.deepEqual([unsavedChanges(), sharedSession(), hook.read().peer], [true, false, null]);
    assert.deepEqual(report.mock.calls.map(call => call.arguments), [[failure]]);
    assert.equal(resume.mock.callCount(), 1);
    await Promise.resolve();
    assert.equal(destroyed.mock.callCount(), 2);
    assert.equal(new Set(destroyed.mock.calls.map(call => call.this)).size, 2);
  } finally {
    resume.mock.restore();
    draftSource.resumeWriting();
  }
});

const arrival = title => ({ from: { raw: { title, rows: [{ id: "new", audioText: title }] } },
  destination: { kind: "none" }, reason: "native route test" });

const leaveRoutes = [
  ["public leave", hook => assert.deepEqual(hook.leave(), { ok: true }), false],
  ["cancelled Open", () => localFilesOwner().openLocalFile(), false],
  ["completed Open", () => documentTransitions().open(arrival("Opened")), true],
  ["completed New", () => documentTransitions().startNew(arrival("Started")), true],
  ["completed File New", () => assert.equal(startNewScript(), true), true]
];

for (const [name, run, replaces] of leaveRoutes) test(`native ${name} lands the whole copy and restores the listener inventory`, async t => {
  const { store } = draftStore(t);
  script();
  retitle("Before entry");
  assert.equal((await flushDraftNow()).ok, true);
  const hook = window.__sharedTest, listeners = listenerCounts(), destroyed = t.mock.method(Doc.prototype, "destroy");
  assert.deepEqual(await hook.enter(), { ok: true });
  const sharedId = currentDocument().docId, seq = draftsTesting().status().seq, mark = store.writes.length;
  assert.equal(hook.nativePeer.type("r1", 0, "Shared ").kind, "written");
  let landed;
  const before = documentEntry.before;
  const observe = t.mock.method(documentEntry, "before", () => {
    const outcome = before();
    landed ??= landing(hook);
    return outcome;
  });
  try { await run(hook); } finally { observe.mock.restore(); }
  landed ??= landing(hook);
  assert.notEqual(landed.id, sharedId);
  assert.deepEqual(landed, { id: landed.id, text: ["Shared Hello"], visual: ["Wide"], title: "Before entry",
    undo: { undo: 0, redo: 0 }, unsaved: true, drafting: "pending", seq, shared: false, native: false, peer: null });
  assert.equal(destroyed.mock.callCount(), 2);
  assert.equal(new Set(destroyed.mock.calls.map(call => call.this)).size, 2);
  let destination = landed.id, expected = { text: ["Shared Hello"], visual: ["Wide"] };
  if (replaces) {
    destination = currentDocument().docId;
    assert.notEqual(destination, landed.id);
    if (!currentDocument().rows.length) currentDocument().rows.push(migrateRows(arrival("New").from.raw).rows[0]);
    edit("Edited after entry");
    expected = { text: ["Edited after entry"], visual: [""] };
  } else {
    undoOwner().undo();
    assert.equal(currentDocument().title, "Before entry");
    assert.deepEqual(fields(), expected);
  }
  assert.equal((await flushDraftNow()).ok, true);
  assert.deepEqual(store.writes[mark], { docId: destination, seq: seq + 1, ...expected, shared: false, kept: true });
  assert.deepEqual(listenerCounts(), listeners);
  await retryAndLeave(hook, listeners);
});

function standaloneState() {
  return { doc: JSON.stringify(currentDocument()), epoch: liveSession().epoch(), generation: liveSession().generation(),
    home: JSON.stringify(currentHome()), writtenOut: documentLocation().writtenOut(), undo: undoOwner().sizes(),
    unsaved: unsavedChanges(), opening: openingStatus.openingPending(), shared: sharedSession(), native: nativeEditorActive(),
    listeners: listenerCounts() };
}

function throwOnLocation(kind, at = 1) {
  let seen = 0;
  return documentLocation().onChange(change => {
    if (kind === change && ++seen === at) throw new Error(`${kind} subscriber failed`);
  });
}

function throwOnUndoReset(t) {
  const fault = t.mock.method(undoOwner(), "adopt", () => { throw new Error("undo reset failed"); }, { times: 1 });
  return () => fault.mock.restore();
}

const refusals = [
  ["live composition", "buffer-composition", () => {
    const root = document.getElementById("writer-doc");
    root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    return () => root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
  }],
  ["pending restore", "draft-restore-pending", () => {
    draftResume().setRestorePending(true);
    return () => draftResume().setRestorePending(false);
  }],
  ["pending opening", "opening-pending", () => {
    let release;
    documentOpenings.track(() => new Promise(resolve => { release = resolve; }));
    assert.equal(openingStatus.openingPending(), true);
    return release;
  }],
  ["refused draft flush", "draft-not-kept", (_t, store) => {
    store.accepting = false;
    edit("Unsaved before entry");
    return () => { store.accepting = true; };
  }],
  ["final draft detach", "draft-pending", t => {
    const fault = t.mock.method(draftSource, "detachSource", () => ({ ok: false, reason: "pending" }));
    return () => fault.mock.restore();
  }],
  ...["home", "writtenOut"].map(kind => [`${kind} subscriber`, "enter-failed", () => throwOnLocation(kind)]),
  ["undo reset", "enter-failed", throwOnUndoReset],
  ["undo reset and reattachment callbacks", "enter-failed", t => {
    const stops = [throwOnUndoReset(t), throwOnLocation("home", 2), throwOnLocation("writtenOut", 2)];
    return () => stops.forEach(stop => stop());
  }]
];

for (const [name, reason, arrange] of refusals) test(`native entry after ${name} preserves the standalone copy and listener inventory`, async t => {
  const { store } = draftStore(t);
  script();
  const handle = { kind: "file", name: "source.splitpage", _desktopId: "route-source",
    createWritable: () => assert.fail("Source was written") };
  setHome("file", { format: "splitpage", name: handle.name, handle });
  documentLocation().markWrittenOut(true);
  edit("Standalone words");
  assert.equal((await flushDraftNow()).ok, true);
  const mark = store.writes.length, docId = currentDocument().docId, home = currentHome();
  const hook = window.__sharedTest, report = t.mock.method(console, "error", () => {});
  const release = arrange(t, store);
  const before = standaloneState();
  assert.ok(before.undo.undo > 0);
  assert.deepEqual([home.kind, before.writtenOut, before.unsaved], ["file", true, true]);
  try {
    assert.deepEqual(await hook.enter(), { ok: false, reason });
    assert.deepEqual(standaloneState(), before);
    assert.equal(currentHome(), home);
    assert.equal(hook.read().peer, null);
    assert.notEqual(draftSource.detachRefusal(), "detached");
    if (reason === "enter-failed") assert.ok(report.mock.callCount() > 0);
    if (reason === "draft-not-kept") {
      const refused = store.writes.slice(mark);
      assert.ok(refused.length > 0);
      for (const write of refused) assert.deepEqual(write, { seq: write.seq, docId,
        text: ["Unsaved before entry"], visual: ["Wide"], shared: false, kept: false });
    }
  } finally { release(); }
  const seq = store.writes.at(-1).seq, next = store.writes.length;
  edit("Edited after the refusal");
  assert.equal((await flushDraftNow()).ok, true);
  assert.deepEqual(store.writes[next], { docId, seq: seq + 1, shared: false, kept: true,
    text: ["Edited after the refusal"], visual: ["Wide"] });
  await retryAndLeave(hook, before.listeners);
});

function splitInput(field, composing) {
  const cell = document.querySelector(`#rows .cell-editable[data-id="r1"][data-field="${field}"]`);
  assert.ok(cell);
  cell.focus();
  setCellSelection(cell, cell.textContent.length);
  if (composing) {
    cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, cancelable: true }));
    cell.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, data: "!" }));
  }
  const inputType = composing ? "insertCompositionText" : "insertText";
  assert.equal(cell.dispatchEvent(new window.InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType, isComposing: composing, data: "!"
  })), Boolean(composing));
  if (composing) {
    cell.lastChild.data += "!";
    cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType, isComposing: true, data: "!" }));
  }
  assert.ok(cell.textContent.endsWith("!"));
}

const stops = [
  { name: "after a peer commit", writer: true },
  { name: "with pending Split narration", field: "audioText" },
  { name: "after a Split Visual edit", field: "visualText" },
  { name: "during Split narration composition", field: "audioText", composing: true },
  { name: "during Split Visual composition", field: "visualText", composing: true },
  { name: "with an empty Writer", writer: true, empty: true }
];

for (const { name, field, composing, writer = false, empty } of stops) test(`native stop ${name} restores the listener inventory after restart`, async t => {
  const { store, install } = draftStore(t), source = empty ? [] : rows;
  script(source, writer);
  retitle("Before entry");
  assert.equal((await flushDraftNow()).ok, true);
  const listeners = listenerCounts(), hook = window.__sharedTest;
  const destroyed = t.mock.method(Doc.prototype, "destroy"), report = t.mock.method(console, "error", () => {});
  assert.deepEqual(await hook.enter(), { ok: true });
  const sharedId = currentDocument().docId;
  if (empty) {
    assert.ok(writerControls().writerFlowControl());
    assert.equal(document.querySelector(".empty-script-input"), null);
  } else {
    assert.equal(hook.nativePeer.type("r1", 0, "Shared ").kind, "written");
    await Promise.resolve();
  }
  if (field) splitInput(field, composing);
  if (composing) assert.deepEqual(hook.leave(), { ok: false, reason: "native-input-pending" });
  if (!empty) assert.deepEqual(fields(), { text: ["Shared Hello"], visual: [field === "visualText" && !composing ? "Wide!" : "Wide"] });
  const seq = draftsTesting().status().seq, mark = store.writes.length;
  const remove = document.removeEventListener;
  let landed;
  const observe = t.mock.method(document, "removeEventListener", (...args) => {
    if (args[0] === "compositionend" && args[1].name === "composition" && args[2] === true) {
      landed = { ...landing(hook), sharedUndo: sharedUndoRoute() !== null };
    }
    return remove.call(document, ...args);
  });
  try {
    stopApp();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(landed);
    assert.equal(window.__sharedTest, undefined);
    assert.deepEqual(await hook.enter(), { ok: false, reason: "app-stopped" });
    assert.equal(destroyed.mock.callCount(), 2);
    assert.equal(new Set(destroyed.mock.calls.map(call => call.this)).size, 2);
    assert.deepEqual(store.writes.slice(mark), []);
    assert.notEqual(landed.id, sharedId);
    assert.deepEqual(landed, { id: landed.id, title: "Before entry",
      text: empty ? [] : [field === "audioText" && !composing ? "Shared Hello!" : "Shared Hello"],
      visual: empty ? [] : [field === "visualText" && !composing ? "Wide!" : "Wide"],
      undo: { undo: 0, redo: 0 }, seq, unsaved: true, drafting: "pending", shared: false, native: false, peer: null, sharedUndo: false });
    assert.equal(report.mock.callCount(), 0);
  } finally {
    observe.mock.restore();
    restoreDesktop();
    startApp(await rewireApp({}));
    await startupReady();
  }
  install();
  script(source, writer);
  assert.notEqual(draftSource.detachRefusal(), "detached");
  if (writer) assert.ok(writerControls().writerFlowControl());
  assert.deepEqual(listenerCounts(), listeners);
  await retryAndLeave(window.__sharedTest, listeners);
});
