import { trackGlobalListeners } from "./_global-listener-inventory.mjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp, rewireApp } from "./_app-boot.mjs";
import { createHeldFileHandle } from "./_m4-matrix.mjs";
import { startApp, stopApp } from "../bootstrap/app.ts";
import { changeSet } from "../application/session/change-set.ts";
import { startupReady } from "../application/startup-signal.ts";
import { adoptReplacement, currentDocument, holdSessionCommands, liveSession, onSessionChange, noteSessionEdit, runCommand, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sharedUndoRoute, undoOwner } from "../bootstrap/wiring/undo.ts";
import { draftResume, flushDraftNow } from "../bootstrap/wiring/recovery-owners.ts";
import { draftSource, draftsTesting } from "../bootstrap/wiring/drafts.ts";
import { useDesktopForTest, restoreDesktop } from "../adapters/desktop/desktop-port.ts";
import { autoSavePolicy, confirmSavedNow, requestSave, scheduleAutoSave, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
import { currentHome, documentLocation, setHome } from "../bootstrap/wiring/location-owner.ts";
import { buildSplitpageFile } from "../adapters/formats/project-file.ts";
import { exportDocumentOf } from "../bootstrap/wiring/export-capture.ts";
import { documentOpenings, documentTransitions, openDocument } from "../bootstrap/wiring/transition-owners.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { forceLeaveSharedSession, nativeEditorActive } from "../bootstrap/wiring/shared-session.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { localFilesOwner } from "../bootstrap/wiring/local-files.ts";
import { startNewScript } from "../bootstrap/wiring/file-menu-controls.ts";
import { documentEntry } from "../bootstrap/wiring/ports/document-entry.ts";
import { Doc } from "yjs";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const listenerCounts = trackGlobalListeners();
await bootApp();
after(closeApp);

let hook = window.__sharedTest;
const enter = () => hook.enter();
const warning = "The shared session did not start: your recovery copy could not be saved.";
const warnings = () => [...document.querySelectorAll("#toast-host .toast.warn")].map(toast => toast.textContent);
const row = () => currentDocument().rows[0];

function script() {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Checkpoint", rows: [{ id: "r1", audioText: "Hello", visualText: "" }] }));
  setHome("none");
  confirmSavedNow();
}

function edit(text) {
  row().audioText = text;
  noteSessionEdit();
  undoOwner().flush();
}

function peerEdit() {
  assert.equal(hook.nativePeer.type("r1", 0, "Shared ").kind, "written");
}

function draftStore(t, accepts = () => true) {
  const writes = [], discards = [];
  let floor = -Infinity;
  let nextWrite = () => {};
  const desktop = {
    writeDraft: async payload => {
      const doc = JSON.parse(payload.stateJson);
      const kept = accepts() && payload.seq > floor;
      writes.push({ seq: payload.seq, docId: doc.docId, text: doc.rows[0].audioText, shared: sharedSession(), kept });
      nextWrite(writes.at(-1));
      if (!kept) return { ok: false, code: payload.seq <= floor ? "STALE_SEQ" : "ENOSPC" };
      floor = payload.seq;
      return { ok: true, seq: payload.seq };
    },
    discardDraft: async seq => { discards.push(seq); return { ok: true }; },
    openFileDialog: async () => null,
    setDocumentState: () => {},
    draftRestoreDone: () => {}
  };
  const install = () => useDesktopForTest(desktop);
  install();
  t.after(async () => {
    try {
      if (sharedSession()) hook.leave();
      await flushDraftNow();
    } finally { restoreDesktop(); }
  });
  return { writes, discards, install, next: () => new Promise(resolve => { nextWrite = resolve; }) };
}

test("native entry keeps pending standalone typing before adopting the shared owner", async t => {
  const store = draftStore(t);
  script();
  edit("Typed before sharing");
  assert.equal(draftsTesting().status().pending, true);
  const source = currentDocument().docId;
  assert.deepEqual(await enter(), { ok: true });
  assert.deepEqual(store.writes.map(({ text, docId, shared, kept }) => [text, docId, shared, kept]),
    [["Typed before sharing", source, false, true]]);
  assert.deepEqual(store.discards, []);
  assert.equal(row().audioText, "Typed before sharing");
  assert.notEqual(currentDocument().docId, source);
});

test("native entry refuses a failed draft keep, warns, and retries with the standalone text", async t => {
  let accepting = false;
  const store = draftStore(t, () => accepting);
  script();
  edit("Typed before sharing");
  const before = currentDocument(), shown = warnings().length;
  assert.deepEqual(await enter(), { ok: false, reason: "draft-not-kept" });
  assert.equal(sharedSession(), false);
  assert.equal(currentDocument(), before);
  assert.equal(row().audioText, "Typed before sharing");
  assert.ok(warnings().slice(shown).includes(warning));
  assert.ok(store.writes.length > 0);
  assert.ok(store.writes.every(write => !write.kept && !write.shared && write.text === "Typed before sharing"));
  accepting = true;
  assert.deepEqual(await enter(), { ok: true });
  const { text, shared, kept } = store.writes.at(-1);
  assert.deepEqual([text, shared, kept], ["Typed before sharing", false, true]);
  assert.deepEqual(store.discards, []);
});

test("native entry rolls back a final draft detach refusal and warns once after rollback", async t => {
  script();
  const before = JSON.stringify(currentDocument()), show = notices.show;
  const detach = t.mock.method(draftSource, "detachSource", () => ({ ok: false, reason: "pending" }));
  const report = t.mock.method(console, "error", () => {});
  const shown = [];
  t.mock.method(notices, "show", (...args) => { shown.push([args[0], sharedSession()]); return show(...args); });
  assert.deepEqual(await enter(), { ok: false, reason: "draft-pending" });
  assert.equal(sharedSession(), false);
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.deepEqual(shown.filter(([message]) => message === warning), [[warning, false]]);
  assert.deepEqual(shown.at(-1), [warning, false]);
  assert.ok(warnings().includes(warning));
  assert.match(String(report.mock.calls[0].arguments[0]), /The draft writer did not detach: pending/);
  detach.mock.restore();
  assert.deepEqual(await enter(), { ok: true });
  assert.deepEqual(hook.leave(), { ok: true });
});

test("native entry cancels source draft and autosave timers and keeps the source draft", async t => {
  const store = draftStore(t);
  const timers = [];
  const start = globalThis.setTimeout, stop = globalThis.clearTimeout;
  script();
  setHome("file", { format: "splitpage", name: "source.splitpage", handle: {
    kind: "file", name: "source.splitpage", _desktopId: "checkpoint-source",
    createWritable: () => assert.fail("The detached source was written")
  } });
  edit("Unsaved source");
  assert.equal((await flushDraftNow()).ok, true);
  assert.equal(store.writes.length, 1);
  const source = { ...store.writes[0] };
  draftsTesting().setTiming({ idle: 60000, max: 60000 });
  t.after(() => {
    for (const timer of timers) stop(timer.id);
    autoSavePolicy().setEnabled(false);
    draftsTesting().setTiming({ idle: 1500, max: 5000 });
  });
  const setting = t.mock.method(globalThis, "setTimeout", (run, ms, ...args) => {
    const id = start(run, ms, ...args);
    timers.push({ id, active: true });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", id => {
    const timer = timers.find(timer => timer.id === id);
    if (timer) timer.active = false;
    stop(id);
  });
  draftsTesting().noteChange();
  autoSavePolicy().setEnabled(true);
  scheduleAutoSave();
  setting.mock.restore();
  assert.equal(draftsTesting().status().pending, true);
  assert.equal(autoSavePolicy().pending(), true);
  assert.ok(timers.length > 0);
  assert.deepEqual(await enter(), { ok: true });
  assert.equal(currentHome().kind, "none");
  assert.equal(autoSavePolicy().pending(), false);
  assert.ok(timers.every(timer => !timer.active));
  peerEdit();
  assert.deepEqual(hook.leave(), { ok: true });
  assert.ok(timers.every(timer => !timer.active));
  assert.equal(row().audioText, "Shared Unsaved source");
  assert.deepEqual(store.writes, [source]);
  assert.deepEqual(store.discards, []);
});

for (const leaveBeforeSave of [false, true]) {
  const title = leaveBeforeSave
    ? "native leave schedules the landed draft while a captured source save is still writing"
    : "a captured source save finishes in native shared mode without reattaching its destination or history";
  test(title, { timeout: 5000 }, async t => {
    const store = draftStore(t);
    script();
    const target = createHeldFileHandle({
      name: "source.splitpage", text: buildSplitpageFile(exportDocumentOf(currentDocument())), lastModified: 1000
    });
    await openDocument({ kind: "file", file: await target.handle.getFile(), handle: target.handle, options: { skipSnapshot: true, silent: true } });
    confirmSavedNow();
    edit("Captured source");
    target.holdOp("close");
    const saving = requestSave({ kind: "save" });
    try {
      await target.arrivedAt("close");
      assert.deepEqual(await enter(), { ok: true });
      if (leaveBeforeSave) {
        draftsTesting().setTiming({ idle: 5, max: 5 });
        peerEdit();
        const count = store.writes.length, next = store.next();
        assert.deepEqual(hook.leave(), { ok: true });
        const landed = currentDocument().docId;
        const write = await next;
        assert.deepEqual(store.writes.slice(count), [write]);
        assert.deepEqual([write.text, write.docId, write.shared, write.kept], ["Shared Captured source", landed, false, true]);
      }
      const captured = hook.read().app;
      target.releaseOp("close");
      assert.deepEqual(await saving, { kind: "obsolete", here: false });
      assert.equal(currentHome().kind, "none");
      assert.deepEqual(hook.read().app, captured);
      assert.deepEqual(undoOwner().sizes(), { undo: 0, redo: 0 });
      assert.ok(target.text().includes("Captured source"));
      assert.ok(!target.text().includes("Shared Captured source"));
      assert.deepEqual(store.discards, []);
    } finally {
      draftsTesting().setTiming({ idle: 1500, max: 5000 });
      target.gates.releaseAll("file.close");
      await saving;
    }
  });
}

for (const schedule of [false, true]) {
  const title = schedule ? "native leave schedules the first draft with the landed identity"
    : "native leave keeps desktop draft sequence numbers increasing for the next standalone edit";
  test(title, { timeout: 5000 }, async t => {
    const store = draftStore(t);
    script();
    edit("Stored");
    assert.equal((await flushDraftNow()).ok, true);
    const source = store.writes.at(-1);
    assert.equal(source.text, "Stored");
    assert.deepEqual(await enter(), { ok: true });
    if (schedule) {
      draftsTesting().setTiming({ idle: 5, max: 5 });
      t.after(() => { draftsTesting().setTiming({ idle: 1500, max: 5000 }); });
    }
    peerEdit();
    await Promise.resolve();
    assert.equal(row().audioText, "Shared Stored");
    const sharedId = currentDocument().docId, next = store.next();
    assert.deepEqual(hook.leave(), { ok: true });
    const landed = currentDocument().docId;
    assert.notEqual(landed, sharedId);
    assert.notEqual(landed, source.docId);
    assert.equal(unsavedChanges(), true);
    if (!schedule) {
      edit("After sharing");
      assert.equal((await flushDraftNow()).ok, true);
    }
    assert.deepEqual(await next, { seq: source.seq + 1, text: schedule ? "Shared Stored" : "After sharing",
      docId: landed, shared: false, kept: true });
    assert.equal(store.writes.length, 2);
    assert.deepEqual(store.discards, []);
  });
}

test("native leave still disposes the peer and marks the copy unsaved when draft resume throws", async t => {
  const store = draftStore(t);
  const destroyed = t.mock.method(Doc.prototype, "destroy");
  const report = t.mock.method(console, "error", () => {});
  script();
  assert.deepEqual(await enter(), { ok: true });
  const failure = new Error("the draft writer could not resume");
  const resume = t.mock.method(draftSource, "resumeWriting", () => { throw failure; });
  try {
    peerEdit();
    assert.deepEqual(hook.leave(), { ok: true });
    assert.deepEqual([row().audioText, unsavedChanges(), hook.read().peer, sharedSession()], ["Shared Hello", true, null, false]);
    assert.deepEqual(report.mock.calls.map(call => call.arguments), [[failure]]);
    assert.equal(resume.mock.callCount(), 1);
    await Promise.resolve();
    assert.equal(destroyed.mock.callCount(), 2);
    assert.equal(new Set(destroyed.mock.calls.map(call => call.this)).size, 2);
    assert.deepEqual(hook.leave(), { ok: false, reason: "not-shared" });
    assert.equal(destroyed.mock.callCount(), 2);
    assert.ok(store.writes.every(write => !write.shared));
  } finally {
    resume.mock.restore();
    draftSource.resumeWriting();
  }
});

function pendingInput(field, composing, writer = false) {
  const target = writer ? document.querySelector('#writer-doc .wr-beat[data-id="r1"]')
    : document.querySelector(`#rows .cell-editable[data-id="r1"][data-field="${field}"]`);
  assert.ok(target);
  (writer ? document.getElementById("writer-doc") : target).focus();
  setCellSelection(target, target.textContent.length);
  if (composing) {
    target.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, data: "!" }));
  }
  const inputType = composing ? "insertCompositionText" : "insertText";
  const input = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, isComposing: composing, data: "!" });
  assert.equal(target.dispatchEvent(input), Boolean(composing));
  if (composing) {
    target.lastChild.data += "!";
    target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType, isComposing: true, data: "!" }));
  }
  assert.ok(target.textContent.endsWith("!"));
}

