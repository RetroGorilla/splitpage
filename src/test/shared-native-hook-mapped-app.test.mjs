import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp, rewireApp } from "./_app-boot.mjs";
import { startApp, stopApp } from "../bootstrap/app.ts";
import { startupReady } from "../application/startup-signal.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { adoptReplacement, currentDocument, noteSessionEdit, runCommand, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { appActions } from "../bootstrap/wiring/ports/actions.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { flushDraftNow } from "../bootstrap/wiring/recovery-owners.ts";
import { useDesktopForTest, restoreDesktop } from "../adapters/desktop/desktop-port.ts";
import { setHome } from "../bootstrap/wiring/location-owner.ts";
import { confirmSavedNow } from "../bootstrap/wiring/save-owners.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { sharedUndoRoute } from "../bootstrap/wiring/undo.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { sanitizeHtml } from "../bootstrap/richtext.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { posToDom } from "../features/common/cell-dom.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));

const registrations = new Map();
const events = window.EventTarget.prototype;
const add = events.addEventListener, remove = events.removeEventListener;
const inventory = () => [...registrations].flatMap(([slot, listeners]) => listeners.size ? [[slot, listeners.size]] : []).sort();
function observeListener(target, type, listener, options, adding) {
  if ((target !== window && target !== document) || !listener) return;
  const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
  const slot = JSON.stringify([target === window ? "window" : "document", type, capture]);
  if (!registrations.has(slot)) registrations.set(slot, new Set());
  if (adding) registrations.get(slot).add(listener);
  else registrations.get(slot).delete(listener);
}
events.addEventListener = function (type, listener, options) {
  observeListener(this, type, listener, options, true);
  return add.call(this, type, listener, options);
};
events.removeEventListener = function (type, listener, options) {
  observeListener(this, type, listener, options, false);
  return remove.call(this, type, listener, options);
};

await bootApp();
after(() => {
  closeApp();
  events.addEventListener = add;
  events.removeEventListener = remove;
});

const hook = () => window.__sharedTest;
const rows = doc => doc.rows.map(row => [row.id, row.audioText, row.visualText ?? ""]);
const snapshot = doc => JSON.parse(JSON.stringify(doc));
const script = [{ id: "r1", audioText: "Hello", visualText: "Look" }, { id: "r2", audioText: "World", visualText: "" }];
const initial = [["r1", "Hello", "Look"], ["r2", "World", ""]];
const root = () => document.getElementById("writer-doc");
const beat = id => root().querySelector(`.wr-beat[data-id="${id}"]`);
const painted = id => beat(id)?.textContent.replaceAll("\u200b", "");
const warnings = () => [...document.querySelectorAll("#toast-host .toast.warn")].map(toast => toast.textContent);
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

function installScript(given) {
  adoptReplacement(migrateRows({ title: "Mapped script", rows: structuredClone(given) }));
  setHome("none");
  confirmSavedNow();
}

function openWriter(t) {
  const writer = writerControls();
  writer.openWriter();
  t.after(() => writerControls().closeWriter());
}

