import assert from "node:assert/strict";
import { after, test } from "node:test";
import { trackGlobalListeners } from "./_global-listener-inventory.mjs";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { SHARED_ADMISSION_ANNOUNCED } from "../application/session/shared-session.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml } from "../bootstrap/richtext.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { appActions } from "../bootstrap/wiring/ports/actions.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { setBeatFilmed } from "../bootstrap/wiring/beat-status.ts";
import { promptForTarget, promptForWpm } from "../bootstrap/wiring/title-chrome.ts";
import { setTargetLength } from "../features/rundown/target.ts";
import { selectBeats } from "../features/clipboard/beat-select.ts";
import { openProductionPanel } from "../features/tags/panels.ts";
import { setBeatLength } from "../features/rows/read-time.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { sharedRecordCommands } from "../bootstrap/wiring/ports/shared-commands.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { currentWhoList } from "../bootstrap/wiring/who-list.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { BEATS_MIME, buildBeatPayload, parseBeatPayload } from "../features/clipboard/beat-clip.ts";
import { nativeEntrySwitchFixture as entrySwitchFixture } from "../../tests/bootstrap/native-entry-switch-support.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const listenerInventory = trackGlobalListeners();
await bootApp();
after(closeApp);

const warning = ["This is not available in a shared session yet.", "warn"];
const source = [
  { id: "r1", audioText: "abcdef", visualText: "Wide", paragraphStart: true },
  { id: "r2", audioText: "Other", visualText: "Scene" },
  { id: "r3", audioText: "Third", visualText: "Final" }
];
const orders = ["forward", "reverse"];
const app = () => currentDocument();
const audio = doc => doc.rows.map(row => row.audioText);
const cells = doc => doc.rows.map(({ id, audioText, visualText }) => [id, audioText, visualText]);
const text = node => node.textContent.replace(/\u200b/g, "");
const flush = () => window.dispatchEvent(new window.Event("pagehide"));

function written(result) {
  assert.equal(result.kind, "written");
  return result;
}

function openCopy(t, state, actor = "Peer") {
  const copy = openNativeSession({ kind: "state", state }, { actor, sanitize: sanitizeHtml });
  t.after(copy.close);
  return copy;
}

function send(from, to) {
  assert.equal(applyNativePeerUpdate(to, from.encodeState()), true);
}

function delivery(to, order, ...updates) {
  const packet = order === "reverse" ? updates.toReversed() : order === "duplicate" ? updates.flatMap(update => [update, update]) : updates;
  for (const update of packet) assert.equal(applyNativePeerUpdate(to, update), true);
}

function packets(peer, run) {
  const updates = [];
  const capture = update => updates.push(update);
  peer.ydoc.on("update", capture);
  try { run(); } finally { peer.ydoc.off("update", capture); }
  return updates;
}

function edit(peer, beat, from, to, value, cell = "narration") {
  const at = peer.commands.anchorText({ beat, cell }, from, to);
  assert.equal(at.kind, "anchored");
  return written(value === null ? peer.commands.deleteText(at.range) : peer.commands.typeText(at.range, value, {}));
}

