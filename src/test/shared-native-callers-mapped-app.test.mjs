import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml } from "../bootstrap/richtext.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { appActions } from "../bootstrap/wiring/ports/actions.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { BEATS_MIME, buildBeatPayload } from "../features/clipboard/beat-clip.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
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

async function enter(t, { rows = source, view = "Split", openBeforeEntry = false } = {}) {
  const fixture = entrySwitchFixture();
  const doc = migrateRows({ schema: 2, title: "Shared callers", paragraphsDecided: true, rows });
  adoptReplacement(doc);
  const show = t.mock.method(notices, "show", () => {});
  const ports = { ...fixture.ports, commandRefused: sharedCommandRefusalNotice(notices) };
  const writer = writerControls();
  let native;
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
  if (openBeforeEntry) {
    writer.openWriter();
    place("r1", 5);
  }
  assert.deepEqual(await enterSharedSession(ports, (script, failed) => {
    const opened = openNativeEditor(ports, script, failed);
    native = opened.native;
    return opened.backend;
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
  if (view === "Writer" && !openBeforeEntry) writer.openWriter();
  return { native, peer, cell, place, root, writer, notices: () => show.mock.calls.map(call => call.arguments) };
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

for (const order of ["forward", "duplicate"]) {
  test(`Writer: a composed xy and a held peer prefix keep both edits, ${order}`, async t => {
    const f = await enter(t, { view: "Writer", rows: [{ id: "r1", audioText: "abcd" }, { id: "r2", audioText: "ef" }] });
    const root = f.place("r1", 2);
    assert.equal(compose(root, "start"), false);
    composePreview(root, "x");
    composePreview(root, "y");
    assert.equal(text(f.cell()), "abxycd");
    edit(f.peer, "r1", 0, 0, "Z");
    delivery(f.native, order, f.peer.encodeState());
    await Promise.resolve();
    assert.deepEqual(audio(app()), ["abcd", "ef"]);
    assert.deepEqual(audio(f.native.document()), ["Zabcd", "ef"]);
    compose(root, "end", "xy");
    agree(f, ["Zabxycd", "ef"]);
    assert.equal(text(f.cell()), "Zabxycd");
    caret(f, "r1", 5);
    history(root);
    agree(f, ["Zabcd", "ef"]);
    assert.equal(text(f.cell("r2")), "ef");
    caret(f, "r1", 3);
    assert.deepEqual(f.notices(), []);
    land(f, ["Zabcd", "ef"]);
    assert.equal(text(f.cell()), "Zabcd");
  });

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

test("Writer: entry caret survives reverse and duplicate exchange, undo, redo and leave", async t => {
  const f = await enter(t, { view: "Writer", openBeforeEntry: true,
    rows: [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }] });
  caret(f, "r1", 5);
  const root = f.root();
  assert.equal(input(root, "insertText", "x"), true);
  flush();
  assert.deepEqual(audio(app()), ["Hellox", "World"]);
  caret(f, "r1", 6);
  const updates = packets(f.peer, () => {
    edit(f.peer, "r1", 0, 0, "Y");
    edit(f.peer, "r2", 5, 5, "!");
  });
  assert.deepEqual(audio(f.peer.document()), ["YHello", "World!"]);
  delivery(f.native, "reverse", ...updates);
  await Promise.resolve();
  agree(f, ["YHellox", "World!"]);
  assert.equal(text(f.cell()), "YHellox");
  assert.equal(text(f.cell("r2")), "World!");
  f.place("r1", 0);
  history(root);
  agree(f, ["YHello", "World!"]);
  caret(f, "r1", 6);
  history(root, true);
  agree(f, ["YHellox", "World!"]);
  caret(f, "r1", 7);
  assert.equal(input(root, "insertText", "q"), true);
  flush();
  assert.deepEqual(audio(app()), ["YHelloxq", "World!"]);
  delivery(f.native, "duplicate", ...packets(f.peer, () => edit(f.peer, "r2", 6, 6, "Z")));
  await Promise.resolve();
  agree(f, ["YHelloxq", "World!Z"]);
  caret(f, "r1", 8);
  assert.deepEqual(f.notices(), []);
  land(f, ["YHelloxq", "World!Z"]);
  assert.equal(text(f.cell()), "YHelloxq");
  assert.equal(text(f.cell("r2")), "World!Z");
});

for (const order of ["forward", "duplicate"]) {
  test(`Writer: buffered append keeps a held prefix and undo keeps only the prefix, ${order}`, async t => {
    const f = await enter(t, { view: "Writer", rows: [{ id: "r1", audioText: "ab" }] });
    const root = f.place("r1", 2);
    assert.equal(input(root, "insertText", "c"), true);
    assert.equal(text(f.cell()), "abc");
    delivery(f.native, order, ...packets(f.peer, () => edit(f.peer, "r1", 0, 0, "X")));
    await Promise.resolve();
    assert.deepEqual(audio(app()), ["ab"]);
    flush();
    agree(f, ["Xabc"]);
    caret(f, "r1", 4);
    history(root);
    agree(f, ["Xab"]);
    caret(f, "r1", 3);
    assert.deepEqual(f.notices(), []);
    land(f, ["Xab"]);
  });
}

test("Writer: composition at the second beat keeps a peer append to the first beat", async t => {
  const f = await enter(t, { view: "Writer", rows: [{ id: "r1", audioText: "ab" }, { id: "r2", audioText: "cd" }] });
  const root = f.place("r2", 0);
  assert.equal(compose(root, "start"), false);
  composePreview(root, "Z");
  edit(f.peer, "r1", 2, 2, "Y");
  send(f.peer, f.native);
  await Promise.resolve();
  assert.deepEqual(audio(app()), ["ab", "cd"]);
  compose(root, "end", "Z");
  agree(f, ["abY", "Zcd"]);
  caret(f, "r2", 1);
  history(root);
  agree(f, ["abY", "cd"]);
  caret(f, "r2", 0);
  assert.deepEqual(f.notices(), []);
  land(f, ["abY", "cd"]);
});

for (const field of ["audioText", "visualText"]) for (const order of orders) {
  test(`Split ${field}: a drained removal keeps the composed draft visible and unwritten, ${order}`, async t => {
    const f = await enter(t);
    const node = f.place("r1", 3, 3, field);
    assert.equal(compose(node, "start"), false);
    composePreview(node, "X");
    delivery(f.native, order, ...packets(f.peer, () => {
      written(f.peer.commands.removeRows(["r1"]));
      edit(f.peer, "r2", 0, 0, "Z");
    }));
    await Promise.resolve();
    assert.deepEqual(audio(app()), ["abcdef", "Other", "Third"]);
    const bytes = f.native.encodeState();
    compose(node, "end", "X");
    assert.deepEqual(f.native.encodeState(), bytes);
    assert.deepEqual(f.native.document(), f.peer.document());
    assert.deepEqual(cells(f.native.document()), [["r2", "ZOther", "Scene"], ["r3", "Third", "Final"]]);
    assert.deepEqual(audio(app()), ["abcdef", "Other", "Third"]);
    assert.equal(text(node), field === "audioText" ? "abcXdef" : "WidXe");
    assert.ok(node.isConnected);
    caret(f, "r1", 4, 4, field);
    assert.deepEqual(f.notices(), [warning]);
    assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "missing" });
    assert.equal(text(node), field === "audioText" ? "abcXdef" : "WidXe");
    assert.deepEqual(f.notices(), [warning]);
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

test("Split: passive late readers from either copy agree, and an editable joiner undoes only its own changes", async t => {
  const f = await enter(t);
  assert.equal(input(f.place("r1", 6), "insertText", "?"), true);
  flush();
  edit(f.peer, "r1", 0, 0, "B", "visual");
  written(f.peer.commands.removeRows(["r2"]));
  send(f.peer, f.native);
  await Promise.resolve();
  agree(f, ["abcdef?", "Third"]);
  const initial = [["r1", "abcdef?", "BWide"], ["r3", "Third", "Final"]];
  assert.deepEqual(cells(app()), initial);
  const readers = [f.native, f.peer].map(origin => openCopy(t, origin.encodeState(), "Reader"));
  for (const reader of readers) {
    assert.deepEqual(cells(reader.document()), initial);
    assert.deepEqual(reader.document(), app());
  }
  const joiner = openCopy(t, f.peer.encodeState(), "Joining editor");
  const publish = async expected => {
    send(joiner, f.native);
    await Promise.resolve();
    send(f.native, f.peer);
    assert.deepEqual(cells(app()), expected);
    assert.deepEqual(app(), joiner.document());
    assert.deepEqual(f.peer.document(), joiner.document());
    assert.equal(text(f.cell("r3")), expected[1][1]);
    assert.equal(text(f.cell("r1", "visualText")), expected[0][2]);
  };
  edit(joiner, "r3", 5, 5, "!");
  assert.deepEqual(cells(app()), initial);
  assert.deepEqual(cells(joiner.document()), [initial[0], ["r3", "Third!", "Final"]]);
  await publish([initial[0], ["r3", "Third!", "Final"]]);
  edit(joiner, "r1", 5, 5, "s", "visual");
  await publish([["r1", "abcdef?", "BWides"], ["r3", "Third!", "Final"]]);
  written(joiner.commands.undo());
  await publish([initial[0], ["r3", "Third!", "Final"]]);
  written(joiner.commands.undo());
  await publish(initial);
  assert.equal(joiner.commands.undo().kind, "unchanged");
  await publish(initial);
  for (const reader of readers) assert.deepEqual(cells(reader.document()), initial);
  assert.equal(input(f.place("r3", 5), "insertText", "."), true);
  flush();
  send(f.native, joiner);
  await publish([initial[0], ["r3", "Third.", "Final"]]);
  land(f, ["abcdef?", "Third."]);
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

test("Split: undo restores the peer letter when the split deletes the last text in the held selection", async t => {
  const f = await enter(t);
  assert.equal(input(f.place("r1", 6), "insertText", "X"), true);
  f.place("r1", 2, 4);
  edit(f.peer, "r1", 3, 3, "Z");
  edit(f.peer, "r1", 2, 3, null);
  edit(f.peer, "r1", 3, 4, null);
  assert.deepEqual(audio(f.peer.document()), ["abZef", "Other", "Third"]);
  send(f.peer, f.native);
  await Promise.resolve();
  assert.deepEqual(audio(app()), ["abcdef", "Other", "Third"]);
  assert.equal(key(f.cell(), "Enter", { altKey: true }), true);
  agree(f, ["ab", "efX", "Other", "Third"]);
  history(document.activeElement);
  agree(f, ["abZefX", "Other", "Third"]);
  history(document.activeElement);
  agree(f, ["abZef", "Other", "Third"]);
  assert.deepEqual(f.notices(), []);
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

test("Writer: peer bold, erase and remove paint, and undo restores the removed beat", async t => {
  const f = await enter(t, { view: "Writer", rows: [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }] });
  const check = async expected => {
    send(f.peer, f.native);
    await Promise.resolve();
    agree(f, expected);
  };
  const at = f.peer.commands.anchorText({ beat: "r1", cell: "narration" }, 0, 5);
  assert.equal(at.kind, "anchored");
  written(f.peer.commands.formatText(at.range, { kind: "plain", mark: "b", on: true }));
  await check(["<strong>Hello</strong>", "World"]);
  assert.equal(f.cell().querySelector("strong").textContent, "Hello");
  edit(f.peer, "r1", 1, 3, null);
  await check(["<strong>Hlo</strong>", "World"]);
  assert.equal(f.cell().querySelector("strong").textContent, "Hlo");
  written(f.peer.commands.removeRows(["r2"]));
  await check(["<strong>Hlo</strong>"]);
  assert.equal(f.cell("r2"), null);
  for (const origin of [f.native, f.peer]) {
    assert.deepEqual(openCopy(t, origin.encodeState(), "Reader").document(), app());
  }
  written(f.peer.commands.undo());
  await check(["<strong>Hlo</strong>", "World"]);
  assert.equal(text(f.cell("r2")), "World");

  const root = f.place("r1", 2);
  const flow = f.writer.writerFlowControl();
  flow.place({ anchor: { kind: "beat", rowId: "r1", offset: 2 }, head: { kind: "beat", rowId: "r2", offset: 2 } });
  document.dispatchEvent(new window.Event("selectionchange"));
  const before = selectionSnapshot(root), bytes = f.native.encodeState();
  assert.equal(input(root, "deleteContentBackward"), true);
  assert.deepEqual(f.native.encodeState(), bytes);
  assert.deepEqual(selectionSnapshot(root), before);
  assert.deepEqual(f.notices(), [warning]);
  agree(f, ["<strong>Hlo</strong>", "World"]);
  land(f, ["<strong>Hlo</strong>", "World"]);
  assert.equal(text(f.cell()), "Hlo");
});

function transfer(target, type, types) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "drop" ? "dataTransfer" : "clipboardData", { value: {
    files: [], types, getData: format => format === "text/plain" ? "pasted" : "",
    setData: () => assert.fail("Shared transfer unexpectedly wrote to the clipboard")
  } });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

for (const field of ["audioText", "visualText"]) for (const order of orders) {
  test(`Split ${field}: refused transfers preserve the selection, and plain paste, line breaks and history edit it, ${order}`, async t => {
    const f = await enter(t, { rows: [{ ...source[0], visualText: "abcdef" }, ...source.slice(1)] });
    delivery(f.native, order, ...packets(f.peer, () => {
      edit(f.peer, "r2", 0, 0, "P");
      edit(f.peer, "r2", 1, 1, "Q");
    }));
    await Promise.resolve();
    const node = f.place("r1", 2, 4, field);
    const before = selectionSnapshot(node), bytes = f.native.encodeState();
    const other = f.cell("r2", field);
    for (const route of ["paste", "cut", "drop"]) {
      assert.equal(transfer(node, route, ["text/plain", "text/html"]), true);
      assert.deepEqual(selectionSnapshot(node), before);
    }
    assert.equal(transfer(other, "drop", ["text/plain"]), true);
    assert.deepEqual(selectionSnapshot(node), before);
    for (const route of ["insertFromPaste", "insertFromDrop", "deleteByCut", "deleteByDrag",
      "insertOrderedList", "insertUnorderedList", "insertTranspose"]) {
      assert.equal(input(node, route), true);
      assert.deepEqual(selectionSnapshot(node), before);
    }
    assert.deepEqual(f.notices(), Array(11).fill(warning));
    assert.deepEqual(f.native.encodeState(), bytes);
    agree(f, ["abcdef", "PQOther", "Third"]);
    const expected = value => {
      agree(f, [field === "audioText" ? value : "abcdef", "PQOther", "Third"]);
      assert.equal(app().rows[0][field], value);
    };
    assert.equal(transfer(node, "paste", ["text/plain"]), true);
    expected("abpastedef");
    caret(f, "r1", 8, 8, field);
    f.place("r1", 2, 8, field);
    assert.equal(input(f.cell("r1", field), "insertParagraph"), true);
    expected("ab<br>ef");
    history(document.activeElement);
    expected("abpastedef");
    assert.equal(input(document.activeElement, "historyUndo"), true);
    expected("abcdef");
    assert.equal(input(document.activeElement, "historyRedo"), true);
    expected("abpastedef");
    assert.deepEqual(f.notices(), Array(11).fill(warning));
  });

  for (const state of ["caret", "typing", "composition"]) {
    test(`Split ${field}: unsupported gestures keep the ${state} in place, ${order}`, async t => {
      const f = await enter(t, { rows: [{ ...source[0], visualText: "abcdef" }, ...source.slice(1)] });
      delivery(f.native, order, ...packets(f.peer, () => {
        edit(f.peer, "r2", 0, 0, "P");
        edit(f.peer, "r2", 1, 1, "Q");
      }));
      await Promise.resolve();
      const node = f.place("r1", 3, 3, field);
      if (state === "typing") assert.equal(input(node, "insertText", "X"), true);
      if (state === "composition") {
        assert.equal(compose(node, "start"), false);
        composePreview(node, "X");
      }
      const before = selectionSnapshot(node), bytes = f.native.encodeState();
      const check = () => {
        assert.deepEqual(selectionSnapshot(node), before);
        assert.deepEqual(f.native.encodeState(), bytes);
      };
      assert.equal(transfer(node, "paste", ["text/plain", "text/html"]), true);
      check();
      for (const type of ["cut", "drop"]) {
        assert.equal(transfer(node, type, ["text/plain"]), true);
        check();
      }
      assert.equal(transfer(f.cell("r2", field), "drop", ["text/plain"]), true);
      check();
      for (const route of ["insertFromPaste", "insertFromDrop", "deleteByCut", "deleteByDrag",
        "insertOrderedList", "insertUnorderedList", "insertTranspose"]) {
        assert.equal(input(node, route), true);
        check();
      }
      assert.deepEqual(f.notices(), Array(state === "composition" ? 5 : 11).fill(warning));
      if (state === "composition") {
        for (const modifiers of [{}, { ctrlKey: true }, { altKey: true }]) {
          assert.equal(key(node, "Enter", modifiers), true);
          check();
        }
        for (const name of ["ArrowUp", "ArrowDown"]) {
          assert.equal(key(node, name, { altKey: true }), true);
          check();
        }
        for (const name of ["b", "i", "u"]) {
          assert.equal(key(node, name, { ctrlKey: true }), true);
          check();
        }
        for (const route of ["insertParagraph", "insertLineBreak", "formatBold", "formatItalic", "formatUnderline",
          "historyUndo", "historyRedo"]) {
          assert.equal(input(node, route), true);
          check();
        }
        assert.deepEqual(f.notices(), Array(5).fill(warning));
        compose(node, "end", "X");
      }
      if (state === "typing") flush();
      agree(f, [state !== "caret" && field === "audioText" ? "abcXdef" : "abcdef", "PQOther", "Third"]);
      assert.equal(app().rows[0].visualText, state !== "caret" && field === "visualText" ? "abcXdef" : "abcdef");
    });
  }
}

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

for (const field of ["audioText", "visualText"]) {
  test(`Split ${field}: undo of a peer removal brings back concurrent text without a Recovery entry`, async t => {
    const f = await enter(t);
    const node = f.place("r2", 5, 5, field);
    assert.equal(input(node, "insertText", "x"), true);
    flush();
    written(f.peer.commands.removeRows(["r2"]));
    send(f.peer, f.native);
    await Promise.resolve();
    agree(f, [field === "audioText" ? "abcdefx" : "abcdef", "Third"]);
    assert.equal(f.cell("r2", field), null);
    assert.notEqual(appActions.invoke("recovery", "command-menu").kind, "ran");
    written(f.peer.commands.undo());
    send(f.peer, f.native);
    await Promise.resolve();
    agree(f, ["abcdef", field === "audioText" ? "Otherx" : "Other", "Third"]);
    assert.equal(text(f.cell("r2", field)), field === "audioText" ? "Otherx" : "Scenex");
    assert.deepEqual(f.notices(), []);
  });
}