const stopCases = [
  { name: "when both leave attempts are blocked", blocked: true, writer: true },
  { name: "after a peer commit" },
  { name: "with pending Split narration", field: "audioText" },
  { name: "with pending Split Visual", field: "visualText" },
  { name: "during Split narration composition", field: "audioText", composing: true },
  { name: "during Split Visual composition", field: "visualText", composing: true },
  { name: "with pending Writer narration", field: "audioText", writer: true },
  { name: "during Writer narration composition", field: "audioText", composing: true, writer: true }
];

for (const { name, field, composing, blocked, writer } of stopCases) test(`app stop ${name} releases the native peer, hook and listeners once`, async t => {
  const store = draftStore(t);
  script();
  edit("Before sharing");
  row().visualText = "Wide";
  assert.equal((await flushDraftNow()).ok, true);
  if (writer) writerControls().openWriter();
  const listeners = listenerCounts();
  const added = t.mock.method(window, "addEventListener");
  const removed = t.mock.method(window, "removeEventListener");
  const removedFromDocument = t.mock.method(document, "removeEventListener");
  const destroyed = t.mock.method(Doc.prototype, "destroy");
  const report = t.mock.method(console, "error", () => {});
  const originalHook = hook;
  assert.deepEqual(await enter(), { ok: true });
  const sharedId = currentDocument().docId;
  const registrations = added.mock.calls.map(call => call.arguments).filter(([type, listener, capture]) =>
    capture === true && ["intercept", "comment", "pictures"].includes(listener.name) || type === "pagehide" && listener.name === "pageHide");
  assert.ok(registrations.some(([type]) => type === "beforeinput"));
  assert.ok(registrations.some(([type]) => type === "pagehide"));
  assert.ok(registrations.some(([type]) => type === "paste"));
  peerEdit();
  await Promise.resolve();
  if (field) pendingInput(field, composing, writer);
  assert.deepEqual([row().audioText, row().visualText], ["Shared Before sharing", field === "visualText" && !composing ? "Wide!" : "Wide"]);
  if (composing) assert.deepEqual(hook.leave(), { ok: false, reason: "native-input-pending" });
  const seq = draftsTesting().status().seq;
  let box;
  if (blocked) {
    const root = document.getElementById("writer-doc"), node = root.querySelector('.wr-beat[data-id="r1"]').lastChild;
    root.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    root.focus();
    document.getSelection().setBaseAndExtent(node, 0, node, 5);
    document.getElementById("wr-visual").click();
    const cell = document.querySelector('.wr-flow-visual-box:not([hidden]) .wr-flow-visual-text');
    assert.ok(cell);
    assert.equal(cell.textContent, "");
    box = cell.closest(".wr-flow-visual-box");
    cell.focus();
    cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    cell.textContent = "held";
    cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, isComposing: true, data: "held" }));
  }
  const release = blocked ? holdSessionCommands("stop-test-hold", "entries") : () => {};
  let atRelease;
  const remove = document.removeEventListener;
  const observe = t.mock.method(document, "removeEventListener", (...args) => {
    if (args[0] === "compositionstart" && args[1].name === "composition" && args[2] === true) {
      const doc = currentDocument();
      atRelease = {
        visualBoxes: document.querySelectorAll('.wr-flow-visual-box').length,
        writer: !!writerControls(), text: doc.rows[0].audioText, visual: doc.rows[0].visualText, id: doc.docId, shared: sharedSession(),
        native: nativeEditorActive(), undo: sharedUndoRoute() !== null, peer: hook.read().peer,
        unsaved: unsavedChanges(), drafting: draftSource.detachRefusal(), seq: draftsTesting().status().seq
      };
    }
    return remove.call(document, ...args);
  });
  const errors = [];
  const capture = event => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener("error", capture);
  try {
    stopApp();
    stopApp();
    await Promise.resolve();
    assert.deepEqual(errors, []);
    assert.equal(window.__sharedTest, undefined);
    assert.deepEqual(await originalHook.enter(), { ok: false, reason: "app-stopped" });
    assert.equal(destroyed.mock.callCount(), 2);
    assert.equal(new Set(destroyed.mock.calls.map(call => call.this)).size, 2);
    for (const [type, fn, capture] of registrations) {
      assert.equal(removed.mock.calls.filter(({ arguments: args }) => args[0] === type && args[1] === fn && args[2] === capture).length, 1, type);
    }
    const hookListeners = removedFromDocument.mock.calls.map(call => call.arguments)
      .filter(([type, fn, capture]) => type.startsWith("composition") && fn.name === "composition" && capture === true);
    assert.deepEqual(hookListeners.map(([type]) => type), ["compositionstart", "compositionend"]);
    assert.equal(hookListeners[0][1], hookListeners[1][1]);
    assert.ok(atRelease);
    assert.deepEqual([atRelease.native, atRelease.undo, atRelease.peer], [false, false, null]);
    if (blocked) {
      assert.deepEqual([atRelease.visualBoxes, atRelease.writer], [0, true]);
      assert.equal(box.isConnected, false);
      assert.equal(document.querySelectorAll(".wr-flow-visual-box").length, 0);
      assert.deepEqual([atRelease.shared, atRelease.id], [true, sharedId]);
      assert.deepEqual(report.mock.calls.map(call => String(call.arguments[0])),
        ["Error: The shared session ended without landing a standalone copy: stop-test-hold"]);
    } else {
      assert.deepEqual([atRelease.shared, atRelease.unsaved, atRelease.drafting, atRelease.seq], [false, true, "pending", seq]);
      assert.notEqual(atRelease.id, sharedId);
      assert.equal(atRelease.text, field === "audioText" && !composing ? "Shared Before sharing!" : "Shared Before sharing");
      assert.equal(atRelease.visual, field === "visualText" && !composing ? "Wide!" : "Wide");
      assert.deepEqual(report.mock.calls.map(call => String(call.arguments[0])), []);
    }
    assert.ok(store.writes.every(write => !write.shared));
  } finally {
    window.removeEventListener("error", capture);
    release();
    observe.mock.restore();
    removedFromDocument.mock.restore();
    restoreDesktop();
    startApp(await rewireApp({}));
    await startupReady();
    hook = window.__sharedTest;
  }
  assert.notEqual(draftSource.detachRefusal(), "detached");
  store.install();
  script();
  if (blocked) {
    writerControls().openWriter();
    assert.ok(writerControls().writerFlowControl());
    assert.deepEqual(listenerCounts(), listeners);
  }
  assert.deepEqual(await enter(), { ok: true });
  assert.deepEqual(hook.leave(), { ok: true });
  if (blocked) assert.deepEqual(listenerCounts(), listeners);
});