function cleanup() {
  if (!sharedSession() || leaveRunningSharedSession().ok) return;
  forceLeaveSharedSession();
  if (!sharedSession()) return;
  const allowed = () => ({ allowed: true });
  adoptReplacement(migrateRows({ title: "Standby", rows: [] }),
    createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
}

async function enterHook(t, given = script, writer = false) {
  installScript(given);
  t.after(cleanup);
  if (writer) openWriter(t);
  assert.deepEqual(await hook().enter(), { ok: true });
}

async function enterNative(t, given = script, writer = false, now = () => 0) {
  const fixture = entrySwitchFixture(), ports = { ...fixture.ports, now };
  installScript(given);
  t.after(() => {
    cleanup();
    assert.deepEqual(fixture.errors, []);
  });
  if (writer) openWriter(t);
  let native;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  return native;
}

function replica(t, source) {
  const native = openNativeSession({ kind: "state", state: source.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml });
  t.after(() => native.close());
  return native;
}

function stream(native) {
  const updates = [];
  native.ydoc.on("update", (bytes, _origin, _doc, transaction) => { if (transaction.local) updates.push(bytes); });
  return updates;
}

function deliver(target, ...updates) {
  for (const update of updates) assert.equal(applyNativePeerUpdate(target, update), true);
}

function anchor(native, beat, from, to = from, cell = "narration") {
  const anchored = native.commands.anchorText({ beat, cell }, from, to);
  assert.equal(anchored.kind, "anchored");
  return anchored.range;
}

function type(native, beat, offset, text, cell) {
  return native.commands.typeText(anchor(native, beat, offset, offset, cell), text, {});
}

function input(target, inputType, data, range) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data });
  if (range) Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function writerEnd(id) {
  root().focus();
  setCellSelection(beat(id), beat(id).textContent.length);
  document.dispatchEvent(new window.Event("selectionchange"));
  return beat(id);
}

function assertCopies(expected, ...copies) {
  assert.deepEqual(rows(currentDocument()), expected);
  for (const copy of copies) assert.deepEqual(rows(copy.document()), expected);
}

test("native Writer paints reversed and duplicate peer updates and lands a fresh copy", async t => {
  const app = await enterNative(t, script, true), peer = replica(t, app), updates = stream(peer);
  const sourceId = currentDocument().docId;
  assert.equal(type(peer, "r1", 0, "Y").kind, "written");
  assert.equal(type(peer, "r2", 5, "!").kind, "written");
  assert.equal(updates.length, 2);
  assert.deepEqual(rows(currentDocument()), initial);
  deliver(app, updates[1], updates[0]);
  await tick();
  const expectPaint = (first, second) => {
    assertCopies([["r1", first, "Look"], ["r2", second, ""]], app, peer);
    assert.deepEqual(snapshot(currentDocument()), snapshot(peer.document()));
    assert.deepEqual([painted("r1"), painted("r2")], [first, second]);
  };
  expectPaint("YHello", "World!");
  assert.equal(type(peer, "r1", 6, "?").kind, "written");
  deliver(app, updates[2], updates[2]);
  await tick();
  expectPaint("YHello?", "World!");
  const forward = peer.subscribe(event => {
    if (event.kind === "changed") deliver(app, updates.at(-1));
  });
  t.after(forward);
  assert.equal(type(peer, "r1", 7, "!").kind, "written");
  await tick();
  expectPaint("YHello?!", "World!");
  const { docId: shared, ...sharedContent } = snapshot(currentDocument());
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.notEqual(currentDocument().docId, sourceId);
  const { docId: landed, ...landedContent } = snapshot(currentDocument());
  assert.notEqual(landed, shared);
  assert.deepEqual(landedContent, sharedContent);
  assert.deepEqual(rows(currentDocument()), [["r1", "YHello?!", "Look"], ["r2", "World!", ""]]);
  assert.equal(app.acceptsPeerUpdate(), false);
});

test("leaving the native hook withdraws its peer and keeps the peer edit", async t => {
  await enterHook(t, script, true);
  const active = hook();
  assert.equal(active.nativePeer.type("r1", 0, "Y").kind, "written");
  await tick();
  const { app, peer } = active.read();
  assert.deepEqual(rows(app), [["r1", "YHello", "Look"], ["r2", "World", ""]]);
  assert.deepEqual(app, snapshot(peer));
  assert.deepEqual(active.leave(), { ok: true });
  assert.equal(active.read().peer, null);
  assert.equal(active.nativePeer.type("r1", 0, "X"), undefined);
});