function key(target, name, modifiers = {}) {
  const event = new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function input(target, inputType, data = null) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data });
  const selection = document.getSelection();
  if (selection.rangeCount) {
    const range = selection.getRangeAt(0).cloneRange();
    Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  }
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function compose(target, stage, data = "") {
  const event = new window.CompositionEvent("composition" + stage, { bubbles: true, cancelable: true, data });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function composePreview(target, value) {
  compose(target, "update", value);
  const selection = document.getSelection(), range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(value);
  range.insertNode(node);
  selection.setBaseAndExtent(node, value.length, node, value.length);
  target.dispatchEvent(new window.InputEvent("input", {
    bubbles: true, inputType: "insertCompositionText", data: value, isComposing: true
  }));
}

function selectionSnapshot(node) {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = document.getSelection();
  return [node.innerHTML, document.activeElement, anchorNode, anchorOffset, focusNode, focusOffset];
}

async function enter(t, { rows = source, people = [], sections = [], wordsPerMinute, targetSeconds, view = "Split", renderNotices = false } = {}) {
  const fixture = entrySwitchFixture();
  const doc = migrateRows({ schema: 2, title: "Shared callers", paragraphsDecided: true, people, sections, wordsPerMinute, targetSeconds, rows });
  adoptReplacement(doc);
  const toastHost = document.getElementById("toast-host");
  if (renderNotices) toastHost.replaceChildren();
  const show = renderNotices ? t.mock.method(notices, "show") : t.mock.method(notices, "show", () => {});
  let editRefused = false;
  const ports = { ...fixture.ports, common: { ...fixture.ports.common,
    edit: () => editRefused ? { allowed: false, reason: "Editing is paused." } : fixture.ports.common.edit()
  }, commandRefused: sharedCommandRefusalNotice(notices) };
  const writer = writerControls();
  let native, commandSession;
  const root = () => document.getElementById("writer-doc");
  const cell = (id = "r1", field = "audioText") => document.querySelector(view === "Split"
    ? `#rows .cell-editable[data-id="${id}"][data-field="${field}"]`
    : field === "audioText" ? `#writer-doc .wr-beat[data-id="${id}"]` : `#writer .wr-flow-visual-text[data-id="${id}"]`);
  const place = (id, from, to = from, field = "audioText") => {
    const host = cell(id, field), target = view === "Writer" && field === "audioText" ? root() : host;
    assert.ok(host, id + "/" + field);
    target.focus();
    setCellSelection(host, from, to);
    document.dispatchEvent(new window.Event("selectionchange"));
    return target;
  };
  const baseline = listenerInventory();
  assert.deepEqual(await enterSharedSession(ports, (script, failed) => {
    const opened = openNativeEditor(ports, script, failed);
    native = opened.native;
    return { ...opened.backend, bind: session => {
      commandSession = session;
      opened.backend.bind(session);
    } };
  }), { ok: true });
  t.after(() => {
    try {
      assert.deepEqual(fixture.errors, []);
    } finally {
      if (sharedSession() && !leaveRunningSharedSession().ok) {
        forceLeaveSharedSession();
        const allowed = () => ({ allowed: true });
        adoptReplacement(migrateRows({ title: "Standby", rows: [] }),
          createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
      }
      writer.closeWriter();
    }
  });
  const peer = openCopy(t, native.encodeState());
  if (view === "Writer") writer.openWriter();
  const readNotices = () => {
    const calls = show.mock.calls.map(call => call.arguments);
    if (renderNotices) {
      const warnings = [...toastHost.querySelectorAll(".toast.warn")].map(toast => toast.firstChild.textContent);
      assert.deepEqual(warnings, calls.filter(([, level]) => level === "warn").map(([message]) => message));
    }
    return calls;
  };
  return { native, peer, cell, place, root, writer, baseline, errors: fixture.errors, notices: readNotices,
    beforeCommand: listener => commandSession.beforeCommand(listener), hold: () => commandSession.hold("test-held"),
    refuseEdit: () => { editRefused = true; return () => { editRefused = false; }; } };
}

function agree(f, expected) {
  send(f.native, f.peer);
  assert.deepEqual(audio(app()), expected);
  assert.deepEqual(f.native.document(), app());
  assert.deepEqual(f.peer.document(), app());
}

function caret(f, id, from, to = from, field = "audioText") {
  assert.deepEqual(cellSelection(f.cell(id, field)), { from, to });
  assert.equal(document.activeElement, f.cell(id, field).closest("#writer-doc") ?? f.cell(id, field));
}

function history(target, redo = false) {
  assert.equal(key(target, "z", { ctrlKey: true, shiftKey: redo }), true);
}

function land(f, expected) {
  const sharedId = app().docId;
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.notEqual(app().docId, sharedId);
  assert.deepEqual(audio(app()), expected);
  assert.equal(sharedSession(), false);
  assert.equal(f.native.isClosingOrClosed(), true);
}

for (const order of orders) {
  test(`Split: Alt+Enter includes an unpainted peer character inside cXd, ${order}`, async t => {
    const f = await enter(t);
    assert.equal(input(f.place("r1", 3), "insertText", "X"), true);
    assert.equal(text(f.cell()), "abcXdef");
    f.place("r1", 2, 5);
    delivery(f.native, order, ...packets(f.peer, () => {
      edit(f.peer, "r1", 3, 3, "Z");
      edit(f.peer, "r3", 5, 5, "!");
    }));
    await Promise.resolve();
    assert.deepEqual(audio(app()), ["abcdef", "Other", "Third"]);
    assert.equal(text(f.cell()), "abcXdef");
    assert.deepEqual(audio(f.native.document()), ["abcZdef", "Other", "Third!"]);
    assert.equal(key(f.cell(), "Enter", { altKey: true }), true);
    agree(f, ["ab", "ef", "Other", "Third!"]);
    const id = app().rows[1].id;
    assert.deepEqual(cells(app()), [["r1", "ab", "Wide"], [id, "ef", ""], ["r2", "Other", "Scene"], ["r3", "Third!", "Final"]]);
    caret(f, id, 0);
    const late = openCopy(t, f.native.encodeState(), "Reader");
    assert.deepEqual(late.document(), app());
    history(f.cell(id));
    agree(f, ["abcZXdef", "Other", "Third!"]);
    assert.deepEqual(f.notices(), []);
  });
}

const boundaryRows = [
  { id: "r1", audioText: "abcdef", visualText: "Wide", status: "todo" },
  { id: "r2", audioText: "Other", visualText: "", status: "todo" },
  { id: "r3", audioText: "Third", visualText: "", status: "todo" }
];
const boundarySections = [{ id: "s1", name: "Scene", firstSceneId: "r3" }];
const boundaries = [
  { name: "first selected character", erase: [[2, 3]], peer: "abZdef", cut: ["ab", "efX"] },
  { name: "last selected character", erase: [[4, 5]], peer: "abcZef", cut: ["ab", "efX"] },
  { name: "all selected characters", erase: [[2, 3], [3, 4]], peer: "abZef", cut: ["ab", "efX"] },
  { name: "character before selection", erase: [[1, 2]], peer: "acZdef", cut: ["a", "efX"] },
  { name: "character after selection", erase: [[5, 6]], peer: "abcZdf", cut: ["ab", "fX"] }
];
const insertion = { name: "insertion inside cXd", erase: [], peer: "abcZdef", cut: ["ab", "ef"] };

for (const order of ["local-first", "remote-first"]) for (const boundary of [insertion, ...boundaries]) {
  for (const caller of boundary === insertion ? ["Alt+Enter"] : ["Alt+Enter", "Ctrl+Enter"]) {
    test(`Split boundary mapping: ${caller}, ${boundary.name}, ${order}`, async t => {
      const f = await enter(t, { rows: boundaryRows, sections: boundarySections, wordsPerMinute: 150, targetSeconds: null });
      const shape = doc => ({
        ...doc,
        rows: doc.rows.map(row => {
          const fields = { status: "todo", imageRef: null, ...row };
          delete fields.updatedAt;
          delete fields.updatedBy;
          return fields;
        })
      });
      const initial = structuredClone(app());
      const original = shape(initial);
      assert.equal(original.wordsPerMinute, 150);
      assert.equal(original.targetSeconds ?? null, null);
      assert.deepEqual(original.sections, boundarySections);
      const expected = (audioText, inserted = []) => ({
        ...original, rows: [{ ...original.rows[0], audioText }, ...inserted, ...original.rows.slice(1)]
      });
      const agreeAtStep = doc => {
        if (order === "local-first") {
          send(f.native, f.peer);
          send(f.peer, f.native);
        } else {
          send(f.peer, f.native);
          send(f.native, f.peer);
        }
        assert.deepEqual(shape(app()), doc);
        assert.deepEqual(app().rows.slice(-2), initial.rows.slice(-2));
        assert.deepEqual(f.errors, []);
        assert.deepEqual(f.native.document(), app());
        assert.deepEqual(f.peer.document(), app());
        const reader = openNativeSession({ kind: "state", state: f.native.encodeState() }, { actor: "Reader", sanitize: sanitizeHtml });
        try { assert.deepEqual(reader.document(), app()); } finally { reader.close(); }
      };
      const inside = boundary === insertion;
      assert.equal(input(f.place("r1", inside ? 3 : 6), "insertText", "X"), true);
      f.place("r1", 2, inside ? 5 : 4);
      edit(f.peer, "r1", 3, 3, "Z");
      for (const [from, to] of boundary.erase) edit(f.peer, "r1", from, to, null);
      const remote = expected(boundary.peer);
      assert.deepEqual(shape(f.peer.document()), remote);
      send(f.peer, f.native);
      await Promise.resolve();
      assert.deepEqual(shape(f.native.document()), remote);
      assert.deepEqual(shape(app()), original);
      assert.equal(text(f.cell()), inside ? "abcXdef" : "abcdefX");
      const blank = caller === "Ctrl+Enter";
      assert.equal(key(f.cell(), "Enter", blank ? { ctrlKey: true } : { altKey: true }), true);
      const id = app().rows[1].id;
      assert.match(id, new RegExp("^r" + f.native.ydoc.clientID.toString(36) + "-[0-9a-z]+$"));
      assert.ok(original.rows.every(row => row.id !== id));
      const typed = expected(inside ? "abcZXdef" : boundary.peer + "X");
      const [first, second] = blank ? [boundary.peer + "X", ""] : boundary.cut;
      const newRow = migrateRows({ rows: [{ id, audioText: second }] }).rows[0];
      const split = shape(expected(first, [newRow]));
      agreeAtStep(split);
      history(f.cell("r3"));
      agreeAtStep(typed);
      history(f.cell("r3"));
      agreeAtStep(remote);
      assert.deepEqual(f.native.commands.undo(), { kind: "unchanged" });
      agreeAtStep(remote);
      history(f.cell("r3"), true);
      agreeAtStep(typed);
      history(f.cell("r3"), true);
      agreeAtStep(split);
      assert.deepEqual(f.notices(), []);
      const sharedDocument = structuredClone(f.native.document());
      land(f, audio(split));
      assert.deepEqual(app(), migrateRows({ ...sharedDocument, docId: app().docId }));
      assert.deepEqual(listenerInventory(), f.baseline);
    });
  }
}

for (const field of ["audioText", "visualText"]) for (const order of orders) {
  test(`Split ${field}: synthetic composing keys preserve paint and selection, ${order}`, async t => {
    const f = await enter(t);
    delivery(f.native, order, ...packets(f.peer, () => {
      edit(f.peer, "r2", 0, 0, "P");
      edit(f.peer, "r2", 1, 1, "Q");
    }));
    await Promise.resolve();
    const node = f.place("r1", 3, 3, field);
    assert.equal(compose(node, "start"), false);
    composePreview(node, "X");
    const before = selectionSnapshot(node), bytes = f.native.encodeState();
    const reached = t.mock.fn();
    node.addEventListener("keydown", reached);
    for (const name of ["Enter", "Backspace", "Escape", "ArrowLeft"]) {
      for (const signal of [{ isComposing: true }, { keyCode: 229 }]) {
        assert.equal(key(node, name, signal), name === "Enter", name);
        assert.deepEqual(selectionSnapshot(node), before, name);
        assert.deepEqual(f.native.encodeState(), bytes, name);
        assert.deepEqual(cells(app()), [["r1", "abcdef", "Wide"], ["r2", "PQOther", "Scene"], ["r3", "Third", "Final"]]);
      }
    }
    assert.equal(reached.mock.callCount(), 0);
    assert.deepEqual(f.notices(), []);
    compose(node, "end", "X");
    agree(f, [field === "audioText" ? "abcXdef" : "abcdef", "PQOther", "Third"]);
    assert.equal(app().rows[0].visualText, field === "visualText" ? "WidXe" : "Wide");
    assert.deepEqual(f.notices(), []);
  });

  test(`Split ${field}: 229 bypasses keydown before paragraph and line-break refusals, ${order}`, async t => {
    const f = await enter(t);
    delivery(f.native, order, ...packets(f.peer, () => {
      edit(f.peer, "r2", 0, 0, "P");
      edit(f.peer, "r2", 1, 1, "Q");
    }));
    await Promise.resolve();
    const node = f.place("r1", 3, 3, field), before = selectionSnapshot(node), bytes = f.native.encodeState();
    const reached = t.mock.fn();
    node.addEventListener("keydown", reached);
    let refusals = 0;
    for (const name of ["Enter", "Backspace", "Escape", "ArrowLeft"]) {
      for (const type of ["insertParagraph", "insertLineBreak"]) {
        assert.equal(key(node, name, { keyCode: 229 }), false, name);
        assert.deepEqual(f.notices(), Array(refusals).fill(warning));
        assert.deepEqual(selectionSnapshot(node), before);
        assert.deepEqual(f.native.encodeState(), bytes);
        assert.equal(input(node, type), true, type);
        assert.deepEqual(f.notices(), Array(++refusals).fill(warning));
        assert.deepEqual(selectionSnapshot(node), before);
        assert.deepEqual(f.native.encodeState(), bytes);
        agree(f, ["abcdef", "PQOther", "Third"]);
      }
    }
    assert.equal(reached.mock.callCount(), 0);
  });
}

test("Writer: composing over bc removes an unpainted peer insertion and undo restores it", async t => {
  const f = await enter(t, { view: "Writer", rows: [{ id: "r1", audioText: "abcd" }, { id: "r2", audioText: "ef" }] });
  const root = f.place("r1", 1, 3);
  assert.equal(compose(root, "start"), false);
  composePreview(root, "β");
  assert.equal(text(f.cell()), "aβd");
  edit(f.peer, "r1", 2, 2, "X");
  send(f.peer, f.native);
  await Promise.resolve();
  assert.deepEqual(audio(f.native.document()), ["abXcd", "ef"]);
  assert.deepEqual(audio(f.peer.document()), ["abXcd", "ef"]);
  assert.deepEqual(audio(app()), ["abcd", "ef"]);
  assert.equal(text(f.cell()), "aβd");
  compose(root, "end", "β");
  agree(f, ["aβd", "ef"]);
  assert.equal(text(f.cell()), "aβd");
  caret(f, "r1", 2);
  history(root);
  agree(f, ["abXcd", "ef"]);
  assert.equal(text(f.cell()), "abXcd");
  caret(f, "r1", 1, 4);
  assert.deepEqual(f.notices(), []);
});

for (const order of ["forward", "duplicate"]) {
  test(`Writer: replacement in repeated text follows a held peer suffix, ${order}`, async t => {
    for (const composing of [false, true]) {
      await t.test(composing ? "composition" : "typing", async sub => {
        const f = await enter(sub, { view: "Writer", rows: [{ id: "r1", audioText: "the the" }, { id: "r2", audioText: "end" }] });
        const root = f.place("r1", 4, 7);
        if (composing) {
          assert.equal(compose(root, "start"), false);
          composePreview(root, "a");
        } else assert.equal(input(root, "insertText", "a"), true);
        assert.equal(text(f.cell()), "the a");
        edit(f.peer, "r1", 7, 7, "n");
        delivery(f.native, order, f.peer.encodeState());
        await Promise.resolve();
        if (composing) compose(root, "end", "a");
        else flush();
        agree(f, ["the an", "end"]);
        caret(f, "r1", 5);
        history(root);
        agree(f, ["the then", "end"]);
        caret(f, "r1", 4, 7);
        history(root, true);
        agree(f, ["the an", "end"]);
        caret(f, "r1", 6);
        assert.deepEqual(f.notices(), []);
        land(f, ["the an", "end"]);
      });
    }
  });
}

test("Split: a peer cannot invoke recovery for a removed beat during or after sharing", async t => {
  const f = await enter(t);
  const check = () => {
    assert.notEqual(appActions.invoke("recovery", "command-menu").kind, "ran");
    assert.equal(document.getElementById("shared-recovery-panel"), null);
  };
  check();
  written(f.peer.commands.removeRows(["r2"]));
  send(f.peer, f.native);
  await Promise.resolve();
  agree(f, ["abcdef", "Third"]);
  assert.equal(f.cell("r2"), null);
  check();
  written(f.peer.commands.undo());
  send(f.peer, f.native);
  await Promise.resolve();
  agree(f, ["abcdef", "Other", "Third"]);
  assert.equal(text(f.cell("r2")), "Other");
  land(f, ["abcdef", "Other", "Third"]);
  check();
});

test("Split: script beat paste refuses without consuming pending text", async t => {
  const f = await enter(t);
  const { json, text: payload } = buildBeatPayload(app(), ["r2"], {});
  const node = f.place("r1", 3);
  assert.equal(input(node, "insertText", "X"), true);
  f.place("r1", 2, 6);
  const before = selectionSnapshot(node);
  edit(f.peer, "r1", 4, 4, "Z");
  send(f.peer, f.native);
  const bytes = f.native.encodeState();
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    types: [BEATS_MIME, "text/plain"],
    getData: type => type === BEATS_MIME ? json : type === "text/plain" ? payload : ""
  } });
  node.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(f.notices(), [warning]);
  assert.deepEqual(selectionSnapshot(node), before);
  assert.deepEqual(f.native.encodeState(), bytes);
  assert.deepEqual(audio(app()), ["abcdef", "Other", "Third"]);
  flush();
  agree(f, ["abcXdZef", "Other", "Third"]);
});

