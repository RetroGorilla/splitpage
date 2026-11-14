import { bootApp, closeApp } from "./_app-boot.mjs";
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

const { adoptReplacement, currentDocument, noteSessionEdit, runCommand, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner, sharedUndoRoute, stepSharedUndo } = await import("../bootstrap/wiring/undo.ts");
const { draftResume, flushDraftNow } = await import("../bootstrap/wiring/recovery-owners.ts");
const { draftSource, draftsTesting } = await import("../bootstrap/wiring/drafts.ts");
const { useDesktopForTest, restoreDesktop } = await import("../adapters/desktop/desktop-port.ts");
const { autoSavePolicy, requestSave, confirmSavedNow, scheduleAutoSave } = await import("../bootstrap/wiring/save-owners.ts");
const { currentHome, setHome } = await import("../bootstrap/wiring/location-owner.ts");
const { createHeldFileHandle } = await import("./_m4-matrix.mjs");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { appActions } = await import("../bootstrap/wiring/ports/actions.ts");
const { notices } = await import("../bootstrap/wiring/ports/effects.ts");
let hook = window.__sharedTest;
const DRAFT_NOT_KEPT_NOTICE = "The shared session did not start: your recovery copy could not be saved.";
const warnings = () => Array.from(document.querySelectorAll("#toast-host .toast.warn")).map(toast => toast.textContent);
const settled = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

async function releaseDesktop() {
  if (sharedSession()) hook.leave();
  await flushDraftNow();
  restoreDesktop();
}

function script(rows = [{ id: "r1", audioText: "Hello", visualText: "" }]) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Checkpoint", rows }));
  undoOwner().flush();
  writerControls().openWriter();
}

test("the test hook composes the running Writer and exchanges encoded peer updates in reverse and duplicate order", async () => {
  script([{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "World", visualText: "" }]);
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const start = hook.peer.appliedUpdates().length;
    hook.peer.hold();
    assert.equal(hook.peer.type("r1", 0, "Y").kind, "applied");
    assert.equal(hook.peer.type("r2", 5, "!").kind, "applied");
    await settled();
    assert.equal(hook.read().app.rows[0].audioText, "Hello");
    assert.equal(hook.counters().queued, 2);
    assert.deepEqual(hook.peer.appliedUpdates().length, start);
    assert.equal(hook.peer.release("reverse"), 2);
    const reversed = hook.peer.appliedUpdates().slice(start);
    assert.deepEqual(reversed, [{ to: "app", update: reversed[1].update + 1 }, { to: "app", update: reversed[1].update }]);
    assert.deepEqual(hook.read().app, hook.read().peer);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["YHello", "World!"]);
    assert.equal(document.querySelector('#writer-doc .wr-beat[data-id="r1"]').textContent, "YHello");
    hook.peer.hold();
    hook.peer.type("r1", 6, "?");
    const held = hook.peer.appliedUpdates().length;
    assert.equal(hook.peer.release("duplicate"), 1);
    const duplicated = hook.peer.appliedUpdates().slice(held);
    assert.deepEqual(duplicated, [{ to: "app", update: reversed[0].update + 1 }, { to: "app", update: reversed[0].update + 1 }]);
    assert.deepEqual(hook.read().app, hook.read().peer);
    assert.equal(hook.read().app.rows[0].audioText, "YHello?");
    hook.peer.type("r1", 7, "!");
    assert.equal(hook.counters().queued, 1);
    await settled();
    assert.equal(hook.counters().queued, 0, "a released peer delivers the next update by itself");
    assert.equal(hook.read().app.rows[0].audioText, "YHello?!");
    assert.deepEqual(hook.peer.appliedUpdates().at(-1), { to: "app", update: reversed[0].update + 2 });
    const shared = hook.read().app;
    assert.deepEqual(hook.leave(), { ok: true });
    assert.notEqual(currentDocument().docId, shared.docId);
    assert.deepEqual({ ...currentDocument(), docId: shared.docId }, shared);
    assert.deepEqual(hook.read().peer, null);
  } finally { if (sharedSession()) hook.leave(); }
});