test("a native refused command renders one warning and writes nothing", async t => {
  await enterHook(t);
  const count = warnings().length;
  assert.deepEqual(runCommand({ label: "unsupported", plan: () => ({ refused: "unsupported-checkpoint-command" }) }),
    { kind: "rejected", reason: "native-command-unavailable", notified: true });
  assert.deepEqual(warnings().slice(count), ["This is not available in a shared session yet."]);
  assert.deepEqual(rows(hook().read().app), initial);
  assert.deepEqual(rows(hook().read().peer), initial);
});

test("a native Writer edit with missing paint renders one warning and writes nothing", async t => {
  await enterHook(t, script, true);
  const target = writerEnd("r1"), shown = t.mock.method(notices, "show");
  target.dataset.id = "missing";
  try { assert.equal(input(target, "insertParagraph", null), true); }
  finally { target.dataset.id = "r1"; }
  const message = "This is not available in a shared session yet.";
  assert.deepEqual(shown.mock.calls.map(call => call.arguments), [[message, "warn"]]);
  assert.ok(warnings().includes(message));
  assert.deepEqual(rows(hook().read().app), initial);
  assert.deepEqual(rows(hook().read().peer), initial);
  assert.deepEqual(hook().leave(), { ok: true });
});

test("ArrowRight on missing native Writer paint leaves both copies unchanged without a warning", async t => {
  await enterHook(t, script, true);
  const target = writerEnd("r1"), shown = t.mock.method(notices, "show"), before = warnings();
  target.dataset.id = "missing";
  target.textContent = "Unowned text";
  try {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await tick();
    assert.deepEqual(rows(hook().read().app), initial);
    assert.deepEqual(rows(hook().read().peer), initial);
    assert.equal(shown.mock.callCount(), 0);
    assert.deepEqual(warnings(), before);
  } finally {
    target.dataset.id = "r1";
    target.textContent = "Hello";
  }
});

test("an empty native Writer stays open without a first-beat input", async t => {
  await enterHook(t, [], true);
  assert.equal(document.getElementById("writer").hidden, false);
  assert.equal(root().querySelector(".wr-beat"), null);
  assert.equal(document.querySelector(".empty-script-input"), null);
  assert.deepEqual(rows(hook().read().app), []);
  assert.deepEqual(rows(hook().read().peer), []);
  assert.deepEqual(hook().leave(), { ok: true });
  assert.deepEqual(rows(currentDocument()), []);
});

test("explicit draft flush after native leave writes the peer text and fresh identity at the next sequence", async t => {
  const writes = [], discards = [];
  useDesktopForTest({
    writeDraft: async payload => {
      const doc = JSON.parse(payload.stateJson);
      writes.push([payload.seq, doc.docId, doc.rows[0].audioText, sharedSession()]);
      return { ok: true, seq: payload.seq };
    },
    discardDraft: async seq => { discards.push(seq); return { ok: true }; },
    setDocumentState: () => {},
    draftRestoreDone: () => {}
  });
  t.after(restoreDesktop);
  t.after(cleanup);
  installScript(script);
  const original = currentDocument().docId;
  currentDocument().rows[0].audioText = "Stored";
  noteSessionEdit();
  assert.equal((await flushDraftNow()).ok, true);
  const [[sequence]] = writes;
  assert.deepEqual(await hook().enter(), { ok: true });
  const shared = currentDocument().docId;
  assert.equal(hook().nativePeer.type("r1", 0, "Shared ").kind, "written");
  await tick();
  assert.equal(currentDocument().rows[0].audioText, "Shared Stored");
  assert.equal(document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]').textContent, "Shared Stored");
  assert.deepEqual(hook().leave(), { ok: true });
  const landed = currentDocument().docId;
  assert.notEqual(landed, original);
  assert.notEqual(landed, shared);
  assert.equal((await flushDraftNow()).ok, true);
  assert.deepEqual(writes, [[sequence, original, "Stored", false], [sequence + 1, landed, "Shared Stored", false]]);
  assert.deepEqual(discards, []);
});