function splitPeer(peer, id, offset) {
  const at = peer.commands.anchorText({ beat: id, cell: "narration" }, offset);
  assert.equal(at.kind, "anchored");
  return written(peer.commands.splitRow(at.range)).created;
}

const removeButton = id => document.querySelector(`#rows .row[data-id="${id}"] [data-action="delete-row"]`);

for (const command of ["delete", "cut"]) for (const route of ["keyboard", "menu"]) {
  for (const mode of ["allowed", "capability", "hold", "silent", "announced"]) {
    test(`Native selected beat baseline: ${command}, ${route}, ${mode}`, async t => {
      const f = await enter(t);
      const before = structuredClone(app()), native = f.native.encodeState(), peer = f.peer.encodeState();
      const standalone = undoOwner().sizes(), action = t.mock.method(notices, "showAction");
      const clipboard = new Map();
      const exec = Object.getOwnPropertyDescriptor(document, "execCommand");
      Object.defineProperty(document, "execCommand", { configurable: true, value: name => {
        assert.equal(name, "copy");
        const event = new window.Event("copy", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { setData: (type, content) => clipboard.set(type, content) } });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      } });
      t.after(() => { if (exec) Object.defineProperty(document, "execCommand", exec); else delete document.execCommand; });
      document.activeElement?.blur();
      selectBeats("r2", "r3");
      assert.equal(document.body.classList.contains("has-scene-selection"), true);
      const selection = document.getElementById("scene-selection-style").textContent;
      assert.match(selection, /data-id="r2"/);
      assert.match(selection, /data-id="r3"/);
      let calls = 0;
      const stop = f.beforeCommand(() => {
        calls++;
        if (mode === "silent") return false;
        if (mode !== "announced") return true;
        notices.show("Held by the listener.", "warn");
        return SHARED_ADMISSION_ANNOUNCED;
      });
      const release = mode === "capability" ? f.refuseEdit() : mode === "hold" ? f.hold() : () => {};
      const errors = [];
      const observe = event => { errors.push(event.error?.message); event.preventDefault(); };
      window.addEventListener("error", observe);
      try {
        if (route === "keyboard") {
          assert.equal(key(document.body, command === "cut" ? "x" : "Delete", command === "cut" ? { ctrlKey: true } : {}), true);
        } else {
          const menu = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
          f.cell("r2").dispatchEvent(menu);
          assert.equal(menu.defaultPrevented, true);
          document.querySelector(`#scene-menu [data-scene-action="${command}"]`).click();
          assert.equal(document.querySelector("#scene-menu").hidden, true);
        }
        assert.equal(document.body.classList.contains("has-scene-selection"), true);
        assert.equal(document.getElementById("scene-selection-style").textContent, selection);
        assert.deepEqual(app(), before);
        assert.deepEqual(f.native.document(), before);
        assert.deepEqual(f.peer.document(), before);
        assert.deepEqual(f.native.encodeState(), native);
        assert.deepEqual(f.peer.encodeState(), peer);
        assert.deepEqual(undoOwner().sizes(), standalone);
        assert.equal(action.mock.callCount(), 0);
        if (command === "cut") {
          const clip = parseBeatPayload(clipboard.get(BEATS_MIME));
          assert.deepEqual(clip.rows.map(({ audioText, visualText }) => [audioText, visualText]), [["Other", "Scene"], ["Third", "Final"]]);
          assert.ok(clip.cut);
          assert.match(clipboard.get("text/plain"), /Other[\s\S]*Third/);
          assert.match(clipboard.get("text/html"), /Other[\s\S]*Third/);
        } else assert.equal(clipboard.size, 0);
        assert.equal(calls, 0);
        assert.deepEqual(f.notices(), []);
        assert.deepEqual(errors, ["standalone only while the session is shared: held"]);
      } finally {
        window.removeEventListener("error", observe);
        release();
        stop();
      }
      for (const copy of [f.native, f.peer]) {
        assert.deepEqual(copy.commands.undo(), { kind: "unchanged" });
        assert.deepEqual(copy.commands.redo(), { kind: "unchanged" });
      }
    });
  }
}