test("entry refuses a pending draft restore and a live Writer composition before replacing the document", async () => {
  script();
  const before = currentDocument();
  draftResume().setRestorePending(true);
  try { assert.deepEqual(await hook.enter(), { ok: false, reason: "draft-restore-pending" }); }
  finally { draftResume().setRestorePending(false); }
  const root = document.getElementById("writer-doc");
  root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
  try { assert.deepEqual(await hook.enter(), { ok: false, reason: "buffer-composition" }); }
  finally { root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" })); }
  assert.equal(currentDocument(), before);
  assert.equal(sharedSession(), false);
});

test("the running shared session sends a refused command to the real notice port once", async () => {
  script();
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const before = document.querySelectorAll("#toast-host .toast.warn").length;
    assert.deepEqual(runCommand({ label: "unsupported", plan: () => ({ refused: "unsupported-checkpoint-command" }) }),
      { kind: "rejected", reason: "unsupported-checkpoint-command", notified: true });
    const warnings = Array.from(document.querySelectorAll("#toast-host .toast.warn"));
    assert.equal(warnings.length, before + 1);
    assert.equal(warnings.at(-1).textContent, "This is not available in a shared session yet.");
    assert.equal(hook.read().app.rows[0].audioText, "Hello");
  } finally { if (sharedSession()) hook.leave(); }
});

test("native ownership checks count scans and a missing painted base shows a notice and increments the hook counter", async () => {
  script();
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const before = hook.counters(), beat = document.querySelector('#writer-doc .wr-beat[data-id="r1"]');
    beat.dataset.id = "missing"; beat.textContent = "Unowned text";
    beat.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    const after = hook.counters();
    assert.equal(after.missingBase, before.missingBase + 1);
    assert.ok(after.ownershipScans > before.ownershipScans);
    assert.equal(after.recovered, before.recovered);
    assert.equal(hook.read().app.rows[0].audioText, "Hello");
    assert.ok(Array.from(document.querySelectorAll("#toast-host .toast.warn")).some(toast => toast.textContent === "This line changed. Try writing again."));
  } finally { if (sharedSession()) hook.leave(); }
});

test("the shared empty Writer keeps an unfinished composition and places the first beat's narration caret", async () => {
  script([]);
  assert.equal(document.querySelector(".empty-script-input"), null);
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const input = document.querySelector(".empty-script-input");
    assert.ok(input);
    input.focus();
    input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "Hi";
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true, isComposing: true, data: "Hi" }));
    assert.equal(writerControls().writerFlowControl().settle(), false);
    assert.equal(writerControls().writerFlowControl().dispose(), false);
    writerControls().closeWriter();
    assert.equal(document.getElementById("writer").hidden, false);
    assert.equal(input.isConnected, true);
    assert.deepEqual(hook.leave(), { ok: false, reason: "buffer-pending" });
    input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "Hi" }));
    const row = currentDocument().rows[0];
    assert.equal(row.audioText, "Hi");
    assert.equal(document.activeElement, document.getElementById("writer-doc"));
    assert.deepEqual(writerControls().writerFlowControl().selection(), {
      anchor: { kind: "beat", rowId: row.id, offset: 2 }, head: { kind: "beat", rowId: row.id, offset: 2 }
    });
    assert.equal(document.querySelector(".empty-script").hidden, true);
    assert.deepEqual(hook.leave(), { ok: true });
    assert.equal(document.querySelector(".empty-script-input"), null);
  } finally { if (sharedSession()) hook.leave(); }
});