for (const composing of [false, true]) test(`native forced leave settles Writer narration, composing=${composing}`, async t => {
  const store = draftStore(t);
  script();
  writerControls().openWriter();
  t.after(() => { writerControls().closeWriter(); });
  assert.deepEqual(await enter(), { ok: true });
  peerEdit();
  await Promise.resolve();
  pendingInput("audioText", false, true);
  if (composing) {
    pendingInput("audioText", true, true);
    assert.deepEqual(hook.leave(), { ok: false, reason: "native-input-pending" });
  }
  assert.equal(row().audioText, "Shared Hello");
  assert.deepEqual(forceLeaveSharedSession(), { ok: true });
  assert.deepEqual([row().audioText, sharedSession(), hook.read().peer, unsavedChanges()], ["Shared Hello!", false, null, true]);
  assert.equal((await flushDraftNow()).ok, true);
  assert.equal(store.writes.at(-1).text, "Shared Hello!");
});

const arrival = title => ({ from: { raw: { title, rows: [{ id: "new", audioText: title }] } },
  destination: { kind: "none" }, reason: "native route test" });

const leaveRoutes = [
  ["public leave", () => assert.deepEqual(hook.leave(), { ok: true })],
  ["cancelled Open", () => localFilesOwner().openLocalFile()],
  ["completed Open", () => documentTransitions().open(arrival("Opened")), true],
  ["completed New", () => documentTransitions().startNew(arrival("Started")), true],
  ["completed File New", () => assert.equal(startNewScript(), true), true]
];