const refusalGestures = [
  ["Ctrl+Enter", f => () => assert.equal(key(f.place("r1", 3), "Enter", { ctrlKey: true }), true)],
  ["Alt+Enter", f => () => assert.equal(key(f.place("r1", 3), "Enter", { altKey: true }), true)],
  ["add bar", () => () => document.querySelector(".add-row-bar [data-action=add-row]").click()],
  ["scene menu", () => () => document.querySelector('[data-section-id="s1"] [data-section-action="remove"]').click()],
  ["status chip", () => () => document.querySelector('[data-action="cycle-status"][data-id="r1"]').click()],
  ["Filmed", () => () => setBeatFilmed("r1", true)],
  ["Filmed box", (_f, t) => {
    openProductionPanel();
    document.querySelector('#production-modes [data-group="cat"]').click();
    document.querySelector('#production-modes [data-group="prep"]').click();
    t.after(() => document.getElementById("production-close").click());
    const selector = '.prep-film-input[data-row="r1"]';
    if (!document.querySelector(selector)) document.querySelector(".prep-scene-head").click();
    const filmed = document.querySelector(selector);
    assert.ok(filmed);
    assert.equal(filmed.checked, false);
    return () => filmed.click();
  }],
  ["read-time", () => {
    document.querySelector('.row-read[data-id="r1"]').click();
    const box = document.querySelector(".row-read-input");
    box.value = "42";
    return () => assert.equal(key(box, "Enter"), true);
  }],
  ["rundown target", () => () => setTargetLength(90)],
  ["title target", () => {
    promptForTarget();
    const box = document.getElementById("target-input");
    box.value = "2:00";
    return () => assert.equal(key(box, "Enter"), true);
  }],
  ["title WPM", () => {
    promptForWpm();
    document.getElementById("wpm-input").value = "180";
    return () => document.getElementById("wpm-save").click();
  }]
];

const nativeCallerWrites = new Map([
  ["Ctrl+Enter", () => assert.deepEqual(audio(app()), ["abcdef", "", "Other", "Third"])],
  ["Alt+Enter", () => assert.deepEqual(audio(app()), ["abc", "def", "Other", "Third"])],
  ["add bar", () => assert.deepEqual(audio(app()), ["abcdef", "Other", "Third", ""])],
  ["scene menu", () => assert.equal(app().sections, undefined)],
  ["status chip", () => assert.equal(app().rows[0].status, "ready")],
  ["Filmed", () => assert.equal(app().rows[0].status, "shot")],
  ["Filmed box", () => assert.equal(app().rows[0].status, "shot")],
  ["read-time", () => assert.equal(app().rows[0].lengthSeconds, 42)]
]);
const listenerWarning = ["Held by the listener.", "warn"];

for (const [name, prepare] of refusalGestures) for (const mode of ["allowed", "capability", "hold", "silent", "announced"]) {
  test(`Native caller admission: ${name}, ${mode}`, async t => {
    const f = await enter(t, { sections: [{ id: "s1", name: "Scene", firstSceneId: "r2" }], wordsPerMinute: 150 });
    const action = t.mock.method(notices, "showAction");
    const act = prepare(f, t);
    let calls = 0;
    const stop = f.beforeCommand(() => {
      calls++;
      if (mode === "silent") return false;
      if (mode !== "announced") return true;
      notices.show(...listenerWarning);
      return SHARED_ADMISSION_ANNOUNCED;
    });
    const release = mode === "capability" ? f.refuseEdit() : mode === "hold" ? f.hold() : () => {};
    const before = structuredClone(app()), native = f.native.encodeState(), peer = f.peer.encodeState();
    const sizes = undoOwner().sizes();
    try {
      act();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(undoOwner().sizes(), sizes);
      assert.equal(action.mock.callCount(), 0);
      const verifyWrite = nativeCallerWrites.get(name);
      const preflight = name === "scene menu" && mode === "capability";
      const filmedNotice = name === "Filmed box" ? [["Beat marked as Filmed", "ok"]] : [];
      assert.equal(calls, mode === "hold" || preflight ? 0 : 1);
      if (mode === "allowed" && verifyWrite) {
        verifyWrite();
        assert.deepEqual(f.notices(), filmedNotice);
        send(f.native, f.peer);
        assert.deepEqual(f.native.document(), app());
        assert.deepEqual(f.peer.document(), app());
        return;
      }
      const expected = mode === "announced" ? name === "Alt+Enter" ? [listenerWarning, warning] : [listenerWarning]
        : preflight || (!verifyWrite && (mode === "hold" || mode === "silent")) ? [] : [warning];
      assert.deepEqual(f.notices(), [...expected, ...filmedNotice]);
      assert.deepEqual(app(), before);
      assert.deepEqual(f.native.document(), before);
      assert.deepEqual(f.peer.document(), before);
      assert.deepEqual(f.native.encodeState(), native);
      assert.deepEqual(f.peer.encodeState(), peer);
    } finally { release(); stop(); }
    for (const copy of [f.native, f.peer]) {
      assert.deepEqual(copy.commands.undo(), { kind: "unchanged" });
      assert.deepEqual(copy.commands.redo(), { kind: "unchanged" });
    }
  });
}