test("real draft and autosave owners cancel pending source work on detach and preserve the source draft after leaving", async () => {
  const writes = [], discards = [];
  useDesktopForTest({ writeDraft: async payload => { writes.push(JSON.parse(JSON.stringify(payload))); return { ok: true, seq: payload.seq }; },
    discardDraft: async seq => { discards.push(seq); return { ok: true }; }, setDocumentState: () => {}, draftRestoreDone: () => {} });
  const timers = [], realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  try {
    script();
    setHome("file", { format: "splitpage", name: "source.splitpage",
      handle: { kind: "file", name: "source.splitpage", _desktopId: "checkpoint-source", createWritable: () => { throw new Error("The detached source was written"); } } });
    currentDocument().rows[0].audioText = "Unsaved source"; noteSessionEdit();
    assert.equal((await flushDraftNow()).ok, true);
    assert.equal(writes.length, 1);
    const source = JSON.stringify(writes[0]);
    draftsTesting().setTiming({ idle: 60000, max: 60000 });
    globalThis.setTimeout = (run, ms, ...args) => { const id = realSet(run, ms, ...args); timers.push({ run, id, active: true }); return id; };
    globalThis.clearTimeout = id => { const timer = timers.find(timer => timer.id === id); if (timer) timer.active = false; realClear(id); };
    draftsTesting().noteChange();
    autoSavePolicy().setEnabled(true); scheduleAutoSave();
    globalThis.setTimeout = realSet;
    assert.equal(draftsTesting().status().pending, true);
    assert.equal(autoSavePolicy().pending(), true);
    assert.ok(timers.length > 0);
    assert.deepEqual(await hook.enter(), { ok: true });
    assert.equal(currentHome().kind, "none");
    assert.equal(autoSavePolicy().pending(), false);
    assert.ok(timers.every(timer => !timer.active), "source draft and autosave timers are cancelled before shared editing");
    hook.peer.type("r1", 0, "Shared "); hook.peer.deliver();
    assert.deepEqual(hook.leave(), { ok: true });
    assert.ok(timers.every(timer => !timer.active));
    for (const timer of timers) { clearTimeout(timer.id); if (timer.active) timer.run(); }
    await Promise.resolve(); await Promise.resolve();
    assert.equal(JSON.stringify(writes[0]), source);
    assert.equal(writes.length, 1);
    assert.deepEqual(discards, []);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const timer of timers) clearTimeout(timer.id);
    if (sharedSession()) hook.leave();
    autoSavePolicy().setEnabled(false); await releaseDesktop();
  }
});

test("a captured real file save may finish after entry without adopting its old destination or history", async () => {
  script();
  const target = createHeldFileHandle({ name: "source.splitpage", text: buildSplitpageFile(exportDocumentOf(currentDocument())), lastModified: 1000 });
  await openDocument({ kind: "file", file: await target.handle.getFile(), handle: target.handle, options: { skipSnapshot: true, silent: true } });
  confirmSavedNow();
  currentDocument().rows[0].audioText = "Captured source"; noteSessionEdit(); undoOwner().flush();
  target.holdOp("close");
  const saving = requestSave({ kind: "save" });
  try {
    await target.arrivedAt("close");
    assert.deepEqual(await hook.enter(), { ok: true });
    const shared = hook.read().app;
    target.releaseOp("close");
    assert.deepEqual(await saving, { kind: "obsolete", here: false });
    assert.equal(currentHome().kind, "none");
    assert.deepEqual(hook.read().app, shared);
    assert.deepEqual(undoOwner().sizes(), { undo: 0, redo: 0 });
    assert.ok(target.text().includes("Captured source"));
  } finally {
    target.gates.releaseAll("file.close"); await saving;
    if (sharedSession()) hook.leave();
  }
});

test("leaving shared mode keeps desktop draft sequence numbers increasing for the next standalone edit", async () => {
  let floor = -Infinity;
  const sent = [];
  useDesktopForTest({ writeDraft: async payload => {
    sent.push(payload.seq);
    if (payload.seq <= floor) return { ok: false, code: "STALE_SEQ" };
    floor = payload.seq;
    return { ok: true, seq: payload.seq };
  }, discardDraft: async () => ({ ok: true }), setDocumentState: () => {}, draftRestoreDone: () => {} });
  try {
    script();
    currentDocument().rows[0].audioText = "Before sharing"; noteSessionEdit();
    assert.equal((await flushDraftNow()).ok, true);
    assert.deepEqual(await hook.enter(), { ok: true });
    assert.deepEqual(hook.leave(), { ok: true });
    currentDocument().rows[0].audioText = "After sharing"; noteSessionEdit();
    const result = await flushDraftNow();
    assert.equal(result.ok, true, JSON.stringify({ result, sent }));
    assert.ok(sent[1] > sent[0]);
  } finally {
    await releaseDesktop();
  }
});