test("native peer removal offers no Recovery action and the removing author's undo restores the words", async t => {
  const app = await enterNative(t, script, true), peer = replica(t, app), updates = stream(peer);
  assert.equal(appActions.has("recovery"), false);
  assert.equal(peer.commands.removeRows(["r2"]).kind, "written");
  deliver(app, ...updates.splice(0));
  await tick();
  assertCopies([["r1", "Hello", "Look"]], app, peer);
  assert.equal(beat("r2"), null);
  assert.equal(appActions.has("recovery"), false);
  assert.equal(document.getElementById("shared-recovery-panel"), null);
  assert.equal(app.commands.undo().kind, "unchanged");
  assert.equal(peer.commands.undo().kind, "written");
  deliver(app, ...updates.splice(0));
  await tick();
  assertCopies(initial, app, peer);
  assert.deepEqual(snapshot(currentDocument()), snapshot(peer.document()));
  assert.equal(painted("r2"), "World");
});

test("native stop and restart restore the full standalone listener inventory", async t => {
  installScript(script);
  const standalone = inventory(), original = hook();
  assert.ok(standalone.length);
  t.after(cleanup);
  assert.deepEqual(await original.enter(), { ok: true });
  assert.equal(original.nativePeer.type("r1", 0, "Shared ").kind, "written");
  const id = currentDocument().docId;
  let atRelease, compositionListener;
  const release = t.mock.method(document, "removeEventListener", (type, listener, options) => {
    if (type === "compositionstart" && options === true && listener.name === "composition") {
      atRelease = [sharedSession(), currentDocument().docId, rows(currentDocument()), original.read().peer];
      compositionListener = listener;
    }
    return events.removeEventListener.call(document, type, listener, options);
  });
  try {
    stopApp();
    assert.equal(hook(), undefined);
    const [shared, landed, scriptRows, peer] = atRelease;
    assert.equal(shared, false);
    assert.equal(peer, null);
    assert.notEqual(landed, id);
    assert.deepEqual(scriptRows, [["r1", "Shared Hello", "Look"], ["r2", "World", ""]]);
    for (const type of ["compositionstart", "compositionend"]) {
      const listeners = registrations.get(JSON.stringify(["document", type, true]));
      assert.equal(listeners?.has(compositionListener) ?? false, false);
    }
  } finally {
    release.mock.restore();
    startApp(await rewireApp({}));
    await startupReady();
  }
  assert.deepEqual(inventory(), standalone);
  installScript(script);
  assert.deepEqual(await hook().enter(), { ok: true });
  assert.deepEqual(hook().leave(), { ok: true });
  assert.deepEqual(inventory(), standalone);
});

const bold = { kind: "plain", mark: "b", on: true };
const italic = { kind: "plain", mark: "i", on: true };

test("native peer undo and redo publish two independent steps and empty history publishes nothing", async t => {
  const app = await enterNative(t), peer = replica(t, app), updates = stream(peer);
  const check = async (audio, second) => {
    deliver(app, ...updates.splice(0));
    await tick();
    assertCopies([["r1", audio, "Look"], ["r2", second, ""]], app, peer);
  };
  const starting = snapshot(currentDocument());
  assert.equal(peer.commands.undo().kind, "unchanged");
  assert.equal(updates.length, 0);
  assert.deepEqual(snapshot(peer.document()), starting);
  await check("Hello", "World");
  assert.equal(type(peer, "r1", 5, "?").kind, "written");
  assert.equal(peer.commands.formatText(anchor(peer, "r2", 0, 5), italic).kind, "written");
  await check("Hello?", "<em>World</em>");
  for (const [press, first, second] of [
    ["undo", "Hello?", "World"], ["undo", "Hello", "World"],
    ["redo", "Hello?", "World"], ["redo", "Hello?", "<em>World</em>"]
  ]) {
    assert.equal(peer.commands[press]().kind, "written");
    assert.equal(updates.length, 1);
    await check(first, second);
  }
  assert.deepEqual(snapshot(currentDocument()), snapshot(peer.document()));
  assert.equal(app.commands.undo().kind, "unchanged");
});

