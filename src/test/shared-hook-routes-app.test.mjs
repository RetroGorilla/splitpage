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
const { adoptReplacement, currentDocument, liveSession, runCommand, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { draftResume, flushDraftNow } = await import("../bootstrap/wiring/recovery-owners.ts");
const { draftSource, draftsTesting } = await import("../bootstrap/wiring/drafts.ts");
const { useDesktopForTest, restoreDesktop } = await import("../adapters/desktop/desktop-port.ts");
const { unsavedChanges } = await import("../bootstrap/wiring/save-owners.ts");
const { currentHome, documentLocation, setHome } = await import("../bootstrap/wiring/location-owner.ts");
const { documentOpenings, documentTransitions } = await import("../bootstrap/wiring/transition-owners.ts");
const { localFilesOwner } = await import("../bootstrap/wiring/local-files.ts");
const { startNewScript } = await import("../bootstrap/wiring/file-menu-controls.ts");
const { documentEntry } = await import("../bootstrap/wiring/ports/document-entry.ts");
const { documentReader } = await import("../bootstrap/wiring/ports/document.ts");
const { recoveryPanelBinding } = await import("../bootstrap/wiring/recovery-panel.ts");
const { sharedSessionParts } = await import("../bootstrap/wiring/shared-session.ts");
const { appActions } = await import("../bootstrap/wiring/ports/actions.ts");
let hook = window.__sharedTest;

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

const edit = text => {
  const rowId = currentDocument().rows[0].id;
  assert.equal(runCommand({ name: "route-edit", needs: "edit", plan: () => ({ changes: changeSet({ cells: [{ rowId, field: "audioText" }] }),
    apply: live => { live.rows[0].audioText = text; } }) }).kind, "applied");
  undoOwner().flush();
};

async function restartApp() {
  restoreDesktop();
  app.startApp(await rewireApp({}));
  await startupReady();
  hook = window.__sharedTest;
}

const arrival = title => ({ from: { raw: { title, rows: [{ id: "n1", audioText: title + " words" }] } }, destination: { kind: "none" }, reason: "route table" });

function caretAtEnd() {
  const root = document.getElementById("writer-doc"), element = root.querySelector('.wr-beat[data-id="r1"]'), node = element.lastChild;
  root.focus();
  const range = document.createRange();
  range.setStart(node, node.data.length); range.collapse(true);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  return { element, node, range };
}

function emptyInput() {
  const input = document.querySelector(".empty-script-input");
  assert.ok(input);
  input.focus();
  return input;
}

const WAYS_OUT = [
  { name: "the public leave", rows: ROWS, run: () => { assert.deepEqual(hook.leave(), { ok: true }); } },
  { name: "Open, cancelled at its dialog", rows: ROWS, leaveFirst: true, run: () => localFilesOwner().openLocalFile() },
  { name: "Open, completed", rows: ROWS, leaveFirst: true, completes: true, run: () => { documentTransitions().open(arrival("Opened")); } },
  { name: "New, completed", rows: ROWS, leaveFirst: true, completes: true, run: () => { documentTransitions().startNew(arrival("Started")); } },
  { name: "File New, completed", rows: ROWS, leaveFirst: true, completes: true, run: () => { assert.equal(startNewScript(), true); } },
  { name: "stopping the app with nothing pending", rows: ROWS, stops: true },
  { name: "stopping the app with a pending buffered edit", rows: ROWS, stops: true, landed: ["Shared Hello!"], arrange: () => {
    const { element, node, range } = caretAtEnd();
    const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "!" });
    const target = range.cloneRange();
    Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
    assert.equal(element.dispatchEvent(before), true);
    node.data += "!";
    assert.equal(writerControls().writerFlowControl().selection() !== null, true);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Shared Hello"], "the typed text is still only in the buffer");
  } },
  { name: "stopping the app during a Writer composition", rows: ROWS, stops: true, landed: ["Shared Hello"], arrange: () => {
    const { element, node } = caretAtEnd();
    element.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    node.data += " held";
    element.dispatchEvent(new window.InputEvent("input", { bubbles: true, isComposing: true, data: " held" }));
    assert.equal(writerControls().writerFlowControl().settle(), false);
  } },
  { name: "stopping the app during an open composition", rows: [], stops: true, arrange: () => {
    const input = emptyInput();
    input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "Held words";
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true, isComposing: true, data: "Held words" }));
    assert.equal(writerControls().writerFlowControl().settle(), false);
  } }
];

function landing() {
  const doc = currentDocument();
  return { rows: doc.rows.map(row => row.audioText), docId: doc.docId, unsaved: unsavedChanges(), parts: sharedSessionParts() !== null, shared: sharedSession(),
    peer: window.__sharedTest?.read().peer ?? null, drafting: draftSource.detachRefusal(), seq: draftsTesting().status().seq };
}

