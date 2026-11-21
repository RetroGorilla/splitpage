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
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { localFilesOwner } from "../bootstrap/wiring/local-files.ts";
import { documentOpenings, documentTransitions } from "../bootstrap/wiring/transition-owners.ts";
import { startNewScript } from "../bootstrap/wiring/file-menu-controls.ts";
import { nativeEditorActive } from "../bootstrap/wiring/shared-session.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const rows = [{ id: "r1", audioText: "Hello", visualText: "Wide" }];

function script(source = rows) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Routes", rows: source }));
  setHome("none");
  writerControls().openWriter();
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
      store.writes.push({ seq: payload.seq, docId: doc.docId, text: doc.rows.map(row => row.audioText),
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

function captureListeners(t) {
  const additions = [window, document].map(target => ({ target,
    add: t.mock.method(target, "addEventListener"), remove: t.mock.method(target, "removeEventListener") }));
  const names = new Set(["intercept", "comment", "pictures", "pageHide", "visibility"]);
  const registered = () => additions.flatMap(({ target, add }) => add.mock.calls
    .filter(({ arguments: [, listener] }) => names.has(listener.name))
    .map(({ arguments: [type, listener, phase] }) => ({ target, type, listener, phase })));
  return {
    registered,
    released: registrations => {
      for (const { target, type, listener, phase } of registrations) {
        const { remove } = additions.find(item => item.target === target);
        assert.equal(remove.mock.calls.filter(({ arguments: args }) =>
          args[0] === type && args[1] === listener && args[2] === phase).length, 1, `${type} (${listener.name})`);
      }
    }
  };
}

const arrival = title => ({ from: { raw: { title, rows: [{ id: "new", audioText: title }] } },
  destination: { kind: "none" }, reason: "native route test" });

const leaveRoutes = [
  ["public leave", hook => assert.deepEqual(hook.leave(), { ok: true })],
  ["cancelled Open", () => localFilesOwner().openLocalFile()],
  ["completed Open", () => documentTransitions().open(arrival("Opened"))],
  ["completed New", () => documentTransitions().startNew(arrival("Started"))],
  ["completed File New", () => assert.equal(startNewScript(), true)]
];

for (const [name, run] of leaveRoutes) test(`native ${name} releases its input and record listeners exactly once`, async t => {
  draftStore(t);
  script();
  const hook = window.__sharedTest;
  const listeners = captureListeners(t);
  assert.deepEqual(await hook.enter(), { ok: true });
  const first = listeners.registered();
  for (const type of ["beforeinput", "compositionstart", "click", "paste", "drop", "pagehide"]) {
    assert.ok(first.some(registration => registration.type === type), type);
  }
  await run(hook);
  listeners.released(first);
  assert.deepEqual(await hook.enter(), { ok: true });
  const second = listeners.registered().filter(registration => !first.some(previous => previous.listener === registration.listener));
  assert.deepEqual(second.map(({ type }) => type), first.map(({ type }) => type));
  assert.deepEqual(hook.leave(), { ok: true });
  listeners.released([...first, ...second]);
});

test("a refused native entry draft flush preserves standalone history and destination", async t => {
  const { store } = draftStore(t);
  script();
  const handle = { kind: "file", name: "source.splitpage", _desktopId: "route-source",
    createWritable: () => assert.fail("Source was written") };
  setHome("file", { format: "splitpage", name: handle.name, handle });
  documentLocation().markWrittenOut(true);
  edit("Stored before entry");
  assert.equal((await flushDraftNow()).ok, true);
  const state = () => ({ doc: JSON.stringify(currentDocument()), epoch: liveSession().epoch(), generation: liveSession().generation(),
    home: currentHome(), writtenOut: documentLocation().writtenOut(), undo: undoOwner().sizes(), unsaved: unsavedChanges() });
  const hook = window.__sharedTest;
  const listeners = captureListeners(t);
  store.accepting = false;
  edit("Unsaved before entry");
  const before = state();
  assert.ok(before.undo.undo > 0);
  assert.deepEqual([before.home.kind, before.writtenOut, before.unsaved], ["file", true, true]);
  assert.deepEqual(await hook.enter(), { ok: false, reason: "draft-not-kept" });
  assert.deepEqual(state(), before);
  assert.equal(currentHome(), before.home);
  assert.equal(sharedSession(), false);
  assert.equal(nativeEditorActive(), false);
  assert.equal(hook.read().peer, null);
  assert.deepEqual(listeners.registered(), []);
  const refusedWrites = store.writes.slice(1);
  assert.ok(refusedWrites.length > 0);
  assert.ok(refusedWrites.every(write => !write.kept && !write.shared && write.text[0] === "Unsaved before entry"));
  store.accepting = true;
  const seq = store.writes.at(-1).seq;
  edit("Edited after the refusal");
  assert.equal((await flushDraftNow()).ok, true);
  assert.deepEqual(store.writes.at(-1), { docId: currentDocument().docId, seq: seq + 1,
    shared: false, kept: true, text: ["Edited after the refusal"] });
  assert.deepEqual(await hook.enter(), { ok: true });
  assert.deepEqual(hook.leave(), { ok: true });
  listeners.released(listeners.registered());
});

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
  ["live composition", "buffer-composition", false, () => {
    const root = document.getElementById("writer-doc");
    root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    return () => root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
  }],
  ["pending restore", "draft-restore-pending", false, () => {
    draftResume().setRestorePending(true);
    return () => draftResume().setRestorePending(false);
  }],
  ["pending opening", "opening-pending", false, () => {
    let release;
    documentOpenings.track(() => new Promise(resolve => { release = resolve; }));
    return release;
  }],
  ["final draft detach", "draft-pending", true, t => {
    const fault = t.mock.method(draftSource, "detachSource", () => ({ ok: false, reason: "pending" }));
    return () => fault.mock.restore();
  }],
  ...["home", "writtenOut"].map(kind => [`${kind} subscriber`, "enter-failed", true, () => throwOnLocation(kind)]),
  ["undo reset", "enter-failed", true, throwOnUndoReset],
  ["undo reset and reattachment callbacks", "enter-failed", true, t => {
    const stops = [throwOnUndoReset(t), throwOnLocation("home", 2), throwOnLocation("writtenOut", 2)];
    return () => stops.forEach(stop => stop());
  }]
];

for (const [name, reason, bound, arrange] of refusals) test(`native entry after ${name} leaves no session listeners behind`, async t => {
  draftStore(t);
  script();
  setHome("file", { format: "splitpage", name: "source.splitpage" });
  documentLocation().markWrittenOut(true);
  edit("Standalone words");
  const hook = window.__sharedTest;
  const listeners = captureListeners(t);
  const release = arrange(t);
  t.mock.method(console, "error", () => {});
  try {
    assert.deepEqual(await hook.enter(), { ok: false, reason });
    const registrations = listeners.registered();
    assert.equal(registrations.some(({ type }) => type === "beforeinput"), bound);
    if (bound) listeners.released(registrations);
    else assert.deepEqual(registrations, []);
  } finally { release(); }
  assert.deepEqual(await hook.enter(), { ok: true });
  assert.deepEqual(hook.leave(), { ok: true });
  listeners.released(listeners.registered());
});

test("stopping with an empty native Writer lands an empty unsaved copy and releases the session", async t => {
  const { install } = draftStore(t);
  script([]);
  assert.equal((await flushDraftNow()).ok, true);
  const hook = window.__sharedTest;
  const destroyed = t.mock.method(Doc.prototype, "destroy");
  assert.deepEqual(await hook.enter(), { ok: true });
  assert.ok(writerControls().writerFlowControl());
  assert.equal(document.querySelector(".empty-script-input"), null);
  const sharedId = currentDocument().docId, seq = draftsTesting().status().seq;
  const remove = document.removeEventListener;
  let landed;
  const observe = t.mock.method(document, "removeEventListener", (...args) => {
    if (args[0] === "compositionend" && args[1].name === "composition" && args[2] === true) {
      const doc = currentDocument();
      landed = { id: doc.docId, rows: doc.rows, title: doc.title, unsaved: unsavedChanges(), drafting: draftSource.detachRefusal(),
        seq: draftsTesting().status().seq, shared: sharedSession(), native: nativeEditorActive(), peer: hook.read().peer };
    }
    return remove(...args);
  });
  try {
    stopApp();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(landed);
    assert.notEqual(landed.id, sharedId);
    assert.deepEqual(landed, { id: landed.id, rows: [], title: "Routes", unsaved: true, drafting: "pending", seq,
      shared: false, native: false, peer: null });
    assert.equal(window.__sharedTest, undefined);
    assert.equal(destroyed.mock.callCount(), 2);
    assert.equal(new Set(destroyed.mock.calls.map(call => call.this)).size, 2);
  } finally {
    observe.mock.restore();
    restoreDesktop();
    startApp(await rewireApp({}));
    await startupReady();
  }
  install();
  script([]);
  const restarted = window.__sharedTest;
  assert.deepEqual(await restarted.enter(), { ok: true });
  assert.deepEqual(restarted.leave(), { ok: true });
});