test("native history can pass a spent step silently and an all-spent press writes nothing", async t => {
  const app = await enterNative(t), peer = replica(t, app), local = stream(app), remote = stream(peer);
  const shown = t.mock.method(notices, "show");
  assert.equal(type(app, "r2", 5, "!").kind, "written");
  for (const text of ["x", "y"]) {
    assert.equal(type(app, "r1", 5, text).kind, "written");
    deliver(peer, ...local.splice(0));
    assert.equal(peer.commands.deleteText(anchor(peer, "r1", 5, 6)).kind, "written");
    deliver(app, ...remote.splice(0));
    await tick();
    sharedUndoRoute().replay("undo");
    if (text === "x") assert.equal(local.length, 1);
    else assert.equal(local.length, 0);
    deliver(peer, ...local.splice(0));
    await tick();
    assertCopies(initial, app, peer);
  }
  const length = { kind: "beat", id: "r2", field: "lengthSeconds" };
  assert.equal(app.commands.setField(length, 10).kind, "written");
  sharedUndoRoute().replay("undo");
  deliver(peer, ...local.splice(0));
  assert.equal(peer.commands.setField(length, 20).kind, "written");
  deliver(app, ...remote.splice(0));
  await tick();
  sharedUndoRoute().replay("redo");
  assert.equal(local.length, 0);
  assertCopies(initial, app, peer);
  assert.deepEqual([currentDocument(), app.document(), peer.document()].map(doc => doc.rows[1].lengthSeconds), [20, 20, 20]);
  assert.equal(shown.mock.callCount(), 0);
});

test("native peer format attempts end typing capture even when refused or unchanged", async t => {
  const app = await enterNative(t), peer = replica(t, app), updates = stream(peer);
  for (const result of ["refused", "unchanged", "written"]) {
    assert.equal(type(peer, "r1", 5, "a").kind, "written");
    const range = anchor(peer, "r1", 0, 1);
    const mark = result === "refused" ? { ...bold, mark: "unsupported" } : result === "unchanged" ? { ...bold, on: false } : bold;
    assert.equal(peer.commands.formatText(range, mark).kind, result);
    assert.equal(type(peer, "r1", 6, "b").kind, "written");
    const prefix = result === "written" ? "<strong>H</strong>ello" : "Hello";
    const check = async first => {
      deliver(app, ...updates.splice(0));
      await tick();
      assertCopies([["r1", first, "Look"], ["r2", "World", ""]], app, peer);
    };
    await check(prefix + "ab");
    assert.equal(peer.commands.undo().kind, "written");
    await check(prefix + "a");
    if (result === "written") {
      assert.equal(peer.commands.undo().kind, "written");
      await check("Helloa");
    }
    assert.equal(peer.commands.undo().kind, "written");
    await check("Hello");
    assert.equal(peer.commands.undo().kind, "unchanged");
  }
});