function draftStore(accept = () => true) {
  const store = { writes: [], discards: [] };
  useDesktopForTest({ writeDraft: async payload => {
    const doc = JSON.parse(payload.stateJson);
    store.writes.push({ seq: payload.seq, docId: doc.docId, text: doc.rows[0].audioText, shared: sharedSession(), kept: accept() });
    return store.writes.at(-1).kept ? { ok: true, seq: payload.seq } : { ok: false, code: "ENOSPC" };
  }, discardDraft: async seq => { store.discards.push(seq); return { ok: true }; }, setDocumentState: () => {}, draftRestoreDone: () => {} });
  return store;
}

test("entering with pending standalone typing writes that typing to the draft store before the session starts", async () => {
  const store = draftStore();
  try {
    script();
    await flushDraftNow();
    store.writes.length = 0;
    currentDocument().rows[0].audioText = "Typed before sharing"; noteSessionEdit(); undoOwner().flush();
    await Promise.resolve();
    assert.equal(draftsTesting().status().pending, true);
    assert.deepEqual(await hook.enter(), { ok: true });
    assert.deepEqual(store.writes.map(write => [write.text, write.shared, write.kept]), [["Typed before sharing", false, true]]);
    assert.deepEqual(store.discards, []);
  } finally {
    await releaseDesktop();
  }
});

test("entering while the draft store refuses writes is refused with a visible notice, stays standalone and loses nothing", async () => {
  let accepting = false;
  const store = draftStore(() => accepting);
  try {
    script();
    currentDocument().rows[0].audioText = "Typed before sharing"; noteSessionEdit(); undoOwner().flush();
    const before = currentDocument();
    const toasts = () => Array.from(document.querySelectorAll("#toast-host .toast.warn")).map(toast => toast.textContent);
    const shown = toasts().length;
    assert.deepEqual(await hook.enter(), { ok: false, reason: "draft-not-kept" });
    assert.equal(sharedSession(), false);
    assert.equal(currentDocument(), before);
    assert.equal(currentDocument().rows[0].audioText, "Typed before sharing");
    assert.ok(toasts().slice(shown).includes("The shared session did not start: your recovery copy could not be saved."));
    assert.ok(store.writes.length > 0);
    assert.ok(store.writes.every(write => !write.kept && !write.shared && write.text === "Typed before sharing"));
    accepting = true;
    assert.deepEqual(await hook.enter(), { ok: true });
    assert.deepEqual([store.writes.at(-1).text, store.writes.at(-1).shared, store.writes.at(-1).kept], ["Typed before sharing", false, true]);
    assert.deepEqual(store.discards, []);
  } finally {
    await releaseDesktop();
  }
});

test("after a shared stretch over a stored draft, the next flush writes the landed copy with the next sequence number", async () => {
  const store = draftStore();
  try {
    script();
    currentDocument().rows[0].audioText = "Stored"; noteSessionEdit(); undoOwner().flush();
    assert.equal((await flushDraftNow()).ok, true);
    const stored = store.writes.at(-1);
    assert.equal(stored.text, "Stored");
    assert.deepEqual(await hook.enter(), { ok: true });
    hook.peer.type("r1", 0, "Shared "); hook.peer.deliver();
    assert.equal(hook.read().app.rows[0].audioText, "Shared Stored");
    assert.deepEqual(hook.leave(), { ok: true });
    assert.equal((await flushDraftNow()).ok, true);
    assert.deepEqual(store.discards, []);
    const landed = store.writes.at(-1);
    assert.deepEqual([landed.seq, landed.text, landed.docId, landed.shared], [stored.seq + 1, "Shared Stored", currentDocument().docId, false]);
  } finally {
    await releaseDesktop();
  }
});