for (const [name, run, replaced] of leaveRoutes) test(`native ${name} lands the copy before the next document entry`, async t => {
  const store = draftStore(t), destroyed = t.mock.method(Doc.prototype, "destroy");
  script();
  edit("Source");
  assert.equal(runCommand({ name: "route-title", needs: "edit", plan: () => ({
    changes: changeSet({ docFields: ["title"] }), apply: doc => { doc.title = "Before entry"; }
  }) }).kind, "applied");
  undoOwner().flush();
  assert.ok(undoOwner().sizes().undo > 0);
  const sourceId = currentDocument().docId;
  assert.equal((await flushDraftNow()).ok, true);
  writerControls().openWriter();
  const listeners = listenerCounts();
  const root = document.getElementById("writer-doc"), node = root.querySelector(".wr-beat").lastChild;
  root.focus();
  document.getSelection().setBaseAndExtent(node, 0, node, 3);
  const title = document.getElementById("writer-title");
  const off = onSessionChange(change => {
    if (change.kind === "adopt" && sharedSession()) queueMicrotask(() => { title.focus(); title.blur(); });
  });
  try { assert.deepEqual(await enter(), { ok: true }); } finally { off(); }
  assert.equal(document.body.hasAttribute("data-native-caret-unplaced"), true);
  const sharedId = currentDocument().docId, seq = draftsTesting().status().seq;
  peerEdit();
  await Promise.resolve();
  const snapshot = structuredClone(currentDocument()), mark = store.writes.length;
  const landing = () => ({
    doc: structuredClone(currentDocument()), id: currentDocument().docId, text: row().audioText, title: currentDocument().title,
    shared: sharedSession(), native: nativeEditorActive(), peer: hook.read().peer, unsaved: unsavedChanges(),
    draft: draftSource.detachRefusal(), seq: draftsTesting().status().seq, undo: undoOwner().sizes()
  });
  let landed;
  const before = documentEntry.before;
  const entry = t.mock.method(documentEntry, "before", () => {
    const result = before();
    landed ??= landing();
    return result;
  });
  await run();
  entry.mock.restore();
  landed ??= landing();
  assert.notEqual(landed.id, sharedId);
  assert.notEqual(landed.id, sourceId);
  assert.deepEqual(landed.doc, { ...snapshot, docId: landed.id });
  assert.deepEqual(landed, { doc: landed.doc, id: landed.id, text: "Shared Source", title: "Before entry", shared: false, native: false, peer: null,
    unsaved: true, draft: "pending", seq, undo: { undo: 0, redo: 0 } });
  assert.equal(destroyed.mock.callCount(), 2);
  assert.equal(new Set(destroyed.mock.calls.map(call => call.this)).size, 2);
  assert.deepEqual(listenerCounts(), listeners);
  assert.equal(document.body.hasAttribute("data-native-caret-unplaced"), false);
  if (replaced) {
    assert.notEqual(currentDocument().docId, landed.id);
    if (!currentDocument().rows.length) currentDocument().rows.push(migrateRows(arrival("New").from.raw).rows[0]);
    edit("Edited after entry");
  } else {
    undoOwner().undo();
    assert.deepEqual(currentDocument(), landed.doc);
  }
  assert.equal((await flushDraftNow()).ok, true);
  assert.deepEqual(store.writes[mark], { seq: seq + 1, text: replaced ? "Edited after entry" : "Shared Source",
    docId: currentDocument().docId, shared: false, kept: true });
  assert.deepEqual(await enter(), { ok: true });
  assert.deepEqual(hook.leave(), { ok: true });
  assert.deepEqual(listenerCounts(), listeners);
});