for (const alreadyAnnounced of [false, true]) {
  test(`Split: Remove confirmation admits the command once and warns once, already announced=${alreadyAnnounced}`, async t => {
    const f = await enter(t, { renderNotices: true });
    const before = structuredClone(app()), nativeBefore = f.native.encodeState(), peerBefore = f.peer.encodeState();
    const standaloneHistory = undoOwner().sizes();
    const button = removeButton("r2");
    assert.deepEqual(cells(app())[1], ["r2", "Other", "Scene"]);
    button.click();
    assert.equal(button.classList.contains("armed"), true);
    assert.deepEqual(f.notices(), []);
    let admitted = 0;
    const stop = f.beforeCommand(() => {
      admitted++;
      if (!alreadyAnnounced) return false;
      notices.show(...warning);
      return SHARED_ADMISSION_ANNOUNCED;
    });
    try {
      button.click();
      await Promise.resolve();
      assert.equal(admitted, 1);
      assert.deepEqual(f.notices(), [warning]);
      assert.deepEqual(app(), before);
      assert.deepEqual(f.native.document(), before);
      assert.deepEqual(f.peer.document(), before);
      assert.deepEqual(f.native.encodeState(), nativeBefore);
      assert.deepEqual(f.peer.encodeState(), peerBefore);
      assert.deepEqual(undoOwner().sizes(), standaloneHistory);
    } finally { stop(); }
    for (const copy of [f.native, f.peer]) {
      assert.deepEqual(copy.commands.undo(), { kind: "unchanged" });
      assert.deepEqual(copy.commands.redo(), { kind: "unchanged" });
    }
  });
}

test("Split: a peer picture before a local deletion stays in the original beat through Undo and Redo", async t => {
  const f = await enter(t, { rows: [{ id: "R1", audioText: "abcdef" }] });
  const ref = { sha256: "c".repeat(64), width: 3, height: 3, mime: "image/png" };
  const at = f.peer.commands.anchorText({ beat: "R1", cell: "narration" }, 2);
  assert.equal(at.kind, "anchored");
  written(f.peer.commands.replaceText(at.range, [{ atom: "image", ref, text: "", marks: {} }]));
  send(f.peer, f.native);
  await Promise.resolve();
  const picture = f.cell("R1").querySelector("img");
  assert.ok(picture);
  const original = app().rows[0].audioText;
  assert.equal(text(f.cell("R1")), "abcdef");
  assert.equal(input(f.place("R1", 4, 5), "deleteContentBackward"), true);
  flush();
  const deleted = app().rows[0].audioText;
  assert.equal(text(f.cell("R1")), "abcef");
  history(f.cell("R1"));
  agree(f, [original]);
  assert.ok(f.cell("R1").querySelector("img"));
  caret(f, "R1", 4, 5);
  history(f.cell("R1"), true);
  agree(f, [deleted]);
  assert.ok(f.cell("R1").querySelector("img"));
  caret(f, "R1", 4);
  assert.deepEqual(f.notices(), []);
});

for (const operation of ["insert", "join"]) {
  test(`Split: Remove arms before draining a held peer ${operation} and checks the beat on confirmation`, async t => {
    const f = await enter(t);
    assert.equal(input(f.place("r1", 6), "insertText", "X"), true);
    const id = operation === "insert" ? written(f.peer.commands.insertAdjacentBeat("r1", "below")).created : null;
    if (operation === "join") written(f.peer.commands.joinRow("r2", "r1", " "));
    send(f.peer, f.native);
    await Promise.resolve();
    const button = removeButton("r2");
    button.click();
    assert.equal(text(f.cell()), "abcdefX");
    assert.equal(button.isConnected, true);
    assert.equal(button.classList.contains("armed"), true);
    assert.equal(document.querySelectorAll("#rows .armed").length, 1);
    assert.deepEqual(audio(app()), ["abcdef", "Other", "Third"]);
    assert.deepEqual(f.notices(), []);
    button.click();
    await Promise.resolve();
    if (operation === "insert") {
      agree(f, ["abcdefX", "", "Third"]);
      assert.deepEqual(app().rows.map(row => row.id), ["r1", id, "r3"]);
      assert.deepEqual(f.notices(), []);
      history(f.cell());
      agree(f, ["abcdefX", "", "Other", "Third"]);
      history(f.cell());
      agree(f, ["abcdef", "", "Other", "Third"]);
    } else {
      agree(f, ["abcdefX Other", "Third"]);
      assert.deepEqual(f.notices(), [warning]);
      history(f.cell());
      agree(f, ["abcdef Other", "Third"]);
    }
    assert.equal(document.querySelectorAll("#rows .armed").length, 0);
  });
}

test("Split: a peer split before the selection requires a new selection for Alt+Enter and Ctrl+Enter", async t => {
  for (const modifiers of [{ altKey: true }, { ctrlKey: true }]) await t.test(JSON.stringify(modifiers), async sub => {
    const f = await enter(sub, { rows: [{ id: "r1", audioText: "abcdefgh" }, ...source.slice(1)] });
    assert.equal(input(f.place("r1", 1), "insertText", "X"), true);
    f.place("r1", 6, 8);
    const id = splitPeer(f.peer, "r1", 4);
    send(f.peer, f.native);
    await Promise.resolve();
    assert.deepEqual(audio(app()), ["abcdefgh", "Other", "Third"]);
    assert.equal(key(f.cell(), "Enter", modifiers), true);
    agree(f, ["aXbcd", "efgh", "Other", "Third"]);
    assert.deepEqual(f.notices(), [warning]);
    assert.equal(key(f.place(id, 1), "Enter", modifiers), true);
    agree(f, modifiers.altKey ? ["aXbcd", "e", "fgh", "Other", "Third"] : ["aXbcd", "efgh", "", "Other", "Third"]);
    history(document.activeElement);
    agree(f, ["aXbcd", "efgh", "Other", "Third"]);
    history(document.activeElement);
    agree(f, ["abcd", "efgh", "Other", "Third"]);
    assert.deepEqual(f.notices(), [warning]);
  });
});