test("a final draft detach refusal after a passing preflight rolls entry back, keeps the draft reason and warns once", async () => {
  script();
  const before = JSON.stringify(currentDocument());
  const detach = draftSource.detachSource, report = console.error, show = notices.show, reported = [], shown = [];
  draftSource.detachSource = () => ({ ok: false, reason: "pending" });
  console.error = error => { reported.push(String(error)); };
  notices.show = (message, ...rest) => { shown.push([message, sharedSession()]); return show(message, ...rest); };
  try {
    assert.deepEqual(await hook.enter(), { ok: false, reason: "draft-pending" });
  } finally { draftSource.detachSource = detach; console.error = report; notices.show = show; }
  assert.equal(sharedSession(), false);
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.deepEqual(shown.filter(([message]) => message === DRAFT_NOT_KEPT_NOTICE), [[DRAFT_NOT_KEPT_NOTICE, false]], "one draft warning, after the rollback");
  assert.deepEqual(shown.at(-1), [DRAFT_NOT_KEPT_NOTICE, false]);
  assert.ok(warnings().includes(DRAFT_NOT_KEPT_NOTICE));
  assert.ok(reported.some(text => text.includes("The draft writer did not detach: pending")));
  assert.deepEqual(await hook.enter(), { ok: true });
  assert.deepEqual(hook.leave(), { ok: true });
});

test("after leaving, the ordinary draft schedule writes the changed landed copy without an explicit flush", async () => {
  const store = draftStore();
  try {
    script();
    await flushDraftNow();
    draftsTesting().setTiming({ idle: 5, max: 5 });
    assert.deepEqual(await hook.enter(), { ok: true });
    hook.peer.type("r1", 0, "Shared "); hook.peer.deliver();
    store.writes.length = 0;
    assert.deepEqual(hook.leave(), { ok: true });
    const landed = currentDocument().docId;
    await new Promise(resolve => { setTimeout(resolve, 60); });
    assert.deepEqual(store.writes.map(write => [write.text, write.docId, write.shared, write.kept]), [["Shared Hello", landed, false, true]]);
    assert.deepEqual(store.discards, []);
  } finally {
    draftsTesting().setTiming({ idle: 1500, max: 5000 });
    await releaseDesktop();
  }
});

test("leaving while a save from before entry is still writing schedules a draft of the landed copy", async () => {
  const store = draftStore();
  script();
  const target = createHeldFileHandle({ name: "source.splitpage", text: buildSplitpageFile(exportDocumentOf(currentDocument())), lastModified: 1000 });
  await openDocument({ kind: "file", file: await target.handle.getFile(), handle: target.handle, options: { skipSnapshot: true, silent: true } });
  confirmSavedNow();
  currentDocument().rows[0].audioText = "Captured source"; noteSessionEdit(); undoOwner().flush();
  target.holdOp("close");
  const saving = requestSave({ kind: "save" });
  try {
    await target.arrivedAt("close");
    draftsTesting().setTiming({ idle: 5, max: 5 });
    assert.deepEqual(await hook.enter(), { ok: true });
    hook.peer.type("r1", 0, "Shared "); hook.peer.deliver();
    store.writes.length = 0;
    assert.deepEqual(hook.leave(), { ok: true });
    const landed = currentDocument().docId;
    await new Promise(resolve => { setTimeout(resolve, 60); });
    assert.deepEqual(store.writes.map(write => [write.text, write.docId, write.shared, write.kept]), [["Shared Captured source", landed, false, true]]);
  } finally {
    draftsTesting().setTiming({ idle: 1500, max: 5000 });
    target.gates.releaseAll("file.close"); await saving;
    if (sharedSession()) hook.leave();
    await releaseDesktop();
  }
});

