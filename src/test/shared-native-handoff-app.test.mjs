import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { createHeldFileHandle } from "./_m4-matrix.mjs";
import { adoptReplacement, currentDocument, noteSessionEdit, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { flushDraftNow } from "../bootstrap/wiring/recovery-owners.ts";
import { draftSource, draftsTesting } from "../bootstrap/wiring/drafts.ts";
import { useDesktopForTest, restoreDesktop } from "../adapters/desktop/desktop-port.ts";
import { autoSavePolicy, confirmSavedNow, requestSave, scheduleAutoSave, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
import { currentHome, setHome } from "../bootstrap/wiring/location-owner.ts";
import { buildSplitpageFile } from "../adapters/formats/project-file.ts";
import { exportDocumentOf } from "../bootstrap/wiring/export-capture.ts";
import { openDocument } from "../bootstrap/wiring/transition-owners.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const enter = () => hook.enter({ backend: "native" });
const warning = "The shared session did not start: your recovery copy could not be saved.";
const warnings = () => [...document.querySelectorAll("#toast-host .toast.warn")].map(toast => toast.textContent);
const row = () => currentDocument().rows[0];

function script() {
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
  useDesktopForTest({
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
    setDocumentState: () => {},
    draftRestoreDone: () => {}
  });
  t.after(async () => {
    try {
      if (sharedSession()) hook.leave();
      await flushDraftNow();
    } finally { restoreDesktop(); }
  });
  return { writes, discards, next: () => new Promise(resolve => { nextWrite = resolve; }) };
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