function failOnce(t, owner, key, error) {
  const original = owner[key];
  let armed = true;
  return t.mock.method(owner, key, function (...args) {
    if (armed) { armed = false; throw error; }
    return original.apply(this, args);
  });
}

const entryFaults = [
  ["live composition", "buffer-composition", () => {
    const root = document.getElementById("writer-doc");
    root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    return () => { root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true })); };
  }],
  ["pending restore", "draft-restore-pending", () => {
    draftResume().setRestorePending(true);
    return () => draftResume().setRestorePending(false);
  }],
  ["pending opening", "opening-pending", () => {
    let release;
    documentOpenings.track(() => new Promise(resolve => { release = resolve; }));
    return release;
  }],
  ["final draft detach", "draft-pending", t => {
    const detach = t.mock.method(draftSource, "detachSource", () => ({ ok: false, reason: "pending" }));
    return () => detach.mock.restore();
  }],
  ...["home", "writtenOut"].map(kind => [`${kind} subscriber`, "enter-failed", () => {
    let armed = true;
    return documentLocation().onChange(change => {
      if (change === kind && armed) { armed = false; throw new Error(`${kind} subscriber`); }
    });
  }]),
  ["undo reset", "enter-failed", t => {
    const adopt = failOnce(t, undoOwner(), "adopt", new Error("undo reset"));
    return () => adopt.mock.restore();
  }],
  ["undo reset and reattachment callbacks", "enter-failed", t => {
    const adopt = failOnce(t, undoOwner(), "adopt", new Error("undo reset"));
    const release = ["home", "writtenOut"].map(kind => {
      let count = 0;
      return documentLocation().onChange(change => {
        if (change === kind && ++count === 2) throw new Error(`${kind} reattachment`);
      });
    });
    return () => { adopt.mock.restore(); release.forEach(stop => stop()); };
  }]
];