for (const way of WAYS_OUT) {
  test(`way out: ${way.name} lands the session's last text as an unsaved copy, resumes drafting, disposes the peer, keeps only the inventory listeners, and a later enter succeeds`, async () => {
    const store = draftStore();
    const before = documentEntry.before, remove = document.removeEventListener;
    try {
      script(way.rows);
      await flushDraftNow();
      const listeners = listenerCounts();
      assert.deepEqual(await hook.enter(), { ok: true });
      const session = hook.read().app;
      if (way.rows.length) { hook.peer.type("r1", 0, "Shared "); hook.peer.deliver(); }
      way.arrange?.();
      const last = way.landed ?? hook.read().app.rows.map(row => row.audioText);
      const floor = draftsTesting().status().seq, mark = store.writes.length;
      let landed = null;
      if (way.leaveFirst) documentEntry.before = () => { const refused = before(); landed ??= landing(); return refused; };
      if (way.stops) {
        let started = null;
        document.removeEventListener = function (type, listener, options) {
          if (type === "compositionstart" && options === true) started = listener;
          else if (type === "compositionend" && options === true && listener === started) landed ??= landing();
          return remove.call(this, type, listener, options);
        };
        try { app.stopApp(); } finally { delete document.removeEventListener; }
      } else {
        await way.run();
        if (!way.leaveFirst) landed = landing();
      }
      documentEntry.before = before;
      assert.ok(landed, "the way out was observed");
      assert.deepEqual([landed.rows, landed.unsaved, landed.shared, landed.parts, landed.peer], [last, true, false, false, null]);
      assert.notEqual(landed.docId, session.docId);
      assert.deepEqual([landed.drafting, landed.seq], ["pending", floor], "drafting resumed with the landed copy's draft scheduled and no sequence number used");
      assert.equal(sharedSessionParts() === null, true, "no shared parts");
      if (way.stops) {
        assert.equal(window.__sharedTest, undefined);
        await restartApp();
        draftStore();
        script(way.rows);
      } else {
        assert.deepEqual(hook.read().peer, null);
        if (way.completes) edit("Edited after the entry");
        assert.equal((await flushDraftNow()).ok, true);
        const next = store.writes[mark];
        assert.ok(next, "a draft was written after leaving");
        assert.deepEqual([next.seq, next.shared, next.kept], [floor + 1, false, true]);
        if (!way.completes) assert.deepEqual([next.rows, next.docId], [last, landed.docId]);
      }
      assert.deepEqual(listenerCounts(), listeners);
      assert.deepEqual(await hook.enter(), { ok: true });
      assert.deepEqual(hook.leave(), { ok: true });
      assert.deepEqual(listenerCounts(), listeners);
    } finally {
      documentEntry.before = before;
      if (document.removeEventListener !== remove) delete document.removeEventListener;
      if (!window.__sharedTest) await restartApp();
      if (sharedSession()) hook.leave();
      await flushDraftNow();
      restoreDesktop();
    }
  });
}

test("rule 166: stopping the app when even the forced leave cannot land ends with no shared parts and no hook, and the restarted app enters", async () => {
  const store = draftStore(), report = console.error, reported = [], leave = recoveryPanelBinding.leave;
  try {
    script(ROWS);
    const listeners = listenerCounts();
    assert.deepEqual(await hook.enter(), { ok: true });
    hook.peer.type("r1", 0, "Shared "); hook.peer.deliver();
    recoveryPanelBinding.leave = () => { throw new Error("the recovery panel cannot leave"); };
    console.error = error => { reported.push(String(error)); };
    try { app.stopApp(); } finally { console.error = report; recoveryPanelBinding.leave = leave; }
    assert.ok(reported.some(text => text.includes("ended without landing a standalone copy")), reported.join("\n"));
    assert.deepEqual([sharedSessionParts() === null, window.__sharedTest === undefined], [true, true], "no shared parts and no hook");
    assert.equal(store.writes.some(write => write.shared), false, "nothing from the shared stretch reached the draft store");
    await restartApp();
    assert.notEqual(draftSource.detachRefusal(), "detached", "the restarted app drafts again");
    draftStore();
    script(ROWS);
    assert.deepEqual(listenerCounts(), listeners);
    assert.deepEqual(await hook.enter(), { ok: true });
    assert.deepEqual(hook.leave(), { ok: true });
  } finally {
    console.error = report; recoveryPanelBinding.leave = leave;
    if (!window.__sharedTest) await restartApp();
    if (sharedSession()) hook.leave();
    await flushDraftNow();
    restoreDesktop();
  }
});

function throwOnce(owner, key, message, seen = () => {}) {
  const original = owner[key];
  let armed = true;
  owner[key] = function (...args) {
    if (armed) { armed = false; seen(); throw new Error(message); }
    return original.apply(this, args);
  };
  return () => { owner[key] = original; };
}

function locationSubscriberThrows(change) {
  let armed = true;
  return documentLocation().onChange(seen => { if (seen === change && armed) { armed = false; throw new Error("a " + change + " subscriber failed"); } });
}