test("native peer Visual edits and a late joiner's own undo travel independently of held updates", async t => {
  const app = await enterNative(t), peer = replica(t, app), remote = stream(peer);
  assert.equal(type(peer, "r1", 0, "B", "visual").kind, "written");
  assert.equal(peer.commands.deleteText(anchor(peer, "r1", 4, 5, "visual")).kind, "written");
  deliver(app, ...remote.splice(0));
  await tick();
  assertCopies([["r1", "Hello", "BLoo"], ["r2", "World", ""]], app, peer);
  const joiner = replica(t, app), joined = stream(joiner);
  assert.equal(type(peer, "r2", 5, "!").kind, "written");
  assert.equal(type(joiner, "r1", 4, "s", "visual").kind, "written");
  assert.equal(type(joiner, "r2", 0, "J").kind, "written");
  const exchangeJoiner = () => {
    deliver(joiner, ...remote);
    deliver(app, ...joined);
    deliver(peer, ...joined.splice(0));
  };
  exchangeJoiner();
  await tick();
  const merged = [["r1", "Hello", "BLoos"], ["r2", "JWorld!", ""]];
  assertCopies([["r1", "Hello", "BLoos"], ["r2", "JWorld", ""]], app);
  assert.deepEqual(rows(peer.document()), merged);
  assert.deepEqual(rows(joiner.document()), merged);
  deliver(app, ...remote.splice(0));
  await tick();
  assertCopies(merged, app, peer, joiner);
  assert.deepEqual(snapshot(currentDocument()), snapshot(peer.document()));
  assert.deepEqual(snapshot(joiner.document()), snapshot(peer.document()));
  for (const [visual, audio] of [["BLoos", "World!"], ["BLoo", "World!"]]) {
    assert.equal(joiner.commands.undo().kind, "written");
    exchangeJoiner();
    await tick();
    assertCopies([["r1", "Hello", visual], ["r2", audio, ""]], app, peer, joiner);
  }
  assert.equal(joiner.commands.undo().kind, "unchanged");
  assert.equal(joined.length, 0);
  assert.deepEqual(snapshot(currentDocument()), snapshot(peer.document()));
  assert.deepEqual(snapshot(joiner.document()), snapshot(peer.document()));
});

test("a native late replica holds its chosen snapshot until delivery and stays live across app leave", async t => {
  const app = await enterNative(t), source = replica(t, app), remote = stream(source);
  assert.equal(type(source, "r2", 5, "!").kind, "written");
  deliver(app, ...remote.splice(0));
  const joiner = replica(t, source), updates = stream(joiner);
  const held = [["r1", "Hello", "Look"], ["r2", "World!", ""]];
  assert.deepEqual(rows(joiner.document()), held);
  assert.equal(source.commands.removeRows(["r1"]).kind, "written");
  deliver(app, ...remote);
  await tick();
  assert.deepEqual(rows(currentDocument()), [["r2", "World!", ""]]);
  assert.deepEqual(rows(joiner.document()), held);
  deliver(joiner, ...remote);
  assert.deepEqual(rows(joiner.document()), [["r2", "World!", ""]]);
  assert.equal(updates.length, 0);
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.equal(app.acceptsPeerUpdate(), false);
  assert.equal(type(source, "r2", 6, "?").kind, "written");
  assert.equal(applyNativePeerUpdate(joiner, remote.at(-1)), true);
  assert.deepEqual(rows(joiner.document()), [["r2", "World!?", ""]]);
  assert.deepEqual(rows(currentDocument()), [["r2", "World!", ""]]);
});

function backspaceAt(id, from, to) {
  const target = beat(id);
  root().focus();
  setCellSelection(target, to);
  const start = posToDom(target, from), end = posToDom(target, to), range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  assert.equal(input(target, "deleteContentBackward", null, range), true);
}