for (const [name, reason, arrange] of entryFaults) test(`native entry after ${name} preserves the standalone owners and can retry`, async t => {
  const store = draftStore(t), report = t.mock.method(console, "error", () => {});
  script();
  setHome("file", { format: "splitpage", name: "source.splitpage",
    handle: { kind: "file", name: "source.splitpage", _desktopId: "route-source", createWritable: () => assert.fail("Source was written") } });
  documentLocation().markWrittenOut(true);
  edit("Edited before entry");
  assert.equal((await flushDraftNow()).ok, true);
  const state = () => ({
    doc: JSON.stringify(currentDocument()), epoch: liveSession().epoch(), generation: liveSession().generation(),
    undo: undoOwner().sizes(), home: currentHome(), writtenOut: documentLocation().writtenOut(), unsaved: unsavedChanges(),
    shared: sharedSession(), native: nativeEditorActive(), peer: hook.read().peer
  });
  const release = arrange(t);
  try {
    const before = state();
    assert.ok(before.undo.undo > 0);
    assert.deepEqual([before.home.kind, before.writtenOut, before.unsaved], ["file", true, true]);
    assert.deepEqual(await enter(), { ok: false, reason });
    assert.deepEqual(state(), before);
    assert.equal(currentHome(), before.home);
    if (reason === "enter-failed") assert.ok(report.mock.callCount() > 0);
    if (name === "undo reset and reattachment callbacks") {
      assert.deepEqual(report.mock.calls.map(call => call.arguments[0].message), ["undo reset", "home reattachment"]);
    }
  } finally { release(); }
  assert.notEqual(draftSource.detachRefusal(), "detached");
  const seq = store.writes.at(-1).seq;
  edit("Edited after refused entry");
  assert.equal((await flushDraftNow()).ok, true);
  assert.deepEqual(store.writes.at(-1), { seq: seq + 1, text: "Edited after refused entry",
    docId: currentDocument().docId, shared: false, kept: true });
  assert.deepEqual(await enter(), { ok: true });
  assert.deepEqual(hook.leave(), { ok: true });
});
