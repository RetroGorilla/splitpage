import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const { adoptReplacement, currentDocument, noteSessionEdit, runCommand, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner, sharedUndoRoute, stepSharedUndo } = await import("../bootstrap/wiring/undo.ts");
const { draftResume, flushDraftNow } = await import("../bootstrap/wiring/recovery-owners.ts");
const { draftsTesting } = await import("../bootstrap/wiring/drafts.ts");
const { useDesktopForTest, restoreDesktop } = await import("../adapters/desktop/desktop-port.ts");
const { autoSavePolicy, requestSave, confirmSavedNow, scheduleAutoSave } = await import("../bootstrap/wiring/save-owners.ts");
const { currentHome, setHome } = await import("../bootstrap/wiring/location-owner.ts");
const { createHeldFileHandle } = await import("./_m4-matrix.mjs");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { appActions } = await import("../bootstrap/wiring/ports/actions.ts");
const hook = window.__sharedTest;

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
    hook.peer.hold();
    assert.equal(hook.peer.type("r1", 0, "Y").kind, "applied");
    assert.equal(hook.peer.type("r2", 5, "!").kind, "applied");
    assert.equal(hook.read().app.rows[0].audioText, "Hello");
    assert.equal(hook.counters().queued, 2);
    assert.equal(hook.peer.release("reverse"), 2);
    assert.deepEqual(hook.read().app, hook.read().peer);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["YHello", "World!"]);
    assert.equal(document.querySelector('#writer-doc .wr-beat[data-id="r1"]').textContent, "YHello");
    hook.peer.hold();
    hook.peer.type("r1", 6, "?");
    assert.equal(hook.peer.release("duplicate"), 1);
    assert.deepEqual(hook.read().app, hook.read().peer);
    assert.equal(hook.read().app.rows[0].audioText, "YHello?");
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
    autoSavePolicy().setEnabled(false); restoreDesktop();
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
    if (sharedSession()) hook.leave();
    restoreDesktop();
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