const FAILURES = [
  { name: "a live Writer composition", reason: "buffer-composition", arrange: () => {
    const root = document.getElementById("writer-doc");
    root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    return () => { root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" })); };
  } },
  { name: "a pending draft restore", reason: "draft-restore-pending", arrange: () => {
    draftResume().setRestorePending(true);
    return () => { draftResume().setRestorePending(false); };
  } },
  { name: "a pending document opening", reason: "opening-pending", arrange: () => {
    let release = () => {};
    documentOpenings.track(() => new Promise(resolve => { release = resolve; }));
    return () => { release(); };
  } },
  { name: "a draft store that refuses the entry flush", reason: "draft-not-kept", arrange: store => {
    store.accepting = false;
    edit("Unsaved before entry");
    return () => { store.accepting = true; };
  } },
  { name: "a draft writer that refuses the final detach", reason: "draft-pending", arrange: () => {
    const detach = draftSource.detachSource;
    draftSource.detachSource = () => ({ ok: false, reason: "pending" });
    return () => { draftSource.detachSource = detach; };
  } },
  { name: "the Writer binding throwing after it mounted", reason: "enter-failed", arrange: (_store, observed) => {
    const standalone = writerControls();
    return throwOnce(documentReader, "onReplaced", "the Writer binding failed", () => { observed.push(["mounted", writerControls() !== standalone, sharedSession()]); });
  }, observed: [["mounted", true, true]] },
  { name: "the recovery panel binding throwing after it mounted", reason: "enter-failed", arrange: (_store, observed) => {
    const enter = recoveryPanelBinding.enter;
    recoveryPanelBinding.enter = parts => {
      enter(parts); recoveryPanelBinding.enter = enter;
      observed.push(["mounted", appActions.has("recovery"), sharedSession()]);
      throw new Error("the recovery panel binding failed");
    };
    return () => { recoveryPanelBinding.enter = enter; };
  }, observed: [["mounted", true, true]] },
  { name: "a home subscriber throwing at the home change", reason: "enter-failed", arrange: () => locationSubscriberThrows("home") },
  { name: "the detach continuation failing at the written-out change", reason: "enter-failed", arrange: () => locationSubscriberThrows("writtenOut") },
  { name: "the standalone undo reset failing once the detach has finished", reason: "enter-failed", arrange: () => throwOnce(undoOwner(), "adopt", "the undo reset failed") }
];

function standaloneState() {
  return { doc: JSON.stringify(currentDocument()), epoch: liveSession().epoch(), generation: liveSession().generation(), undo: undoOwner().sizes(),
    home: JSON.stringify(currentHome()), writtenOut: documentLocation().writtenOut(), unsaved: unsavedChanges(), shared: sharedSession(), parts: sharedSessionParts() !== null,
    listeners: listenerCounts() };
}

for (const failure of FAILURES) {
  test(`failed entry: ${failure.name} answers ${failure.reason} and leaves document, revision, undo, home, written-out mark, drafting and listeners as they were`, async () => {
    const store = draftStore(), report = console.error, reported = [], observed = [];
    let cleanup = () => {};
    try {
      script(ROWS);
      setHome("file", { format: "splitpage", name: "source.splitpage",
        handle: { kind: "file", name: "source.splitpage", _desktopId: "route-source", createWritable: () => { throw new Error("The source was written"); } } });
      documentLocation().markWrittenOut(true);
      edit("Edited before entry");
      assert.equal((await flushDraftNow()).ok, true);
      cleanup = failure.arrange(store, observed);
      const was = standaloneState(), home = currentHome();
      assert.deepEqual([was.undo.undo > 0, home.kind, was.writtenOut, was.unsaved], [true, "file", true, true]);
      console.error = error => { reported.push(String(error)); };
      try { assert.deepEqual(await hook.enter(), { ok: false, reason: failure.reason }); } finally { console.error = report; }
      assert.deepEqual(observed, failure.observed ?? []);
      if (failure.reason === "enter-failed") assert.ok(reported.length > 0, "the failure was reported");
      const now = standaloneState();
      assert.deepEqual(now, was);
      assert.equal(currentHome() === home, true, "the same home record");
      cleanup(); cleanup = () => {};
      assert.notEqual(draftSource.detachRefusal(), "detached");
      const last = store.writes.at(-1);
      edit("Edited after the attempt");
      assert.equal((await flushDraftNow()).ok, true);
      const next = store.writes.at(-1);
      assert.deepEqual([next.seq, next.rows, next.shared, next.kept], [last.seq + 1, ["Edited after the attempt"], false, true]);
      assert.deepEqual(await hook.enter(), { ok: true });
      assert.deepEqual(hook.leave(), { ok: true });
    } finally {
      console.error = report;
      cleanup();
      if (sharedSession()) hook.leave();
      setHome("none");
      await flushDraftNow();
      restoreDesktop();
    }
  });
}