test("Split: Narration and Visual keep focus and local history around peer typing", async t => {
  const f = await enter(t, { rows: [{ id: "r1", audioText: "Hello", visualText: "Look" },
    { id: "r2", audioText: "World", visualText: "Wide" }] });
  const state = expected => {
    agree(f, expected.map(row => row[0]));
    assert.deepEqual(cells(app()), expected.map(([audioText, visualText], i) => ["r" + (i + 1), audioText, visualText]));
  };
  assert.equal(input(f.place("r1", 5), "insertText", "x"), true);
  edit(f.peer, "r1", 0, 0, "Y");
  send(f.peer, f.native);
  await Promise.resolve();
  flush();
  state([["YHellox", "Look"], ["World", "Wide"]]);
  caret(f, "r1", 7);
  assert.equal(input(f.cell(), "insertText", "z"), true);
  flush();
  state([["YHelloxz", "Look"], ["World", "Wide"]]);
  caret(f, "r1", 8);
  history(f.cell());
  state([["YHello", "Look"], ["World", "Wide"]]);
  history(f.cell(), true);
  state([["YHelloxz", "Look"], ["World", "Wide"]]);
  history(f.cell());
  state([["YHello", "Look"], ["World", "Wide"]]);
  assert.equal(input(f.cell(), "insertText", "x"), true);
  flush();
  state([["YHellox", "Look"], ["World", "Wide"]]);

  const visual = () => f.cell("r1", "visualText");
  assert.equal(input(f.place("r1", 4, 4, "visualText"), "insertText", "s"), true);
  state([["YHellox", "Looks"], ["World", "Wide"]]);
  delivery(f.native, "duplicate", ...packets(f.peer, () => edit(f.peer, "r1", 0, 0, "B", "visual")));
  await Promise.resolve();
  state([["YHellox", "BLooks"], ["World", "Wide"]]);
  caret(f, "r1", 6, 6, "visualText");
  assert.equal(input(visual(), "insertText", "!"), true);
  state([["YHellox", "BLooks!"], ["World", "Wide"]]);
  history(visual());
  state([["YHellox", "BLook"], ["World", "Wide"]]);
  assert.equal(input(f.place("r2", 5), "insertText", "a"), true);
  delivery(f.native, "duplicate", ...packets(f.peer, () => edit(f.peer, "r2", 2, 2, "Q")));
  await Promise.resolve();
  flush();
  state([["YHellox", "BLook"], ["WoQrlda", "Wide"]]);
  caret(f, "r2", 7);
  history(f.cell("r2"));
  state([["YHellox", "BLook"], ["WoQrld", "Wide"]]);
  edit(f.peer, "r2", 0, 0, "Z", "visual");
  send(f.peer, f.native);
  await Promise.resolve();
  assert.equal(input(f.place("r2", 5, 5, "visualText"), "insertText", "k"), true);
  state([["YHellox", "BLook"], ["WoQrld", "ZWidek"]]);
  caret(f, "r2", 6, 6, "visualText");
  history(f.cell("r2", "visualText"));
  state([["YHellox", "BLook"], ["WoQrld", "ZWide"]]);
  assert.deepEqual(f.notices(), []);
  land(f, ["YHellox", "WoQrld"]);
  assert.equal(text(visual()), "BLook");
  assert.equal(text(f.cell("r2", "visualText")), "ZWide");
});

test("Writer: leaving Visual by Escape, Close or view switch keeps B-roll text without minting keys", async t => {
  const f = await enter(t, { view: "Writer", rows: source.map(row => ({ ...row, visualText: "" })) });
  const visual = id => {
    f.writer.writerFlowControl().openVisual(id);
    return f.place(id, 0, 0, "visualText");
  };
  const visualText = expected => {
    agree(f, ["abcdef", "Other", "Third"]);
    assert.deepEqual(app().rows.map(row => row.visualText), expected);
    assert.deepEqual(app().brollShots, []);
  };
  const first = visual("r1");
  assert.equal(input(first, "insertText", "B-roll: Close up"), true);
  visualText(["B-roll: Close up", "", ""]);
  key(first, "Escape");
  assert.equal(document.querySelector(".wr-flow-visual-box").hidden, true);
  visualText(["B-roll: Close up", "", ""]);
  const late = openCopy(t, f.native.encodeState(), "Reader");
  assert.deepEqual(late.document(), app());
  history(f.root());
  visualText(["", "", ""]);
  history(document.activeElement, true);
  visualText(["B-roll: Close up", "", ""]);

  assert.equal(input(visual("r2"), "insertText", "B-roll: Mug"), true);
  document.getElementById("wr-close").click();
  assert.equal(document.getElementById("writer").hidden, true);
  visualText(["B-roll: Close up", "B-roll: Mug", ""]);
  f.writer.openWriter();
  assert.equal(input(visual("r3"), "insertText", "B-roll: Pour"), true);
  f.writer.closeWriter();
  assert.equal(document.getElementById("writer").hidden, true);
  visualText(["B-roll: Close up", "B-roll: Mug", "B-roll: Pour"]);
  assert.deepEqual(f.notices(), []);
  land(f, ["abcdef", "Other", "Third"]);
  assert.deepEqual(app().rows.map(row => row.visualText), ["B-roll: Close up", "B-roll: Mug", "B-roll: Pour"]);
});

for (const order of orders) {
  test(`Split Visual: Tab refuses a person suggestion once, ${order}`, async t => {
    const f = await enter(t, {
      rows: [{ ...source[0], visualText: "@Presenter" }, ...source.slice(1)],
      people: [{ id: "p1", name: "Presenter" }]
    });
    const updates = packets(f.peer, () => {
      edit(f.peer, "r2", 0, 0, "P");
      edit(f.peer, "r2", 1, 1, "Q");
    });
    assert.equal(updates.length, 2);
    delivery(f.native, order, ...updates);
    await Promise.resolve();
    assert.deepEqual(f.native.document(), f.peer.document());
    assert.deepEqual(app(), f.peer.document());
    const node = f.place("r1", 1, 1, "visualText");
    const who = currentWhoList();
    t.after(() => who.cancel());
    who.maybeOpen({ inputType: "insertText", data: "@" }, node);
    assert.equal(who.isOpen(node), true);
    assert.equal(document.querySelector("#who-list .who-option").textContent, "Presenter");
    assert.equal(text(node), "@Presenter");
    caret(f, "r1", 1, 1, "visualText");
    const before = selectionSnapshot(node), bytes = f.native.encodeState(), projected = JSON.stringify(app());
    assert.equal(key(node, "Tab"), true);
    assert.deepEqual(selectionSnapshot(node), before);
    assert.deepEqual(f.native.encodeState(), bytes);
    assert.equal(JSON.stringify(app()), projected);
    assert.deepEqual(f.notices(), [warning]);
  });
}

function transfer(target, type, types) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "drop" ? "dataTransfer" : "clipboardData", { value: {
    files: [], types, getData: format => format === "text/plain" ? "pasted" : "",
    setData: () => assert.fail("Shared transfer unexpectedly wrote to the clipboard")
  } });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

for (const field of ["audioText", "visualText"]) {
  test(`Split ${field}: composing transfers warn per gesture and keep the draft and selection`, async t => {
    const f = await enter(t);
    const node = f.place("r1", 3, 3, field);
    assert.equal(compose(node, "start"), false);
    composePreview(node, "X");
    const before = selectionSnapshot(node), state = f.native.encodeState();
    const plain = ["text/plain"], rich = ["text/plain", "text/html"];
    const refuse = (gesture, warned) => {
      const beforeCount = f.notices().length;
      assert.equal(gesture(), true);
      assert.deepEqual(f.notices().slice(beforeCount), warned ? [warning] : []);
      assert.deepEqual(selectionSnapshot(node), before);
      assert.deepEqual(f.native.encodeState(), state);
    };
    refuse(() => transfer(node, "paste", plain), true);
    refuse(() => transfer(node, "paste", plain), false);
    refuse(() => input(node, "insertFromPaste"), false);
    refuse(() => transfer(node, "paste", rich), true);
    refuse(() => transfer(node, "cut", plain), true);
    refuse(() => transfer(node, "drop", plain), true);
    refuse(() => transfer(f.cell("r2", field), "drop", plain), true);
    compose(node, "end", "X");
    agree(f, [field === "audioText" ? "abcXdef" : "abcdef", "Other", "Third"]);
    assert.equal(app().rows[0].visualText, field === "visualText" ? "WidXe" : "Wide");
  });
}