for (const [name, elapsed, typing, edited, undos] of [
  ["same-direction deletions within the window", 100, false, "Hel", ["Hello"]],
  ["same-direction deletions across the window", 1100, false, "Hel", ["Hell", "Hello"]],
  ["typing followed by a deletion", 100, true, "ello!", ["Hello!", "Hello"]]
]) test(`native Writer and peer history group ${name}`, async t => {
  let time = 0;
  const separatesParagraphs = [script[0], { ...script[1], paragraphStart: true }];
  const app = await enterNative(t, separatesParagraphs, true, () => time), peer = replica(t, app);
  const local = stream(app), remote = stream(peer);
  if (typing) {
    assert.equal(input(writerEnd("r1"), "insertText", "!"), true);
    assert.equal(type(peer, "r2", 5, "!").kind, "written");
  } else {
    backspaceAt("r1", 4, 5);
    assert.equal(peer.commands.deleteTextInRun(anchor(peer, "r2", 4, 5), -1, time).kind, "written");
  }
  time += elapsed;
  const edge = typing ? 1 : 4;
  backspaceAt("r1", edge - 1, edge);
  assert.equal(peer.commands.deleteTextInRun(anchor(peer, "r2", edge - 1, edge), -1, time).kind, "written");
  assert.equal(painted("r1"), edited);
  window.dispatchEvent(new window.Event("pagehide"));
  await tick();
  const exchange = async () => {
    deliver(app, ...remote.splice(0));
    deliver(peer, ...local.splice(0));
    await tick();
  };
  const other = { Hello: "World", "Hello!": "World!", Hell: "Worl", Hel: "Wor", "ello!": "orld!" };
  const check = text => assertCopies([["r1", text, "Look"], ["r2", other[text], ""]], app, peer);
  await exchange();
  check(edited);
  for (const expected of undos) {
    sharedUndoRoute().replay("undo");
    assert.equal(peer.commands.undo().kind, "written");
    await exchange();
    check(expected);
  }
  sharedUndoRoute().replay("undo");
  assert.equal(local.length, 0);
  assert.equal(peer.commands.undo().kind, "unchanged");
  check("Hello");
});

const peerEdits = [
  ["types", peer => type(peer, "r1", 0, "Y"), [["r1", "YHello!", "Look"], ["r2", "World", ""]]],
  ["types astral text", peer => type(peer, "r1", 0, "😀"), [["r1", "😀Hello!", "Look"], ["r2", "World", ""]]],
  ["deletes text", peer => peer.commands.deleteText(anchor(peer, "r1", 1, 3)), [["r1", "Hlo!", "Look"], ["r2", "World", ""]]],
  ["formats text", peer => peer.commands.formatText(anchor(peer, "r1", 0, 4), bold),
    [["r1", "<strong>Hell</strong>o!", "Look"], ["r2", "World", ""]]],
  ["removes the other beat", peer => peer.commands.removeRows(["r2"]), [["r1", "Hello!", "Look"]]]
];
const afterTyping = [["r1", "Hello!", "Look"], ["r2", "World", ""]];
for (const [name, edit, expected] of peerEdits) {
  const orders = name === "removes the other beat" ? ["forward", "reverse", "duplicate"] : ["forward", "reverse", "duplicate", "buffered"];
  for (const order of orders) {
    test(`native peer ${name} with ${order} delivery and only its undo changes the replicas`, async t => {
      const app = await enterNative(t, script, true), peer = replica(t, app), joiner = replica(t, app);
      const local = stream(app), remote = stream(peer);
      assert.equal(edit(peer).kind, "written");
      assert.equal(input(writerEnd("r1"), "insertText", "!"), true);
      assert.equal(painted("r1"), "Hello!");
      if (order === "buffered") {
        deliver(app, ...remote);
        await tick();
        assert.deepEqual(rows(currentDocument()), initial);
      }
      window.dispatchEvent(new window.Event("pagehide"));
      await tick();
      if (order !== "buffered") assert.deepEqual(rows(currentDocument()), afterTyping);
      for (const [target, updates] of (order === "reverse" ? [[peer, local], [app, remote]] : [[app, remote], [peer, local]])) {
        deliver(target, ...updates);
        if (order === "duplicate") deliver(target, ...updates);
      }
      deliver(joiner, ...local, ...remote);
      await tick();
      assertCopies(expected, app, peer, joiner);
      assert.deepEqual(rows(replica(t, app).document()), expected);
      assert.deepEqual(rows(replica(t, peer).document()), expected);
      remote.length = 0;
      assert.equal(peer.commands.undo().kind, "written");
      deliver(app, ...remote);
      deliver(joiner, ...remote);
      await tick();
      assertCopies(afterTyping, app, peer, joiner);
      assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    });
  }
}