test("the composed recovery panel binding offers the Recovery action only while shared, restores and discards a peer's removal, and closes on leave", async () => {
  script([{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "Removed words", visualText: "" }]);
  assert.equal(appActions.has("recovery"), false);
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    assert.equal(appActions.has("recovery"), true);
    assert.deepEqual([appActions.view("recovery")?.enabled, appActions.view("recovery")?.visible], [true, true]);
    appActions.invoke("recovery", "command-menu");
    const panel = () => document.getElementById("shared-recovery-panel");
    assert.equal(panel()?.textContent.includes("Nothing in recovery."), true);
    const ids = () => hook.read().app.rows.map(row => row.id);
    const card = () => panel()?.querySelector('[data-recovery-kind="removed-beat"]');
    const press = label => Array.from(card()?.querySelectorAll("button") ?? []).find(button => button.textContent === label)?.click();
    assert.equal(hook.peer.remove("r2"), "applied");
    hook.peer.deliver();
    assert.deepEqual(ids(), ["r1"]);
    assert.ok(card()?.querySelector("pre").textContent.includes("Removed words"));
    press("Restore");
    hook.peer.deliver();
    assert.deepEqual(ids(), ["r1", "r2"]);
    assert.deepEqual(hook.read().app, hook.read().peer);
    assert.equal(card(), null);
    assert.equal(hook.peer.remove("r2"), "applied");
    hook.peer.deliver();
    press("Discard");
    hook.peer.deliver();
    assert.equal(card(), null);
    assert.deepEqual(ids(), ["r1"]);
    assert.deepEqual(hook.read().app, hook.read().peer);
    assert.deepEqual(hook.leave(), { ok: true });
    assert.equal(appActions.has("recovery"), false);
    assert.equal(document.getElementById("shared-recovery-panel"), null);
  } finally { if (sharedSession()) hook.leave(); }
});

test("the composed undo route warns once for skipped and used-up steps in both directions", () => {
  assert.equal(sharedUndoRoute(), null);
  const skipped = { ok: false, reason: "undo-unsupported:gallery", skipped: true };
  const used = { ok: true, effective: false, reason: "used-up", label: "typing", selection: null };
  for (const outcome of [skipped, used]) for (const direction of ["undo", "redo"]) {
    const warned = [], route = { actions: { undo: () => outcome, redo: () => outcome }, breakGroup: () => {} };
    assert.equal(stepSharedUndo(route, direction, text => { warned.push(text); }), outcome);
    assert.deepEqual(warned, [outcome === skipped ? `This step cannot be ${direction === "undo" ? "undone" : "redone"} in a shared session yet.`
      : `That step could not be ${direction === "undo" ? "undone" : "redone"} because someone else changed it.`]);
  }
});

test("stopping the app in a shared session leaves it and releases the hook and its listeners, and the restarted app enters again", async () => {
  const app = await import("../bootstrap/app.ts");
  const { rewireApp } = await import("./_app-boot.mjs");
  const { startupReady } = await import("../application/startup-signal.ts");
  const { leaveRunningSharedSession, sharedSessionParts } = await import("../bootstrap/wiring/shared-session.ts");
  script();
  const standalone = listenerCounts();
  assert.equal(standalone["document compositionstart/C"], 1);
  assert.deepEqual(await hook.enter(), { ok: true });
  hook.peer.type("r1", 0, "Shared "); hook.peer.deliver();
  let sharedAtRelease = null, started = null;
  const remove = document.removeEventListener;
  document.removeEventListener = function (type, listener, options) {
    if (type === "compositionstart" && options === true) started = listener;
    else if (type === "compositionend" && options === true && listener === started && sharedAtRelease === null) {
      sharedAtRelease = sharedSessionParts() !== null;
      if (sharedAtRelease) leaveRunningSharedSession();
    }
    return remove.call(this, type, listener, options);
  };
  try { app.stopApp(); } finally { delete document.removeEventListener; }
  assert.equal(document.removeEventListener, remove);
  assert.equal(sharedAtRelease, false, "the hook left the shared session before it released its listeners");
  assert.equal(sharedSessionParts(), null);
  assert.equal(sharedSession(), false);
  assert.equal(window.__sharedTest, undefined);
  assert.equal(listenerCounts()["document compositionstart/C"], undefined);
  assert.equal(listenerCounts()["document compositionend/C"], undefined);
  app.startApp(await rewireApp({}));
  await startupReady();
  hook = window.__sharedTest;
  assert.deepEqual(listenerCounts(), standalone);
  script();
  assert.deepEqual(await hook.enter(), { ok: true });
  assert.deepEqual(hook.leave(), { ok: true });
  assert.deepEqual(listenerCounts(), standalone);
});