test("Split: Alt+Arrow moves a live beat and replays its caret", async t => {
  const f = await enter(t);
  const node = f.place("r2", 2);
  assert.equal(key(node, "ArrowUp", { altKey: true }), true);
  agree(f, ["Other", "abcdef", "Third"]);
  assert.deepEqual(cells(app()), [["r2", "Other", "Scene"], ["r1", "abcdef", "Wide"], ["r3", "Third", "Final"]]);
  caret(f, "r2", 2);
  assert.equal(key(f.cell("r2"), "ArrowDown", { altKey: true }), true);
  agree(f, ["abcdef", "Other", "Third"]);
  caret(f, "r2", 2);
  assert.deepEqual(f.notices(), []);
});

test("Split: a prefix before the displayed Find match leaves both fields usable and replaces on the first click", async t => {
  const f = await enter(t, { rows: [{ id: "r1", audioText: "green tea" }] });
  assert.equal(appActions.invoke("find", "menu").kind, "ran");
  t.after(() => document.getElementById("find-close").click());
  const find = document.getElementById("find-input"), replace = document.getElementById("replace-input");
  const fields = () => [find.value, replace.value, find.disabled, replace.disabled, document.activeElement];
  const matchCount = () => document.getElementById("find-count").textContent;
  assert.equal(document.activeElement, find);
  find.value = "tea";
  find.dispatchEvent(new window.Event("input", { bubbles: true }));
  replace.value = "pot";
  replace.focus();
  assert.equal(matchCount(), "1 of 1");
  edit(f.peer, "r1", 0, 0, "X");
  send(f.peer, f.native);
  await Promise.resolve();
  agree(f, ["Xgreen tea"]);
  document.getElementById("find-replace").click();
  agree(f, ["Xgreen pot"]);
  assert.deepEqual(fields(), ["tea", "pot", false, false, replace]);
  assert.equal(text(f.cell()), "Xgreen pot");
  assert.deepEqual(f.notices(), []);
  land(f, ["Xgreen pot"]);
  assert.equal(text(f.cell()), "Xgreen pot");
});

const settledRows = [
  { id: "r1", audioText: "abcdef", visualText: "Wide", status: "todo" },
  { id: "r2", audioText: "Other", visualText: "", status: "todo" },
  { id: "r3", audioText: "Third", visualText: "", status: "todo" }
];
const settledSections = [{ id: "s1", name: "Scene", firstSceneId: "r3" }];
const exchanges = ["local-first", "remote-first"];

function withoutEditStamps(doc) {
  const copy = structuredClone(doc);
  for (const row of copy.rows) {
    delete row.updatedAt;
    delete row.updatedBy;
  }
  return copy;
}

async function enterSettled(t, narration = "abcdef") {
  const f = await enter(t, {
    rows: [{ ...settledRows[0], audioText: narration }, ...settledRows.slice(1)],
    sections: settledSections,
    wordsPerMinute: 150,
    renderNotices: true
  });
  const before = structuredClone(app());
  assert.deepEqual(before.sections, settledSections);
  assert.equal(before.wordsPerMinute, 150);
  assert.equal(before.targetSeconds ?? null, null);
  assert.deepEqual(f.peer.document(), before);
  return { ...f, before };
}

function freshAgreement(f) {
  const fresh = openNativeSession({ kind: "state", state: f.native.encodeState() }, { actor: "Reader", sanitize: sanitizeHtml });
  try {
    assert.deepEqual(f.peer.document(), f.native.document());
    assert.deepEqual(fresh.document(), f.native.document());
  } finally { fresh.close(); }
}

function exchangeSettled(f, order) {
  if (order === "local-first") {
    send(f.native, f.peer);
    send(f.peer, f.native);
  } else {
    send(f.peer, f.native);
    send(f.native, f.peer);
  }
}

for (const order of exchanges) {
  test(`Writer: Redo of a trailing member deletion restores the caret in the joined row, ${order}`, async t => {
    const rows = ["Lead", "aa", "a"].map((audioText, index) => ({ id: "r" + (index + 1), audioText }));
    const f = await enter(t, { rows, view: "Writer" });
    const root = f.place("r3", 0, 1);
    assert.equal(input(root, "deleteContentBackward"), true);
    flush();
    assert.deepEqual(audio(app()), ["Lead", "aa", ""]);
    written(f.peer.commands.joinRow("r3", "r2", " "));
    exchangeSettled(f, order);
    await Promise.resolve();
    agree(f, ["Lead", "aa"]);

    history(root);
    agree(f, ["Lead", "aa a"]);
    caret(f, "r2", 3, 4);
    history(root, true);
    agree(f, ["Lead", "aa"]);
    caret(f, "r2", 2);

    assert.equal(input(root, "insertText", "x"), true);
    flush();
    agree(f, ["Lead", "aax"]);
    caret(f, "r2", 3);
    history(root);
    agree(f, ["Lead", "aa"]);
    land(f, ["Lead", "aa"]);
  });
}

function settledAgreement(f, order, rows) {
  exchangeSettled(f, order);
  const expected = withoutEditStamps({ ...f.before, rows });
  assert.deepEqual(withoutEditStamps(app()), expected);
  assert.deepEqual(f.native.document(), app());
  freshAgreement(f);
}

function leaveSettled(f) {
  const expected = withoutEditStamps(migrateRows(structuredClone(app())));
  f.place("r3", 0);
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.equal(sharedSession(), false);
  assert.equal(f.native.isClosingOrClosed(), true);
  assert.notEqual(app().docId, expected.docId);
  const landed = withoutEditStamps(app());
  assert.deepEqual({ ...landed, docId: expected.docId }, expected);
  f.cell("r3").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.deepEqual(listenerInventory(), f.baseline);
}

function draftTyping(f, offset, from = offset + 1, to = from) {
  assert.equal(input(f.place("r1", offset), "insertText", "X"), true);
  const original = f.before.rows[0].audioText;
  const draft = original.slice(0, offset) + "X" + original.slice(offset);
  assert.equal(text(f.cell()), draft);
  assert.deepEqual(app(), f.before);
  f.place("r1", from, to);
  return draft;
}

const narrationOf = (row, audioText) => ({ ...row, audioText });

function freshBeat(f, author, id, audioText, blank = false) {
  assert.ok(id && !f.before.rows.some(row => row.id === id));
  assert.match(id, new RegExp("^r" + author.ydoc.clientID.toString(36) + "-[0-9a-z]+$"));
  return { id, audioText, visualText: "", ...(blank ? { status: "todo" } : {}) };
}

for (const order of exchanges) for (const action of ["arm only", "confirm insert", "confirm join"]) {
  test(`Split settled Remove: ${action}, ${order}`, async t => {
    const f = await enterSettled(t);
    const [first, target, last] = f.before.rows;
    draftTyping(f, 6);
    const joined = action === "confirm join";
    const inserted = joined ? null : freshBeat(f, f.peer, written(f.peer.commands.insertAdjacentBeat("r1", "below")).created, "", true);
    if (joined) written(f.peer.commands.joinRow("r2", "r1", " "));
    const remoteRows = joined ? [narrationOf(first, "abcdef Other"), last] : [first, inserted, target, last];
    send(f.peer, f.native);
    await Promise.resolve();
    assert.deepEqual(app(), f.before);
    const button = removeButton("r2");
    button.click();
    assert.equal(button.isConnected, true);
    assert.equal(removeButton("r2"), button);
    assert.equal(button.classList.contains("armed"), true);
    assert.equal(document.querySelectorAll("#rows .armed").length, 1);
    assert.equal(text(f.cell()), "abcdefX");
    assert.deepEqual(app(), f.before);
    exchangeSettled(f, order);
    assert.deepEqual(withoutEditStamps(f.native.document()), withoutEditStamps({ ...f.before, rows: remoteRows }));
    freshAgreement(f);
    assert.deepEqual(f.notices(), []);
    const typed = narrationOf(first, joined ? "abcdefX Other" : "abcdefX");
    if (action === "arm only") {
      flush();
      settledAgreement(f, order, [typed, inserted, target, last]);
      assert.deepEqual(f.notices(), []);
    } else {
      button.click();
      await Promise.resolve();
      settledAgreement(f, order, joined ? [typed, last] : [typed, inserted, last]);
      assert.equal(removeButton("r2"), null);
      assert.equal(document.querySelectorAll("#rows .armed").length, 0);
      assert.deepEqual(f.notices(), joined ? [warning] : []);
      if (!joined) {
        history(f.cell("r3"));
        settledAgreement(f, order, [typed, inserted, target, last]);
      }
      history(f.cell("r3"));
      settledAgreement(f, order, remoteRows);
      history(f.cell("r3"));
      settledAgreement(f, order, remoteRows);
      assert.deepEqual(f.notices(), joined ? [warning] : []);
    }
    leaveSettled(f);
  });
}

const typedOffsets = { before: [1, 3, 7], inside: [4, 2, 7], after: [7, 2, 6] };
const peerOffsets = { before: 0, inside: 3, after: 8 };
const untypedText = { before: "Zabcdefgh", inside: "abcZdefgh", after: "abcdefghZ" };
const mergedText = {
  before: ["ZaXbcdefgh", "aXbcZdefgh", "aXbcdefghZ"],
  inside: ["ZabcdXefgh", "abcZdXefgh", "abcdXefghZ"],
  after: ["ZabcdefgXh", "abcZdefgXh", "abcdefgXhZ"]
};
const splitText = { before: ["aXb", "gh"], inside: ["ab", "gh"], after: ["ab", "gXh"] };

function pasteSettled(f, payload) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    types: [BEATS_MIME, "text/plain"],
    getData: type => type === BEATS_MIME ? payload.json : type === "text/plain" ? payload.text : ""
  } });
  f.cell().dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}

for (const order of exchanges) for (const [typed, offsets] of Object.entries(typedOffsets)) {
  for (const [index, [peer, offset]] of Object.entries(peerOffsets).entries()) for (const caller of ["Alt+Enter", "Ctrl+Enter", "beat paste"]) {
    test(`Split settled offsets: ${caller}, typing ${typed}, peer ${peer}, ${order}`, async t => {
      const f = await enterSettled(t, "abcdefgh");
      const [first, other, last] = f.before.rows;
      const payload = buildBeatPayload(f.before, ["r2"], {});
      const draft = draftTyping(f, ...offsets);
      edit(f.peer, "r1", offset, offset, "Z");
      send(f.peer, f.native);
      await Promise.resolve();
      assert.deepEqual(app(), f.before);
      assert.deepEqual(withoutEditStamps(f.native.document()), withoutEditStamps({
        ...f.before, rows: [narrationOf(first, untypedText[peer]), other, last]
      }));
      const refused = caller === "beat paste";
      if (refused) {
        const selection = selectionSnapshot(f.cell());
        const bytes = f.native.encodeState();
        pasteSettled(f, payload);
        assert.deepEqual(f.notices(), [warning]);
        assert.deepEqual(selectionSnapshot(f.cell()), selection);
        assert.equal(text(f.cell()), draft);
        assert.deepEqual(app(), f.before);
        assert.deepEqual(f.native.encodeState(), bytes);
        flush();
      } else {
        assert.equal(key(f.cell(), "Enter", caller === "Alt+Enter" ? { altKey: true } : { ctrlKey: true }), true);
        assert.deepEqual(f.notices(), []);
      }
      const typedRows = [narrationOf(first, mergedText[typed][index]), other, last];
      let finalRows = typedRows;
      if (!refused) {
        const [head, tail] = splitText[typed];
        const left = caller === "Ctrl+Enter" ? mergedText[typed][index] : peer === "before" ? "Z" + head : head;
        const right = caller === "Ctrl+Enter" ? "" : peer === "after" ? tail + "Z" : tail;
        finalRows = [narrationOf(first, left), freshBeat(f, f.native, app().rows[1].id, right, caller === "Ctrl+Enter"), other, last];
      }
      settledAgreement(f, order, finalRows);
      if (!refused) {
        history(f.cell("r3"));
        settledAgreement(f, order, typedRows);
      }
      const remoteRows = [narrationOf(first, untypedText[peer]), other, last];
      history(f.cell("r3"));
      settledAgreement(f, order, remoteRows);
      history(f.cell("r3"));
      settledAgreement(f, order, remoteRows);
      history(f.cell("r3"), true);
      settledAgreement(f, order, typedRows);
      if (!refused) {
        history(f.cell("r3"), true);
        settledAgreement(f, order, finalRows);
      }
      history(f.cell("r3"), true);
      settledAgreement(f, order, finalRows);
      assert.deepEqual(f.notices(), refused ? [warning] : []);
      leaveSettled(f);
    });
  }
}

for (const order of exchanges) test(`Split settled prefix: Alt+Enter leaves Zab and ef, ${order}`, async t => {
  const f = await enterSettled(t);
  const [first, other, last] = f.before.rows;
  draftTyping(f, 3, 2, 5);
  edit(f.peer, "r1", 0, 0, "Z");
  send(f.peer, f.native);
  assert.deepEqual(app(), f.before);
  assert.equal(key(f.cell(), "Enter", { altKey: true }), true);
  settledAgreement(f, order, [narrationOf(first, "Zab"), freshBeat(f, f.native, app().rows[1].id, "ef"), other, last]);
  assert.deepEqual(f.notices(), []);
  leaveSettled(f);
});

test("Read-time Ctrl+Z undoes a native length edit and leaves standalone history alone", async t => {
  const f = await enter(t);
  const length = doc => doc.rows.find(row => row.id === "r1").lengthSeconds;
  const before = length(app());
  const standalone = undoOwner().sizes();
  assert.equal(setBeatLength("r1", 42), true);
  await Promise.resolve();
  assert.equal(length(app()), 42);
  const button = document.querySelector('#rows .row-read[data-id="r1"]');
  assert.ok(button);
  button.focus();
  assert.equal(key(button, "z", { ctrlKey: true }), true);
  await Promise.resolve();
  send(f.native, f.peer);
  assert.deepEqual([length(app()), length(f.peer.document())], [before, before]);
  assert.deepEqual(undoOwner().sizes(), standalone);
  assert.deepEqual(f.notices(), []);
});

test("Command refusal notices distinguish silent, previously announced and no-op outcomes", async t => {
  const f = await enter(t);
  const before = f.notices().length;
  sharedRecordCommands.refused({ kind: "rejected", reason: "buffer-pending", notified: true });
  sharedRecordCommands.refused({ kind: "noop" });
  assert.deepEqual(f.notices().slice(before), []);
  sharedRecordCommands.refused({ kind: "rejected", reason: "buffer-pending" });
  assert.deepEqual(f.notices().slice(before), [warning]);
});
