import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { adoptReplacement, liveSession, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { domToPos, posToDom, readSelection } from "../features/common/cell-dom.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { NativeScriptReader } from "../adapters/collab/native/reader.ts";
import { scriptCellOf, sanitizeHtml } from "../bootstrap/richtext.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { enterSharedSession, forceLeaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { nativeEntrySwitchFixture as entrySwitchFixture } from "../../tests/bootstrap/native-entry-switch-support.ts";
import { Doc, encodeStateAsUpdate } from "yjs";
import { breakUndoGroup } from "../bootstrap/wiring/undo.ts";
import { mountNativeSharedInput } from "../bootstrap/wiring/native-shared-input.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { appActions } from "../bootstrap/wiring/ports/actions.ts";
import { documentReader } from "../bootstrap/wiring/ports/document.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const renderNotice = notices.show;
const UNAVAILABLE = ["This is not available in a shared session yet.", "warn"];
const cell = (id = "r1") => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="audioText"]');
const beat = (id = "r1") => document.querySelector('#writer-doc .wr-beat[data-id="' + id + '"]');
const root = () => document.getElementById("writer-doc");
const app = (index = 0) => hook.read().app.rows[index].audioText;
const peer = (index = 0) => hook.read().peer.rows[index].audioText;
const flushed = () => delay(55);

function cleanSession() {
  if (!sharedSession() || hook.leave().ok) return;
  forceLeaveSharedSession();
  const allowed = () => ({ allowed: true });
  adoptReplacement(migrateRows({ title: "Standby", rows: [] }), createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
}

function beforeInput(target, inputType, data, extra = {}) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data, ...extra });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function deleteIn(target, host, from, to, direction = "Backward") {
  const start = posToDom(host, from), end = posToDom(host, to), range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContent" + direction });
  Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function compose(target, type, data) {
  const event = new window.CompositionEvent("composition" + type, { bubbles: true, cancelable: true, data });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function press(target, key, extra = {}) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ctrlKey: true, ...extra });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function typeKeys(target, keys) {
  for (const key of keys) assert.equal(beforeInput(target, "insertText", key), true, "key " + JSON.stringify(key));
}

function pastePlain(target, text) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"], getData: type => type === "text/plain" ? text : "" } });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function nativeBytes(doc, command) {
  const native = openNativeSession({ kind: "document", document: doc, conversion: {
    cells: scriptCellOf, creation: doc.docId, at: "2026-11-20", by: "Writer"
  } }, { actor: "Writer", sanitize: sanitizeHtml });
  try {
    command?.(native);
    return native.encodeState();
  } finally { native.close(); }
}

async function enter(t, rows = [{ id: "r1", audioText: "Hello", visualText: "Look" }], command, sections) {
  const doc = migrateRows({ schema: 2, title: "Native script", rows, sections });
  adoptReplacement(doc);
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await (command ? hook.enterFrom(nativeBytes(doc, command)) : hook.enter()), { ok: true });
  t.after(cleanSession);
  return show;
}

const joined = native => assert.equal(native.commands.joinRow("r2", "r1", " ").kind, "written");

function writer(t) {
  const control = writerControls();
  control.openWriter();
  t.after(control.closeWriter);
  root().focus();
  const flow = control.writerFlowControl();
  return {
    flow,
    caret: (id, from, to = from) => {
      flow.place({ anchor: { kind: "beat", rowId: id, offset: from }, head: { kind: "beat", rowId: id, offset: to } });
      document.dispatchEvent(new window.Event("selectionchange"));
    },
    at: () => {
      const range = flow.selection();
      return range && [range.anchor.rowId, range.anchor.offset, range.head.offset];
    }
  };
}

const markdownEnter = () => press(root(), "Enter", { ctrlKey: false });

function typeMarkdown(text) {
  for (const key of text) {
    const input = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: key });
    Object.defineProperty(input, "getTargetRanges", { value: () => [] });
    if (!root().dispatchEvent(input)) continue;
    const selection = document.getSelection(), range = selection.getRangeAt(0);
    const inserted = document.createTextNode(key);
    range.deleteContents();
    range.insertNode(inserted);
    selection.setBaseAndExtent(inserted, key.length, inserted, key.length);
    root().dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: key }));
  }
}

function markdownSnapshot() {
  const { rows, sections } = hook.read().app;
  const selection = document.getSelection();
  const point = selection.focusNode?.parentElement?.closest(".wr-beat");
  assert.ok(point && document.activeElement === root());
  const { anchor, head } = readSelection(point, selection);
  const original = id => /^r[12]$/.test(id) ? id : "new";
  return {
    rows: rows.map(row => [original(row.id), row.audioText ?? "", row.visualText ?? "", row.paragraphStart === true]),
    headings: (sections ?? []).map(({ name, firstSceneId }) => [name, rows.findIndex(row => row.id === firstSceneId)]),
    caret: [rows.findIndex(row => row.id === point.dataset.id), { anchor, head }]
  };
}

test("Writer: a committed composition arms a Markdown heading in either mode", async t => {
  const rows = [{ id: "r1", audioText: "Intro", visualText: "Desk" }];
  for (const native of [false, true]) {
    if (native) await enter(t, rows);
    else adoptReplacement(migrateRows({ title: "Markdown", paragraphsDecided: true, rows: structuredClone(rows) }));
    const view = writer(t);
    view.caret("r1", 0);
    compose(root(), "start", "");
    if (!native) {
      beat().firstChild.insertData(0, "# ");
      window.getSelection().collapse(beat().firstChild, 2);
      beat().dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "# ", isComposing: true }));
    }
    assert.equal(beat().classList.contains("is-pending-heading"), false);
    compose(root(), "end", "# ");
    assert.equal(beat().classList.contains("is-pending-heading"), true);
    view.caret("r1", 7);
    assert.equal(markdownEnter(), true);
    assert.deepEqual(markdownSnapshot(), {
      rows: [["r1", "", "Desk", false]], headings: [["Intro", 0]], caret: [0, { anchor: 0, head: 0 }]
    });
    if (native) {
      await Promise.resolve();
      assert.deepEqual(hook.read().peer, hook.read().app);
    }
    writerControls().closeWriter();
  }
});

test("Writer: Escape flushes typing and finalizes a pending Markdown heading in either mode", async t => {
  const rows = [{ id: "r1", audioText: "Intro", visualText: "Desk" }];
  for (const native of [false, true]) {
    if (native) await enter(t, rows);
    else adoptReplacement(migrateRows({ title: "Markdown", paragraphsDecided: true, rows: structuredClone(rows) }));
    const view = writer(t);
    view.caret("r1", 0);
    typeMarkdown("# ");
    view.caret("r1", 7);
    typeMarkdown("!");
    press(root(), "Escape", { ctrlKey: false });
    assert.equal(writerControls().writerFlowControl(), null);
    assert.equal(hook.read().app.sections?.[0]?.name, "Intro!");
    assert.equal(app(), "");
    if (native) {
      await Promise.resolve();
      assert.deepEqual(hook.read().peer, hook.read().app);
    }
  }
});

test("Writer: a Markdown candidate waits for mouseup and is styled and rearmed after undo in either mode", async t => {
  const rows = [{ id: "r1", audioText: "Intro" }, { id: "r2", audioText: "Body", paragraphStart: true }];
  for (const native of [false, true]) {
    if (native) await enter(t, rows);
    else adoptReplacement(migrateRows({ title: "Markdown", paragraphsDecided: true, rows: structuredClone(rows) }));
    const view = writer(t);
    view.caret("r1", 0);
    typeMarkdown("# ");
    assert.equal(beat().classList.contains("is-pending-heading"), true);
    beat().dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    view.flow.place({ anchor: { kind: "beat", rowId: "r1", offset: 4 }, head: { kind: "beat", rowId: "r2", offset: 2 } });
    document.dispatchEvent(new window.Event("selectionchange"));
    assert.deepEqual(hook.read().app.sections ?? [], []);
    window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    assert.equal(hook.read().app.sections?.[0]?.name, "Intro");
    assert.equal(press(root(), "z"), true);
    assert.equal(beat().classList.contains("is-pending-heading"), true);
    view.caret("r1", 7);
    view.caret("r2", 2);
    assert.equal(hook.read().app.sections?.[0]?.name, "Intro");
    assert.deepEqual(view.at(), ["r2", 2, 2]);
    if (native) {
      await Promise.resolve();
      assert.deepEqual(hook.read().peer, hook.read().app);
    }
    writerControls().closeWriter();
  }
});

test("Writer: a joined Markdown candidate keeps the caret and warns once while unchanged", async t => {
  const show = await enter(t, [{ id: "r1", audioText: "Intro" }, { id: "r2", audioText: "Body" }], joined);
  const view = writer(t);
  view.caret("r1", 0);
  typeMarkdown("# ");
  view.caret("r1", 7);
  for (let retry = 0; retry < 3; retry++) assert.equal(markdownEnter(), true);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  assert.equal(app(), "# Intro Body");
  assert.deepEqual(view.at(), ["r1", 7, 7]);
  await Promise.resolve();
  const { app: local, peer: remote } = hook.read();
  assert.deepEqual(local.sections ?? [], []);
  assert.deepEqual(remote, local);
  writerControls().closeWriter();
  assert.deepEqual(hook.leave(), { ok: true });
  adoptReplacement(migrateRows({ title: "Markdown", paragraphsDecided: true, rows: [{ id: "r1", audioText: "Intro Body" }] }));
  const standalone = writer(t);
  standalone.caret("r1", 0);
  typeMarkdown("# ");
  standalone.caret("r1", 7);
  assert.equal(markdownEnter(), true);
  assert.equal(hook.read().app.sections?.[0]?.name, "Intro");
  assert.equal(app(), " Body");
});

test("Writer: typed Markdown and its conversion take two standalone undos and three native undos", async t => {
  const rows = [{ id: "r1", audioText: "Body" }];
  for (const native of [false, true]) {
    if (native) await enter(t, rows);
    else adoptReplacement(migrateRows({ title: "Markdown", paragraphsDecided: true, rows: structuredClone(rows) }));
    writer(t).caret("r1", 0);
    typeMarkdown("# Intro");
    assert.equal(markdownEnter(), true);
    assert.equal(hook.read().app.sections?.[0]?.name, "Intro");
    for (const narration of native ? ["# IntroBody", "# Body", "Body"] : ["# IntroBody", "Body"]) {
      assert.equal(press(root(), "z"), true);
      assert.deepEqual(hook.read().app.sections ?? [], []);
      assert.equal(app(), narration);
    }
    writerControls().closeWriter();
  }
});

for (const [name, rows, sections, offset, expected] of [
  ["first beat with a follower", [{ id: "r1", audioText: "Intro" }, { id: "r2", audioText: "Body", paragraphStart: true }],
    [], 7, { rows: [["r2", "Body", "", false]], headings: [["Intro", 0]], caret: [0, { anchor: 0, head: 0 }] }],
  ["only beat", [{ id: "r1", audioText: "Intro" }],
    [], 7, { rows: [["new", "", "", false]], headings: [["Intro", 0]], caret: [0, { anchor: 0, head: 0 }] }],
  ["narration after the caret", [{ id: "r1", audioText: "IntroBody" }],
    [], 7, { rows: [["r1", "Body", "", false]], headings: [["Intro", 0]], caret: [0, { anchor: 0, head: 0 }] }],
  ["the sole beat of an existing scene", [{ id: "r1", audioText: "Intro" }],
    [{ id: "s1", name: "Earlier", firstSceneId: "r1" }], 7,
    { rows: [["new", "", "", false], ["new", "", "", false]], headings: [["Earlier", 0], ["Intro", 1]], caret: [1, { anchor: 0, head: 0 }] }],
  ["a retained Visual under an existing heading", [{ id: "r1", audioText: "Intro", visualText: "Desk" }],
    [{ id: "s1", name: "Earlier", firstSceneId: "r1" }], 7,
    { rows: [["new", "", "", false], ["r1", "", "Desk", false]], headings: [["Earlier", 0], ["Intro", 1]], caret: [1, { anchor: 0, head: 0 }] }]
]) test("Writer: Markdown heading matches standalone with " + name, async t => {
  for (const native of [false, true]) {
    if (native) await enter(t, rows, null, sections);
    else adoptReplacement(migrateRows({ title: "Markdown", paragraphsDecided: true, rows: structuredClone(rows), sections: structuredClone(sections) }));
    const view = writer(t);
    view.caret("r1", 0);
    typeMarkdown("# ");
    view.caret("r1", offset);
    const before = markdownSnapshot();
    assert.equal(markdownEnter(), true);
    assert.deepEqual(markdownSnapshot(), expected);
    assert.equal(press(root(), "z"), true);
    assert.deepEqual(markdownSnapshot(), before);
    assert.equal(press(root(), "y"), true);
    assert.deepEqual(markdownSnapshot(), expected);
    if (native) {
      await Promise.resolve();
      assert.deepEqual(hook.read().peer, hook.read().app);
    }
    writerControls().closeWriter();
  }
});

for (const [offset, marker] of [[2, "# "], [0, "## "], [0, "### "]]) {
  test("Writer: " + JSON.stringify(marker) + " at offset " + offset + " stays narration", async t => {
    const rows = [{ id: "r1", audioText: "Intro" }, { id: "r2", audioText: "Body", paragraphStart: true }];
    for (const native of [false, true]) {
      if (native) await enter(t, rows);
      else adoptReplacement(migrateRows({ title: "Markdown", paragraphsDecided: true, rows: structuredClone(rows) }));
      const view = writer(t);
      view.caret("r1", offset);
      typeMarkdown(marker);
      view.caret("r2", 0);
      await flushed();
      const { rows: shown, headings, caret } = markdownSnapshot();
      assert.deepEqual(headings, []);
      assert.equal(shown[0][1], "Intro".slice(0, offset) + marker + "Intro".slice(offset));
      assert.deepEqual(caret, [1, { anchor: 0, head: 0 }]);
      if (native) assert.deepEqual(hook.read().peer, hook.read().app);
      writerControls().closeWriter();
    }
  });
}

test("Writer: leaving a typed Markdown line preserves the receiving caret through history", async t => {
  const rows = [{ id: "r1", audioText: "Intro" }, { id: "r2", audioText: "Body", paragraphStart: true }];
  for (const native of [false, true]) {
    if (native) await enter(t, rows);
    else adoptReplacement(migrateRows({ title: "Markdown", paragraphsDecided: true, rows: structuredClone(rows) }));
    const view = writer(t);
    view.caret("r1", 0);
    typeMarkdown("# ");
    view.caret("r2", 2);
    const landed = markdownSnapshot();
    assert.deepEqual(landed.headings, [["Intro", 0]]);
    assert.deepEqual(landed.caret, [0, { anchor: 2, head: 2 }]);
    assert.equal(press(root(), "z"), true);
    assert.deepEqual(view.at(), ["r2", 2, 2]);
    assert.equal(app(), "# Intro");
    assert.equal(press(root(), "y"), true);
    assert.deepEqual(markdownSnapshot(), landed);
    if (native) {
      await Promise.resolve();
      assert.deepEqual(hook.read().peer, hook.read().app);
    }
    writerControls().closeWriter();
  }
});

test("Writer: Enter converts a typed Markdown heading and replays the narration caret", async t => {
  const show = await enter(t, [{ id: "r1", audioText: "Intro", visualText: "Look" }]);
  const view = writer(t);
  view.caret("r1", 0);
  typeKeys(root(), "# ");
  view.caret("r1", 7);
  typeKeys(root(), "!");
  assert.equal(markdownEnter(), true);
  assert.deepEqual(hook.read().app.sections.map(({ name, firstSceneId }) => [name, firstSceneId]), [["Intro!", "r1"]]);
  assert.equal(app(), "");
  assert.equal(hook.read().app.rows[0].visualText, "Look");
  assert.deepEqual(view.at(), ["r1", 0, 0]);
  assert.equal(press(root(), "z"), true);
  assert.equal(app(), "# Intro!");
  assert.deepEqual(view.at(), ["r1", 8, 8]);
  assert.equal(press(root(), "y"), true);
  assert.equal(app(), "");
  assert.deepEqual(view.at(), ["r1", 0, 0]);
  await Promise.resolve();
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(show.mock.callCount(), 0);
});

test("Writer: Markdown Enter cannot run during composition or after a stale typing stop", async t => {
  const show = await enter(t, [{ id: "r1", audioText: "Intro" }]);
  const view = writer(t);
  view.caret("r1", 0);
  typeKeys(root(), "# ");
  await flushed();
  view.caret("r1", 7);
  compose(root(), "start", "");
  assert.equal(markdownEnter(), true);
  assert.equal(beforeInput(root(), "insertParagraph", null), true);
  assert.equal(app(), "# Intro");
  assert.deepEqual(hook.read().app.sections ?? [], []);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  assert.deepEqual(hook.read().peer, hook.read().app);
  compose(root(), "end", "");
  view.caret("r1", 7);
  assert.equal(hook.nativePeer.type("r1", 7, "!").kind, "written");
  assert.equal(markdownEnter(), true);
  await Promise.resolve();
  assert.equal(app(), "# Intro!");
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.deepEqual(hook.read().app.sections ?? [], []);
  beat("r1").textContent = "# Intro!?";
  view.caret("r1", 8);
  typeKeys(root(), "x");
  const noticesBefore = show.mock.callCount();
  assert.equal(markdownEnter(), true);
  assert.equal(beforeInput(root(), "insertParagraph", null), true);
  assert.equal(show.mock.callCount(), noticesBefore);
  await Promise.resolve();
  assert.equal(peer(), "# Intro!");
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.deepEqual(hook.read().app.sections ?? [], []);
});

test("Writer: Markdown Enter rebases buffered typing around a peer edit in the same beat", async t => {
  const show = await enter(t, [{ id: "r1", audioText: "IntroBody", visualText: "Desk" }]);
  const view = writer(t);
  view.caret("r1", 0);
  typeKeys(root(), "# ");
  await flushed();
  view.caret("r1", 7);
  typeKeys(root(), "!");
  assert.equal(hook.nativePeer.type("r1", 3, "X").kind, "written");
  assert.equal(markdownEnter(), true);
  assert.deepEqual(hook.read().app.sections.map(section => section.name), ["IXntro!"]);
  assert.equal(app(), "Body");
  assert.equal(press(root(), "z"), true);
  assert.equal(app(), "# IXntro!Body");
  assert.deepEqual(view.at(), ["r1", 9, 9]);
  assert.equal(press(root(), "y"), true);
  assert.equal(app(), "Body");
  assert.deepEqual(view.at(), ["r1", 0, 0]);
  await Promise.resolve();
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(show.mock.callCount(), 0);
});

const views = {
  Split: {
    open: () => {},
    surface: id => cell(id),
    caret: (_view, id, from, to = from) => { cell(id).focus(); setCellSelection(cell(id), from, to); },
    at: (_view, id = "r1") => {
      const selection = cellSelection(cell(id));
      return document.activeElement === cell(id) && selection ? [id, selection.from, selection.to] : null;
    },
    host: id => cell(id)
  },
  Writer: {
    open: t => writer(t),
    surface: () => root(),
    caret: (view, id, from, to = from) => { view.caret(id, from, to); },
    at: view => document.activeElement === root() ? view.at() : null,
    host: id => beat(id)
  }
};

async function replayDeletion(kind, view, key, text, caret) {
  assert.equal(press(kind.surface(), key), true);
  assert.equal(app(), text);
  assert.deepEqual(kind.at(view), ["r1", caret, caret]);
  await Promise.resolve();
  assert.equal(peer(), text);
}

function editSplitText(from, to, text, direction = "Backward") {
  const target = cell();
  const inputType = text ? "insertText" : "deleteContent" + direction;
  if (text ? beforeInput(target, inputType, text) : deleteIn(target, target, from, to, direction)) return;
  const old = target.textContent;
  target.textContent = old.slice(0, from) + text + old.slice(to);
  setCellSelection(target, from + text.length);
  target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType, data: text || null }));
}

const splitDeletionHistories = [
  ["Backspace then Delete", 3, ["abdefg", "abefg"], [
    () => editSplitText(2, 3, ""), () => editSplitText(2, 3, "", "Forward")
  ]],
  ["moving the caret between deletions", 4, ["abcefg", "acefg"], [
    () => editSplitText(3, 4, ""), () => {
      press(cell(), "ArrowLeft", { ctrlKey: false });
      setCellSelection(cell(), 2);
      editSplitText(1, 2, "");
    }
  ]],
  ["deleting a selection then pressing Backspace", 2, ["abefg", "aefg"], [
    () => { setCellSelection(cell(), 2, 4); editSplitText(2, 4, ""); }, () => editSplitText(1, 2, "")
  ]],
  ["Backspace, a typed letter, then Delete", 3, ["abdefg", "abxdefg", "abxefg"], [
    () => editSplitText(2, 3, ""), () => editSplitText(2, 2, "x"), () => editSplitText(3, 4, "", "Forward")
  ]],
  ["Find Replace between deletions", 3, ["abdefg", "abdXYg", "abXYg"], [
    () => editSplitText(2, 3, ""), t => {
      search(t, "ef", "XY");
      document.getElementById("find-replace").click();
    }, () => { views.Split.caret(null, "r1", 3); editSplitText(2, 3, ""); }
  ]]
];

for (const [name, offset, states, edits] of splitDeletionHistories) {
  test(`Split: ${name} takes one standalone undo and ${states.length} native undos`, async t => {
    const initial = "abcdefg", rows = [{ id: "r1", audioText: initial }];
    for (const native of [false, true]) {
      if (native) await enter(t, rows);
      else adoptReplacement(migrateRows({ title: "Deletion history", rows: structuredClone(rows) }));
      views.Split.caret(null, "r1", offset);
      for (const [index, edit] of edits.entries()) {
        edit(t);
        if (native) await flushed();
        assert.equal(app(), states[index]);
      }
      const history = native ? [initial, ...states.slice(0, -1)].reverse() : [initial];
      for (const expected of history) {
        assert.equal(press(cell(), "z"), true);
        assert.equal(app(), expected);
      }
    }
  });
}

test("Writer: Find replaces one heading match and refuses a compound heading rewrite", async t => {
  const show = await enter(t, [{ id: "r1", audioText: "cup" }], null, [{ id: "s1", name: "cup cup", firstSceneId: "r1" }]);
  writer(t);
  const field = search(t, "cup", "mug");
  assert.equal(document.getElementById("find-count").textContent, "1 of 3");
  document.getElementById("find-replace-all").click();
  assert.equal(app(), "cup");
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  const heading = () => hook.read().app.sections[0].name;
  assert.equal(heading(), "cup cup");
  document.getElementById("find-replace").click();
  assert.equal(heading(), "mug cup");
  field.blur();
  assert.equal(press(document.body, "z"), true);
  assert.equal(heading(), "cup cup");
  assert.equal(document.getSelection().toString(), "cup");
  assert.equal(press(document.activeElement, "y"), true);
  assert.equal(heading(), "mug cup");
  assert.equal(document.getSelection().focusOffset, 3);
});

test("Split: Find bulk tagging refuses before it changes a match", async t => {
  const show = await enter(t, [{ id: "r1", audioText: "Hello", visualText: "cup" }]);
  search(t, "cup", "mug");
  document.getElementById("find-tag").click();
  assert.equal(document.getElementById("find-tag-row").hidden, false);
  const before = hook.read();
  document.getElementById("find-tag-go").click();
  assert.deepEqual(hook.read(), before);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
});

function search(t, needle, replacement) {
  assert.equal(appActions.invoke("find", "menu").kind, "ran");
  t.after(() => document.getElementById("find-close").click());
  const field = document.getElementById("find-input");
  field.value = needle;
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  document.getElementById("replace-input").value = replacement;
  return field;
}

test("Split Find skips an interrupted word and replaces the highlighted match without removing its picture", async t => {
  const ref = { sha256: "a".repeat(64), width: 10, height: 10, mime: "image/png" };
  await enter(t, [{ id: "r1", audioText: "cup cup" }], native => {
    const at = native.commands.anchorText({ beat: "r1", cell: "narration" }, 2);
    assert.equal(at.kind, "anchored");
    assert.equal(native.commands.replaceText(at.range, [{ atom: "image", ref, text: "", marks: {} }]).kind, "written");
  });
  assert.ok(cell().querySelector("img"));
  const highlights = new Map();
  class Highlight {
    constructor(range) { this.range = range; }
  }
  const original = [window.CSS?.highlights, window.Highlight, globalThis.Highlight];
  window.CSS.highlights = highlights;
  window.Highlight = globalThis.Highlight = Highlight;
  t.after(() => { [window.CSS.highlights, window.Highlight, globalThis.Highlight] = original; });
  search(t, "cup", "mug");
  assert.equal(document.getElementById("find-count").textContent, "1 of 1");
  assert.equal(highlights.get("splitpage-find-match")?.range.toString(), "cup");
  assert.equal(highlights.get("splitpage-find-match")?.range.startOffset, 2);
  document.getElementById("find-replace").click();
  await Promise.resolve();
  assert.equal(cell().textContent, "cup mug");
  assert.ok(cell().querySelector("img"));
  assert.deepEqual(hook.read().app, hook.read().peer);
});

const PICTURE = '<img class="comment-img" data-blob="' + "a".repeat(64) + '" data-w="10" data-h="10" data-mime="image/png">';
const pictureLayouts = [
  ["inside the first word", 2, ["cu", "p mug"], ["cu", "p mug"]],
  ["before the first word", 0, ["", "mug cup"], ["", "mug mug"]],
  ["after the first word", 3, ["mug", " cup"], ["mug", " mug"]]
];
for (const [where, offset, replaced, all] of pictureLayouts) for (const every of [false, true]) {
  test(`Split Find ${every ? "Replace all" : "Replace"} with a picture ${where} keeps it, standalone and shared alike, and Undo restores it`, async t => {
    const ref = { sha256: "a".repeat(64), width: 10, height: 10, mime: "image/png" };
    const results = [];
    for (const native of [false, true]) {
      if (native) {
        await enter(t, [{ id: "r1", audioText: "cup cup" }], session => {
          const at = session.commands.anchorText({ beat: "r1", cell: "narration" }, offset);
          assert.equal(at.kind, "anchored");
          assert.equal(session.commands.replaceText(at.range, [{ atom: "image", ref, text: "", marks: {} }]).kind, "written");
        });
      } else {
        adoptReplacement(migrateRows({ title: "Picture", rows: [{ id: "r1", audioText: "cup cup" }] }));
        cell().focus();
        cell().innerHTML = "cup cup".slice(0, offset) + PICTURE + "cup cup".slice(offset);
        cell().dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "" }));
        breakUndoGroup();
      }
      const before = app();
      assert.equal(before, "cup cup".slice(0, offset) + PICTURE + "cup cup".slice(offset));
      const field = search(t, "cup", "mug");
      document.getElementById(every ? "find-replace-all" : "find-replace").click();
      await Promise.resolve();
      const [head, tail] = every ? all : replaced;
      assert.equal(app(), head + PICTURE + tail);
      results.push(app());
      if (native) assert.deepEqual(hook.read().app, hook.read().peer);
      field.blur();
      assert.equal(press(document.body, "z"), true);
      await Promise.resolve();
      assert.equal(app(), before);
      if (native) assert.deepEqual(hook.read().app, hook.read().peer);
      document.getElementById("find-close").click();
      if (native) assert.deepEqual(hook.leave(), { ok: true });
    }
    assert.equal(results[0], results[1]);
  });
}

for (const [name, kind] of Object.entries(views)) {
  test(name + ": control-only paste and typing leave the selection intact", async t => {
    adoptReplacement(migrateRows({ title: "Inline", rows: [{ id: "r1", audioText: "Hello" }] }));
    const standalone = kind.open(t);
    kind.caret(standalone, "r1", 1, 4);
    assert.equal(pastePlain(kind.surface(), "\u0001"), true);
    assert.equal(app(), name === "Split" ? "Hello" : "Ho");
    writerControls().closeWriter();
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 1, 4);
    const before = hook.read();
    assert.equal(pastePlain(kind.surface(), "\u0001"), true);
    assert.equal(beforeInput(kind.surface(), "insertText", "\u0001"), true);
    await flushed();
    assert.deepEqual(hook.read(), before);
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE, UNAVAILABLE]);
  });

  test(name + ": blocked cut, multiline paste and collapsed formatting preserve text and selection", async t => {
    const show = await enter(t), view = kind.open(t);
    const before = hook.read(), clipboardWrites = t.mock.fn();
    kind.caret(view, "r1", 1, 4);
    const cut = new window.Event("cut", { bubbles: true, cancelable: true });
    Object.defineProperty(cut, "clipboardData", { value: { setData: clipboardWrites } });
    assert.equal(kind.surface().dispatchEvent(cut), false);
    assert.equal(pastePlain(kind.surface(), "one\ntwo"), true);
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    kind.caret(view, "r1", 2);
    assert.equal(press(kind.surface(), "b"), true);
    assert.deepEqual(kind.at(view), ["r1", 2, 2]);
    assert.deepEqual(hook.read(), before);
    assert.equal(clipboardWrites.mock.callCount(), 0);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
  });

  test(name + ": paste and Shift+Enter match standalone markup across inline formatting", async t => {
    const rows = [{ id: "r1", audioText: "<strong>Hel</strong>lo" }];
    for (const action of ["paste", "line"]) {
      const apply = async native => {
        if (native) await enter(t, rows);
        else adoptReplacement(migrateRows({ title: "Inline", rows: structuredClone(rows) }));
        const view = kind.open(t);
        kind.caret(view, "r1", 1, 4);
        assert.equal(action === "paste" ? pastePlain(kind.surface(), "X") :
          press(kind.surface(), "Enter", { ctrlKey: false, shiftKey: true }), true);
        const result = { html: app(), selection: kind.at(view) };
        writerControls().closeWriter();
        if (native) assert.deepEqual(hook.leave(), { ok: true });
        return result;
      };
      const standalone = await apply(false);
      const inserted = action === "paste" ? "X" : "<br>";
      assert.equal(standalone.html, name === "Writer" ? "<strong>H</strong>" + inserted + "o" : "<strong>H" + inserted + "</strong>o");
      assert.deepEqual(await apply(true), standalone);
    }
  });

  test(name + ": Replace and Replace all undo independently and keep a concurrent peer prefix", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "a cup of tea" }, { id: "r2", audioText: "one cup" }]);
    show.mock.mockImplementation(renderNotice);
    const toasts = () => [...document.querySelectorAll("#toast-host .toast:not(.is-leaving)")];
    for (const toast of toasts()) if (toast.textContent === "Replaced 1 match") toast.dismiss();
    kind.open(t);
    const field = search(t, "cup", "mug");
    const read = () => hook.read().app.rows.map(row => row.audioText);
    const expectText = async expected => {
      await Promise.resolve();
      assert.deepEqual(read(), expected);
      assert.deepEqual(hook.read().app, hook.read().peer);
    };
    document.getElementById("find-replace").click();
    await expectText(["a mug of tea", "one cup"]);
    hook.nativePeer.hold();
    document.getElementById("find-replace-all").click();
    assert.equal(hook.nativePeer.type("r2", 0, "X").kind, "written");
    hook.nativePeer.deliver();
    await expectText(["a mug of tea", "Xone mug"]);
    assert.deepEqual(toasts().filter(toast => toast.textContent === "Replaced 1 match").map(toast => toast.textContent), ["Replaced 1 match"]);
    field.blur();
    assert.equal(press(document.body, "z"), true);
    await expectText(["a mug of tea", "Xone cup"]);
    assert.equal(press(document.body, "z"), true);
    await expectText(["a cup of tea", "Xone cup"]);
    writerControls().closeWriter();
    assert.deepEqual(hook.leave(), { ok: true });
    assert.deepEqual(read(), ["a cup of tea", "Xone cup"]);
  });

  test(name + ": Replace all retains an intact captured pair after a peer shifts adjacent matches", async t => {
    adoptReplacement(migrateRows({ title: "Find", rows: [{ id: "r1", audioText: "aaa" }] }));
    kind.open(t);
    search(t, "aa", "X");
    document.getElementById("find-replace-all").click();
    assert.equal(app(), "Xa");
    document.getElementById("find-close").click();
    writerControls().closeWriter();
    await enter(t, [{ id: "r1", audioText: "aaaa" }]);
    const view = kind.open(t);
    kind.caret(view, "r1", 0);
    const field = search(t, "aa", "X");
    assert.equal(hook.nativePeer.delete("r1", 0, 1).kind, "written");
    document.getElementById("find-replace-all").click();
    assert.equal(app(), "aX");
    field.blur();
    assert.equal(press(document.body, "z"), true);
    assert.equal(app(), "aaa");
    assert.deepEqual(kind.at(view), ["r1", 1, 3]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(app(), "aX");
    await Promise.resolve();
    assert.deepEqual(hook.read().app, hook.read().peer);
  });

  for (const all of [false, true]) test(name + ": Find " + (all ? "Replace all skips" : "Replace refuses") + " identical peer replacement text", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "abc abc" }]);
    const view = kind.open(t);
    kind.caret(view, "r1", 0);
    const field = search(t, "abc", "X");
    const peer = hook.nativePeer;
    peer.hold();
    assert.equal(peer.type("r1", 1, "abc").kind, "written");
    assert.equal(peer.delete("r1", 4, 6).kind, "written");
    assert.equal(peer.delete("r1", 0, 1).kind, "written");
    peer.deliver();
    assert.equal(hook.read().peer.rows[0].audioText, "abc abc");
    document.getElementById(all ? "find-replace-all" : "find-replace").click();
    await Promise.resolve();
    assert.equal(app(), all ? "abc X" : "abc abc");
    assert.deepEqual(hook.read().app, hook.read().peer);
    if (!all) {
      assert.deepEqual(show.mock.calls.map(call => call.arguments), [["This line changed. Try replacing again.", "warn"]]);
      return;
    }
    field.blur();
    assert.equal(press(document.body, "z"), true);
    assert.equal(app(), "abc abc");
    assert.deepEqual(kind.at(view), ["r1", 4, 7]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(app(), "abc X");
  });

  test(name + ": Find Replace and Replace all preserve rendered formatting", async t => {
    for (const native of [false, true]) for (const all of [false, true]) {
      const rows = [{ id: "r1", audioText: "<em>cupcup</em>" }];
      if (native) await enter(t, rows);
      else adoptReplacement(migrateRows({ title: "Find", rows }));
      kind.open(t);
      search(t, "cup", "mug");
      document.getElementById(all ? "find-replace-all" : "find-replace").click();
      const expected = all ? "mugmug" : "mugcup";
      assert.equal(app(), "<em>" + expected + "</em>");
      assert.equal(kind.host("r1").querySelector("em")?.textContent, expected);
      document.getElementById("find-close").click();
      writerControls().closeWriter();
      if (native) assert.deepEqual(hook.leave(), { ok: true });
    }
  });

  test(name + ": Replace all preserves rendered marks after a peer types inside a captured match", async t => {
    await enter(t, [{ id: "r1", audioText: "<strong>cu</strong>p<em>cup</em> c<strong>up</strong>" }]);
    const view = kind.open(t);
    kind.caret(view, "r1", 0);
    const field = search(t, "cup", "mug");
    assert.equal(hook.nativePeer.type("r1", 2, "X").kind, "written");
    document.getElementById("find-replace-all").click();
    const host = kind.host("r1");
    assert.equal(host.textContent, "cuXpmug mug");
    assert.equal(host.querySelector("strong")?.textContent, "cu");
    assert.equal(host.querySelector("em")?.textContent, "mug");
    assert.equal(host.querySelectorAll("strong").length, 1);
    field.blur();
    assert.equal(press(document.body, "z"), true);
    assert.equal(kind.host("r1").textContent, "cuXpcup cup");
    assert.equal(kind.host("r1").querySelector("em")?.textContent, "cup");
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(kind.host("r1").textContent, "cuXpmug mug");
    assert.equal(kind.host("r1").querySelector("em")?.textContent, "mug");
    await Promise.resolve();
    assert.deepEqual(hook.read().app, hook.read().peer);
  });

  test(name + ": Find replaces the displayed match after a peer inserts before it", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "one <strong>cup</strong> and cup" }]);
    const view = kind.open(t);
    kind.caret(view, "r1", 0);
    const field = search(t, "cup", "mug");
    assert.equal(hook.nativePeer.type("r1", 0, "cup ").kind, "written");
    document.getElementById("find-replace").click();
    assert.equal(app(), "cup one <strong>mug</strong> and cup");
    assert.equal(document.activeElement, field);
    field.blur();
    assert.equal(press(document.body, "z"), true);
    assert.equal(app(), "cup one <strong>cup</strong> and cup");
    assert.deepEqual(kind.at(view), ["r1", 8, 11]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(app(), "cup one <strong>mug</strong> and cup");
    assert.deepEqual(kind.at(view), ["r1", 11, 11]);
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Find refuses a changed single match instead of replacing the next one", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "cup and cup" }]);
    kind.open(t);
    search(t, "cup", "mug");
    assert.equal(hook.nativePeer.delete("r1", 0, 1).kind, "written");
    document.getElementById("find-replace").click();
    await Promise.resolve();
    assert.equal(app(), "up and cup");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [["This line changed. Try replacing again.", "warn"]]);
    assert.equal(document.getElementById("find-count").textContent, "1 of 1");
    document.getElementById("find-replace").click();
    assert.equal(app(), "up and mug");
  });

  test(name + ": Find replaces Visual matches and replays the Visual selection", async t => {
    await enter(t, [{ id: "r1", audioText: "Narration", visualText: "cup and cup" }]);
    kind.open(t);
    const field = search(t, "cup", "mug");
    if (name === "Writer" && document.getElementById("find-visuals").getAttribute("aria-pressed") === "false") {
      document.getElementById("find-visuals").click();
    }
    assert.equal(document.getElementById("find-count").textContent, "1 of 2");
    const visual = () => hook.read().app.rows[0].visualText;
    document.getElementById("find-replace").click();
    assert.equal(visual(), "mug and cup");
    document.getElementById("find-replace-all").click();
    assert.equal(visual(), "mug and mug");
    field.blur();
    assert.equal(press(document.body, "z"), true);
    assert.equal(visual(), "mug and cup");
    assert.deepEqual(cellSelection(document.activeElement), { from: 8, to: 11 });
    assert.equal(press(document.activeElement, "z"), true);
    assert.equal(visual(), "cup and cup");
    assert.deepEqual(cellSelection(document.activeElement), { from: 0, to: 3 });
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(visual(), "mug and cup");
    assert.deepEqual(cellSelection(document.activeElement), { from: 3, to: 3 });
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(visual(), "mug and mug");
    assert.deepEqual(cellSelection(document.activeElement), { from: 11, to: 11 });
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
  });

  test(name + ": Replace all follows the joined narration members around synthetic glue", async t => {
    await enter(t, [{ id: "r1", audioText: "cup" }, { id: "r2", audioText: "cup cup" }], joined);
    kind.open(t);
    const field = search(t, "cup", "mug");
    assert.equal(document.getElementById("find-count").textContent, "1 of 3");
    document.getElementById("find-replace-all").click();
    assert.equal(app(), "mug mug mug");
    field.blur();
    assert.equal(press(document.body, "z"), true);
    assert.equal(app(), "cup cup cup");
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(app(), "mug mug mug");
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
  });

  test(name + ": a plain format command flushes typing and replays the selection", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }]);
    const view = kind.open(t);
    kind.caret(view, "r1", 2);
    typeKeys(kind.surface(), "x");
    kind.caret(view, "r1", 1, 4);
    assert.equal(hook.nativePeer.type("r2", 0, "Y").kind, "written");
    assert.equal(press(kind.surface(), "b"), true);
    assert.equal(app(), "H<strong>exl</strong>lo");
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.equal(press(document.activeElement, "z"), true);
    assert.equal(app(), "Hexllo");
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(app(), "H<strong>exl</strong>lo");
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    compose(kind.surface(), "start", "");
    assert.equal(press(kind.surface(), "i"), true);
    assert.equal(app(), "H<strong>exl</strong>lo");
    compose(kind.surface(), "end", "");
    await Promise.resolve();
    assert.equal(hook.read().app.rows[1].audioText, "YWorld");
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  });

  test(name + ": Visual typing and composition replay their selections without undoing peer narration", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "Hello", visualText: "Look" }]);
    const view = kind.open(t);
    if (name === "Writer") view.flow.openVisual("r1");
    const visual = () => name === "Writer" ? document.querySelector(".wr-flow-visual-text")
      : document.querySelector('#rows .cell-editable[data-id="r1"][data-field="visualText"]');
    const text = () => hook.read().app.rows[0].visualText;
    visual().focus();
    setCellSelection(visual(), 2);
    typeKeys(visual(), "x");
    assert.equal(text(), "Loxok");
    assert.deepEqual(cellSelection(visual()), { from: 3, to: 3 });
    setCellSelection(visual(), 1, 4);
    assert.equal(compose(visual(), "start", ""), false);
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    compose(visual(), "end", "字");
    assert.equal(text(), "L字k");
    assert.deepEqual(cellSelection(visual()), { from: 2, to: 2 });
    assert.equal(press(visual(), "z"), true);
    assert.equal(text(), "Loxok");
    assert.deepEqual(cellSelection(visual()), { from: 1, to: 4 });
    assert.equal(press(visual(), "y"), true);
    assert.equal(text(), "L字k");
    assert.deepEqual(cellSelection(visual()), { from: 2, to: 2 });
    assert.equal(app(), "YHello");
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": repeated Visual Backspace shares one undo step and replays the caret", async t => {
    const show = await enter(t), view = kind.open(t);
    if (name === "Writer") view.flow.openVisual("r1");
    const visual = () => document.querySelector(name === "Writer" ? ".wr-flow-visual-text"
      : '#rows .cell-editable[data-id="r1"][data-field="visualText"]');
    const text = () => hook.read().app.rows[0].visualText;
    visual().focus();
    setCellSelection(visual(), 3);
    for (const from of [2, 1]) assert.equal(deleteIn(visual(), visual(), from, from + 1), true);
    assert.equal(text(), "Lk");
    assert.equal(press(visual(), "z"), true);
    assert.equal(text(), "Look");
    assert.deepEqual(cellSelection(visual()), { from: 3, to: 3 });
    assert.equal(press(visual(), "y"), true);
    assert.equal(text(), "Lk");
    assert.deepEqual(cellSelection(visual()), { from: 1, to: 1 });
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Visual typing retries are quiet after a stale paint stops typing", async t => {
    const show = await enter(t), view = kind.open(t);
    if (name === "Writer") view.flow.openVisual("r1");
    const visual = document.querySelector(name === "Writer" ? ".wr-flow-visual-text"
      : '#rows .cell-editable[data-id="r1"][data-field="visualText"]');
    visual.focus();
    setCellSelection(visual, 2);
    assert.equal(hook.nativePeer.format({ beat: "r1", cell: "visual" }, 0, 4, { kind: "plain", mark: "b", on: true }).kind, "written");
    typeKeys(visual, "x");
    assert.equal(visual.textContent, "Loxok");
    for (const key of "yz") typeKeys(visual, key);
    assert.equal(visual.textContent, "Loxok");
    assert.equal(hook.read().app.rows[0].visualText, "Look");
    assert.equal(hook.read().peer.rows[0].visualText, "<strong>Look</strong>");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  });

  test(name + ": joined Visual text refuses a write aimed at an unaddressable member", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "One" }, { id: "r2", audioText: "Two", visualText: "Look" }], joined);
    const view = kind.open(t);
    if (name === "Writer") view.flow.openVisual("r1");
    const visual = document.querySelector(name === "Writer" ? ".wr-flow-visual-text"
      : '#rows .cell-editable[data-id="r1"][data-field="visualText"]');
    visual.focus();
    setCellSelection(visual, 0);
    const before = hook.read();
    typeKeys(visual, "x");
    assert.equal(visual.textContent, "Look");
    assert.deepEqual(hook.read(), before);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.deepEqual(hook.leave(), { ok: true });
  });

  for (const line of [false, true]) test(name + ": " + (line ? "Shift+Enter" : "plain paste") + " replaces a selection after buffered typing", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }]);
    const view = kind.open(t);
    kind.caret(view, "r1", 2);
    typeKeys(kind.surface(), "x");
    kind.caret(view, "r1", 1, 4);
    assert.equal(hook.nativePeer.type("r2", 0, "Y").kind, "written");
    compose(kind.surface(), "start", "");
    const invoke = () => {
      if (line) return press(kind.surface(), "Enter", { ctrlKey: false, shiftKey: true });
      const event = new window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"], getData: () => "Z" } });
      kind.surface().dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(invoke(), true);
    assert.equal(app(), "Hexllo");
    compose(kind.surface(), "end", "");
    kind.caret(view, "r1", 1, 4);
    assert.equal(invoke(), true);
    assert.equal(app(), line ? "H<br>lo" : "HZlo");
    assert.deepEqual(kind.at(view), ["r1", 2, 2]);
    assert.equal(press(document.activeElement, "z"), true);
    assert.equal(app(), "Hexllo");
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(app(), line ? "H<br>lo" : "HZlo");
    assert.deepEqual(kind.at(view), ["r1", 2, 2]);
    assert.equal(hook.read().app.rows[1].audioText, "YWorld");
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  });

  test(name + ": replacing a selection across inline formatting keeps its opening marks", async t => {
    await enter(t, [{ id: "r1", audioText: "<strong>Hel</strong>lo" }]);
    const view = kind.open(t);
    kind.caret(view, "r1", 1, 4);
    typeKeys(kind.surface(), "X");
    await flushed();
    assert.equal(app(), "<strong>HX</strong>o");
    assert.deepEqual(kind.at(view), ["r1", 2, 2]);
    assert.equal(press(document.activeElement, "z"), true);
    assert.equal(app(), "<strong>Hel</strong>lo");
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(app(), "<strong>HX</strong>o");
    assert.deepEqual(kind.at(view), ["r1", 2, 2]);
  });

  test(name + ": Replace all skips changed and deleted matches, keeps unseen matches and publishes once", async t => {
    const rows = [
      { id: "r1", audioText: "cup cup" }, { id: "r2", audioText: "cup" }, { id: "r3", audioText: "cup" },
      ...Array.from({ length: 12 }, (_, index) => ({ id: "b" + index, audioText: "cup cup" })),
      { id: "r4", audioText: "Other" }
    ];
    await enter(t, rows);
    const view = kind.open(t);
    kind.caret(view, "r1", 0);
    const field = search(t, "cup", "mug");
    assert.equal(hook.nativePeer.type("r1", 0, "cup ").kind, "written");
    assert.equal(hook.nativePeer.type("r2", 1, "X").kind, "written");
    assert.equal(hook.nativePeer.delete("r3", 0, 3).kind, "written");
    assert.equal(hook.nativePeer.type("r4", 0, "Peer ").kind, "written");
    let published = 0;
    const stop = onSessionChange(() => { published++; });
    t.after(stop);
    document.getElementById("find-replace-all").click();
    const texts = () => hook.read().app.rows.map(row => row.audioText);
    const after = ["cup mug mug", "cXup", "", ...Array(12).fill("mug mug"), "Peer Other"];
    const before = ["cup cup cup", "cXup", "", ...Array(12).fill("cup cup"), "Peer Other"];
    assert.deepEqual(texts(), after);
    assert.equal(published, 1);
    field.blur();
    assert.equal(press(document.body, "z"), true);
    assert.deepEqual(texts(), before);
    assert.deepEqual(kind.at(view), ["r1", 4, 7]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.deepEqual(texts(), after);
    assert.deepEqual(kind.at(view), ["r1", 7, 7]);
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
  });

  for (const all of [false, true]) {
    const button = all ? "find-replace-all" : "find-replace", label = all ? "Replace all" : "Replace";
    test(name + ": " + label + " flushes typing and is refused during composition", async t => {
      const show = await enter(t, [{ id: "r1", audioText: "cup end" }]);
      const view = kind.open(t);
      search(t, "cup", "mug");
      kind.caret(view, "r1", 7);
      compose(kind.surface(), "start", "");
      document.getElementById(button).click();
      assert.equal(app(), "cup end");
      assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
      compose(kind.surface(), "end", "");
      typeKeys(kind.surface(), "x");
      assert.equal(app(), "cup end");
      document.getElementById(button).click();
      assert.equal(app(), "mug endx");
      assert.equal(press(document.activeElement, "z"), true);
      assert.equal(app(), "cup endx");
      assert.equal(press(document.activeElement, "z"), true);
      assert.equal(app(), "cup end");
    });

    test(name + ": " + label + " is quiet after typing stops", async t => {
      const show = await enter(t, [{ id: "r1", audioText: "cup end" }]);
      const view = kind.open(t);
      search(t, "cup", "mug");
      kind.caret(view, "r1", 7);
      assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
      typeKeys(kind.surface(), "x");
      document.getElementById(button).click();
      assert.equal(app(), "cup end");
      assert.equal(peer(), "Ycup end");
      assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    });
  }
}

test("Split: removing a beat with a simultaneous peer insertion preserves the peer letters and undoes the removal", async t => {
  const show = await enter(t, twoBeats);
  const remove = () => document.querySelector('#rows .row[data-id="r1"] [data-action="delete-row"]').click();
  views.Split.caret(null, "r1", 2);
  hook.nativePeer.hold();
  remove();
  assert.equal(app(), "Hello");
  remove();
  assert.deepEqual(hook.read().app.rows.map(row => row.id), ["r2"]);
  assert.equal(hook.nativePeer.type("r1", 2, "Y").kind, "written");
  hook.nativePeer.deliver();
  await Promise.resolve();
  assert.deepEqual(hook.read().app, hook.read().peer);
  assert.equal(app(), "YWorld");
  assert.equal(cell("r2").textContent, "YWorld");
  assert.equal(press(cell("r2"), "z"), true);
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["HeYllo", "World"]);
  assert.equal(views.Split.at(null)?.[0], "r1");
  await Promise.resolve();
  assert.deepEqual(hook.read().app, hook.read().peer);
  assert.equal(show.mock.callCount(), 0);
});

test("Split: scene controls add, rename and remove one heading in three undo steps", async t => {
  const show = await enter(t, twoBeats);
  const name = value => {
    const field = document.querySelector(".section-rename input");
    field.value = value;
    field.form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  };
  document.querySelector('#rows [data-action="add-section"][data-id="r2"]').click();
  name("Scene");
  const added = hook.read().app.sections[0];
  assert.equal(added.firstSceneId, "r2");
  const header = () => document.querySelector('.section-header[data-section-id="' + added.id + '"]');
  assert.equal(header().querySelector(".section-name").textContent, "Scene");
  header().querySelector('[data-section-action="rename"]').click();
  name("Changed");
  assert.equal(hook.read().app.sections[0].name, "Changed");
  header().querySelector('[data-section-action="remove"]').click();
  assert.equal(header(), null);
  assert.equal(hook.read().app.sections?.length ?? 0, 0);
  views.Split.caret(null, "r2", 0);
  assert.equal(press(cell("r2"), "z"), true);
  assert.equal(hook.read().app.sections[0].name, "Changed");
  assert.equal(press(cell("r2"), "z"), true);
  assert.deepEqual(hook.read().app.sections, [added]);
  assert.equal(press(cell("r2"), "z"), true);
  assert.equal(hook.read().app.sections?.length ?? 0, 0);
  await Promise.resolve();
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(show.mock.callCount(), 0);
});

test("Writer: renaming and removing a heading replay the heading caret", async t => {
  const show = await enter(t, twoBeats, undefined, [{ id: "section", name: "Scene", firstSceneId: "r2" }]);
  const view = writer(t), heading = () => root().querySelector(".wr-heading");
  const at = offset => ({ kind: "heading", sceneId: "section", offset });
  view.flow.place({ anchor: at(5), head: at(5) });
  typeKeys(root(), " two");
  assert.equal(heading().textContent, "Scene two");
  assert.equal(hook.read().app.sections[0].name, "Scene two");
  assert.deepEqual(view.flow.selection().head, at(9));
  view.flow.place({ anchor: at(0), head: at(0) });
  assert.equal(press(root(), "Backspace", { ctrlKey: false }), true);
  assert.equal(heading(), null);
  assert.equal(press(root(), "z"), true);
  assert.equal(heading().textContent, "Scene two");
  assert.deepEqual(view.flow.selection().head, at(0));
  assert.equal(press(root(), "z"), true);
  assert.equal(heading().textContent, "Scene tw");
  assert.deepEqual(view.flow.selection().head, at(8));
  await Promise.resolve();
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(show.mock.callCount(), 0);
});

test("Writer: a stale heading cannot supply the range for a rename", async t => {
  const show = await enter(t, twoBeats, undefined, [{ id: "section", name: "Scene", firstSceneId: "r2" }]);
  const view = writer(t);
  const heading = root().querySelector(".wr-heading");
  heading.textContent = "Stale";
  const at = { kind: "heading", sceneId: "section", offset: 2 };
  view.flow.place({ anchor: at, head: at });
  const before = hook.read();
  assert.equal(beforeInput(root(), "insertText", "X"), true);
  assert.deepEqual(hook.read(), before);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
});

test("Split: Visual Ctrl+Enter matches standalone and replays its selection", async t => {
  const visual = id => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="visualText"]');
  const insert = () => {
    const prior = visual("r1");
    prior.focus();
    setCellSelection(prior, 1, 3);
    assert.equal(press(prior, "Enter"), true);
  };
  const at = id => {
    const target = visual(id), selection = cellSelection(target);
    assert.equal(document.activeElement, target);
    return [id, selection.from, selection.to];
  };
  const original = ["r1"], rows = [{ id: "r1", audioText: "Hello", visualText: "Look" }];
  adoptReplacement(migrateRows({ title: "Standalone Visual", rows }));
  insert();
  const local = documentReader.current();
  const expected = insertSnapshot(local, original, at(local.rows[1].id));
  const show = await enter(t, rows);
  insert();
  const [, created] = rowOrder();
  assert.deepEqual(insertSnapshot(hook.read().app, original, at(created)), expected);
  assert.equal(press(visual(created), "z"), true);
  assert.deepEqual(rowOrder(), original);
  assert.deepEqual(at("r1"), ["r1", 1, 3]);
  assert.equal(press(visual("r1"), "y"), true);
  assert.deepEqual(insertSnapshot(hook.read().app, original, at(created)), expected);
  await Promise.resolve();
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(show.mock.callCount(), 0);
});

const threeBeats = () => [...twoBeats, { id: "r3", audioText: "Again" }];
const fourBeats = () => [...threeBeats(), { id: "r4", audioText: "Last" }];
const rowOrder = () => hook.read().app.rows.map(row => row.id);

async function keepAdjacentAfterPeerMove(t, open, move) {
  const show = await enter(t, fourBeats()), view = open(t);
  assert.equal(hook.nativePeer.moveBeat("r3", null).kind, "written");
  assert.deepEqual(rowOrder(), ["r1", "r2", "r3", "r4"]);
  move(view);
  await Promise.resolve();
  assert.deepEqual(rowOrder(), ["r2", "r1", "r4", "r3"]);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(show.mock.callCount(), 0);
}

test("Split: the move-down menu accepts the same neighbour after an unseen peer move", t => {
  return keepAdjacentAfterPeerMove(t, views.Split.open, () => {
    document.querySelector('#rows [data-action="move-down"][data-id="r1"]').click();
  });
});

test("Split: move-down and a row drag use native history", async t => {
  const show = await enter(t, threeBeats());
  document.querySelector('#rows [data-action="move-down"][data-id="r1"]').click();
  assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
  dragBeat("r2", "r3");
  assert.deepEqual(rowOrder(), ["r1", "r3", "r2"]);
  views.Split.caret(null, "r1", 0);
  assert.equal(press(cell(), "z"), true);
  assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
  assert.equal(press(document.activeElement, "z"), true);
  assert.deepEqual(rowOrder(), ["r1", "r2", "r3"]);
  assert.equal(show.mock.callCount(), 0);
});

function dragBeat(source, destination) {
  const row = document.querySelector('#rows .row[data-id="' + source + '"]');
  const drag = (target, type, clientY = 0) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
  row.setAttribute("draggable", "true");
  drag(row, "dragstart");
  drag(cell(destination), "dragover", 200);
  drag(cell(destination), "drop", 200);
}

for (const [route, move] of [
  ["menu move", () => document.querySelector('#rows [data-action="move-down"][data-id="r1"]').click()],
  ["drag", () => dragBeat("r1", "r2")]
]) test("Split: a " + route + " refuses an unseen change to its destination", async t => {
  const show = await enter(t, threeBeats());
  assert.equal(hook.nativePeer.moveBeat("r2", null).kind, "written");
  move();
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  await Promise.resolve();
  assert.deepEqual(rowOrder(), ["r1", "r3", "r2"]);
  assert.deepEqual(hook.read().peer, hook.read().app);
});

test("Writer: Alt+Down with a cross-beat selection in standalone", t => {
  adoptReplacement(migrateRows({ schema: 2, title: "Standalone script", rows: threeBeats() }));
  const view = writer(t);
  const range = { anchor: { kind: "beat", rowId: "r1", offset: 1 }, head: { kind: "beat", rowId: "r2", offset: 2 } };
  view.flow.place(range);
  assert.equal(press(root(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
  assert.deepEqual(rowOrder(), ["r1", "r3", "r2"]);
  assert.deepEqual(view.flow.selection(), range);
});

for (const [key, anchor, head, moved] of [
  ["ArrowDown", "r1", "r2", ["r1", "r3", "r2"]],
  ["ArrowUp", "r2", "r1", ["r1", "r3", "r2"]]
]) {
  test("Writer: Alt+" + key + " moves the head's beat and replays both ends through peer typing and history", async t => {
    const rows = threeBeats();
    if (key === "ArrowUp") rows.unshift(rows.pop());
    const show = await enter(t, rows), view = writer(t);
    const original = rows.map(row => row.id);
    let repaints = 0;
    t.after(liveSession().subscribe(change => {
      if (change.changes.rowsMoved) {
        repaints++;
        document.getSelection().removeAllRanges();
      }
    }));
    const place = (a, h) => {
      const from = posToDom(beat(anchor), a), to = posToDom(beat(head), h);
      document.getSelection().setBaseAndExtent(from.node, from.offset, to.node, to.offset);
      document.dispatchEvent(new window.Event("selectionchange"));
    };
    const check = async (order, a, h, count) => {
      assert.deepEqual(rowOrder(), order);
      assert.equal(repaints, count);
      assert.equal(document.activeElement, root());
      const selection = document.getSelection();
      assert.equal(selection.rangeCount, 1);
      assert.equal(domToPos(beat(anchor), selection.anchorNode, selection.anchorOffset), a);
      assert.equal(domToPos(beat(head), selection.focusNode, selection.focusOffset), h);
      await Promise.resolve();
      assert.deepEqual(hook.read().peer, hook.read().app);
    };
    view.caret(anchor, 1);
    typeKeys(root(), "X");
    place(2, 2);
    assert.equal(hook.nativePeer.type(anchor, 0, "!").kind, "written");
    assert.equal(hook.nativePeer.type(head, 0, "?").kind, "written");
    assert.equal(press(root(), key, { altKey: true, ctrlKey: false }), true);
    await check(moved, 3, 3, 1);
    assert.equal(hook.nativePeer.type(head, 0, "+").kind, "written");
    await Promise.resolve();
    view.caret("r3", 1);
    assert.equal(press(root(), "z"), true);
    await check(original, 3, 4, 2);
    view.caret("r3", 1);
    assert.equal(press(root(), "y"), true);
    await check(moved, 3, 4, 3);
    assert.equal(show.mock.callCount(), 0);
  });
}

for (const endpoint of ["anchor", "head"]) {
  test("Writer: a pending peer insertion in repeated text rebases the cross-beat " + endpoint, async t => {
    const rows = threeBeats();
    rows[1] = { ...rows[1], audioText: "aaaaa" };
    const show = await enter(t, rows), view = writer(t);
    const [anchor, head, moved] = endpoint === "anchor"
      ? ["r2", "r1", ["r2", "r1", "r3"]]
      : ["r1", "r2", ["r1", "r3", "r2"]];
    const check = (order, editedOffset) => {
      const live = document.getSelection();
      assert.deepEqual(rowOrder(), order);
      assert.equal(live.rangeCount, 1);
      assert.equal(domToPos(beat(anchor), live.anchorNode, live.anchorOffset), endpoint === "anchor" ? editedOffset : 2);
      assert.equal(domToPos(beat(head), live.focusNode, live.focusOffset), endpoint === "head" ? editedOffset : 2);
    };
    view.caret("r1", 1);
    typeKeys(root(), "X");
    const from = posToDom(beat(anchor), 2), to = posToDom(beat(head), 2);
    document.getSelection().setBaseAndExtent(from.node, from.offset, to.node, to.offset);
    document.dispatchEvent(new window.Event("selectionchange"));
    assert.equal(hook.nativePeer.type("r2", 0, "a").kind, "written");
    assert.equal(app(1), "aaaaa");
    assert.equal(press(root(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
    check(moved, 3);
    assert.equal(hook.nativePeer.type("r2", 0, "a").kind, "written");
    await Promise.resolve();
    view.caret("r3", 1);
    assert.equal(press(root(), "z"), true);
    check(["r1", "r2", "r3"], 4);
    view.caret("r3", 1);
    assert.equal(press(root(), "y"), true);
    check(moved, 4);
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });
}

test("Writer: a cross-beat move with untracked peer paint leaves the selection and draft untouched", async t => {
  const rows = threeBeats();
  rows[1] = { ...rows[1], audioText: "aaaaa" };
  const show = await enter(t, rows), view = writer(t);
  view.caret("r1", 1);
  typeKeys(root(), "X");
  assert.equal(hook.nativePeer.type("r2", 0, "a").kind, "written");
  const from = posToDom(beat("r1"), 2), to = posToDom(beat("r2"), 2), live = document.getSelection();
  live.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
  document.dispatchEvent(new window.Event("selectionchange"));
  assert.equal(press(root(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
  assert.deepEqual(rowOrder(), ["r1", "r2", "r3"]);
  assert.deepEqual([live.anchorNode, live.anchorOffset, live.focusNode, live.focusOffset], [from.node, from.offset, to.node, to.offset]);
  assert.deepEqual([app(0), app(1), peer(0), peer(1)], ["Hello", "aaaaa", "Hello", "aaaaaa"]);
  assert.equal(beat("r1").textContent.replace(/\u200b/g, ""), "HXello");
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
});

function selectAcrossWriter(view) {
  view.flow.place({ anchor: { kind: "beat", rowId: "r1", offset: 2 }, head: { kind: "beat", rowId: "r2", offset: 2 } });
  document.dispatchEvent(new window.Event("selectionchange"));
}

test("Writer: a cross-beat selection without a draft retains no narration paint", async t => {
  await enter(t, threeBeats());
  const view = writer(t), paint = t.mock.method(NativeScriptReader.prototype, "narrationPaint");
  selectAcrossWriter(view);
  assert.equal(hook.nativePeer.type("r3", 0, "x").kind, "written");
  assert.deepEqual(paint.mock.calls.filter(call => call.arguments[1]).map(call => call.arguments[0]), []);
  await Promise.resolve();
  assert.equal(press(root(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
  assert.deepEqual(rowOrder(), ["r1", "r3", "r2"]);
  assert.deepEqual(paint.mock.calls.filter(call => call.arguments[1]).map(call => call.arguments[0]), []);
});

test("Writer: focusing Close drops the cross-beat paint before the draft settles", async t => {
  await enter(t, threeBeats());
  const view = writer(t), paint = t.mock.method(NativeScriptReader.prototype, "narrationPaint");
  view.caret("r1", 1);
  typeKeys(root(), "X");
  selectAcrossWriter(view);
  const close = document.getElementById("wr-close");
  close.focus();
  assert.equal(document.activeElement, close);
  assert.equal(hook.nativePeer.type("r3", 0, "x").kind, "written");
  assert.deepEqual(paint.mock.calls.filter(call => call.arguments[1]).map(call => call.arguments[0]), ["r1"]);
  await Promise.resolve();
  assert.equal(app(), "HXello");
});

test("Native Split attaches no move paint listener and Writer removes its listener on close", async t => {
  const added = t.mock.method(document, "addEventListener"), removed = t.mock.method(document, "removeEventListener");
  const moveListeners = spy => spy.mock.calls.filter(call => call.arguments[0] === "selectionchange"
    && call.arguments[1].name === "trackMovePaint").map(call => call.arguments[1]);
  await enter(t, threeBeats());
  assert.deepEqual(moveListeners(added), []);
  writer(t);
  const [listener] = moveListeners(added);
  assert.equal(moveListeners(added).length, 1);
  writerControls().closeWriter();
  assert.deepEqual(moveListeners(removed), [listener]);
});

function insertSnapshot(doc, original, selection) {
  const key = id => original.includes(id) ? id : "blank";
  return {
    rows: doc.rows.map(row => [key(row.id), row.audioText, row.visualText, row.status, !!row.paragraphStart]),
    sections: doc.sections?.map(scene => [scene.id, key(scene.firstSceneId)]),
    selection: selection && [key(selection[0]), selection[1], selection[2]]
  };
}

const sceneEdges = [{ id: "s1", name: "First", firstSceneId: "r2" }, { id: "s2", name: "Second", firstSceneId: "r4" }];

for (const [name, id, offset, keys, index, stays] of [
  ["Split", "r3", 2, {}, 3, false],
  ["Split", "r3", 2, { ctrlKey: false, metaKey: true, shiftKey: true }, 3, false],
  ["Writer", "r2", 0, { ctrlKey: false }, 1, true],
  ["Writer", "r2", 0, {}, 1, true],
  ["Writer", "r3", 5, { ctrlKey: false, metaKey: true, shiftKey: true }, 3, false],
  ["Writer", "r3", 0, {}, 3, false]
]) {
  const visualOnly = name === "Writer" && id === "r3" && offset === 0;
  test(name + ": Enter insertion matches standalone " + id + " at " + offset + " " + JSON.stringify(keys), async t => {
    const rows = structuredClone(fourBeats());
    rows[1].paragraphStart = true;
    if (visualOnly) { rows[2].audioText = ""; rows[2].visualText = "Look"; }
    const original = rows.map(row => row.id), kind = views[name];
    adoptReplacement(migrateRows({ title: "Standalone script", rows, sections: sceneEdges, paragraphsDecided: true }));
    const local = kind.open(t);
    kind.caret(local, id, offset);
    assert.equal(press(kind.surface(id), "Enter", keys), true);
    const expected = insertSnapshot(documentReader.current(), original, kind.at(local, documentReader.current().rows[stays ? index + 1 : index].id));
    assert.equal(expected.rows[index][0], "blank");
    if (name === "Writer") writerControls().closeWriter();
    const show = await enter(t, rows, undefined, sceneEdges), view = kind.open(t);
    kind.caret(view, id, offset);
    const before = insertSnapshot(hook.read().app, original, kind.at(view, id));
    assert.equal(press(kind.surface(id), "Enter", keys), true);
    const created = rowOrder()[index], landing = stays ? id : created;
    assert.deepEqual(insertSnapshot(hook.read().app, original, kind.at(view, landing)), expected);
    assert.equal(press(kind.surface(landing), "z"), true);
    assert.deepEqual(insertSnapshot(hook.read().app, original, kind.at(view, id)), before);
    assert.equal(press(kind.surface(id), "y"), true);
    assert.deepEqual(insertSnapshot(hook.read().app, original, kind.at(view, landing)), expected);
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });
}

test("Split: clicking Insert beat keeps menu focus and records the narration selection for undo and redo", async t => {
  const kind = views.Split, original = ["r1", "r2"];
  const menu = () => document.querySelector('#rows .row-more[data-id="r1"]');
  const mouseClick = button => {
    button.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    button.focus();
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
  };
  const choose = () => {
    mouseClick(menu());
    const insert = document.querySelector('#rows .row-menu:not([hidden]) [data-action="insert-below"][data-id="r1"]');
    assert.equal(insert.textContent.trim(), "Insert beat");
    mouseClick(insert);
    assert.equal(document.activeElement, insert);
    return insert;
  };
  adoptReplacement(migrateRows({ title: "Standalone script", rows: twoBeats }));
  kind.caret(null, "r1", 1, 3);
  choose();
  const expected = insertSnapshot(documentReader.current(), original, null);
  const selected = document.getSelection().toString();
  mouseClick(menu());
  const show = await enter(t, twoBeats);
  kind.caret(null, "r1", 1, 3);
  const insert = choose();
  assert.deepEqual(insertSnapshot(hook.read().app, original, null), expected);
  assert.equal(document.getSelection().toString(), selected);
  insert.blur();
  assert.equal(press(document.body, "z"), true);
  assert.deepEqual(rowOrder(), original);
  assert.deepEqual(kind.at(null), ["r1", 1, 3]);
  assert.equal(document.getSelection().toString(), "el");
  assert.equal(press(cell(), "y"), true);
  assert.deepEqual(kind.at(null), ["r1", 1, 3]);
  assert.deepEqual(insertSnapshot(hook.read().app, original, null), expected);
  assert.equal(show.mock.callCount(), 0);
});

for (const atTop of [false, true]) {
  test("Writer: Enter at a heading start " + (atTop ? "refuses without a preceding beat" : "matches standalone before a later heading"), async t => {
    const rows = atTop ? [{ id: "r1", audioText: "Hello" }] : twoBeats;
    const sections = [{ id: "s1", name: "Scene", firstSceneId: atTop ? "r1" : "r2" }];
    const original = rows.map(row => row.id), point = { kind: "heading", sceneId: "s1", offset: 0 };
    adoptReplacement(migrateRows({ title: "Standalone heading", rows, sections, paragraphsDecided: true }));
    const local = writer(t);
    local.flow.place({ anchor: point, head: point });
    assert.equal(press(root(), "Enter", { ctrlKey: false }), true);
    const expected = insertSnapshot(documentReader.current(), original, local.at());
    assert.equal(expected.rows[atTop ? 0 : 1][0], "blank");
    assert.equal(expected.sections[0][1], sections[0].firstSceneId);
    writerControls().closeWriter();
    const show = await enter(t, rows, undefined, sections), view = writer(t);
    view.flow.place({ anchor: point, head: point });
    assert.equal(press(root(), "Enter", { ctrlKey: false }), true);
    if (atTop) {
      assert.deepEqual(rowOrder(), original);
      assert.deepEqual(view.flow.selection().head, point);
      assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
      assert.equal(press(root(), "Enter", { ctrlKey: false }), true);
      assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    } else {
      assert.deepEqual(insertSnapshot(hook.read().app, original, view.at()), expected);
      assert.equal(press(root(), "z"), true);
      assert.deepEqual(rowOrder(), original);
      assert.deepEqual(view.flow.selection().head, point);
      assert.equal(press(root(), "y"), true);
      assert.deepEqual(insertSnapshot(hook.read().app, original, view.at()), expected);
      assert.equal(show.mock.callCount(), 0);
    }
  });
}

for (const [from, to] of [[0, 2], [3, 5]]) {
  test("Writer: selection deletion and adjacent blank insertion refuse as one unsupported edit " + from, async t => {
    adoptReplacement(migrateRows({ title: "Standalone selection", rows: twoBeats, paragraphsDecided: true }));
    const local = writer(t);
    local.caret("r1", from, to);
    assert.equal(press(root(), "Enter", { ctrlKey: false }), true);
    const expected = documentReader.current().rows;
    assert.deepEqual(expected.map(row => row.audioText), from === 0 ? ["", "llo", "World"] : ["Hel", "", "World"]);
    writerControls().closeWriter();
    const show = await enter(t, twoBeats), view = writer(t);
    view.caret("r1", from, to);
    assert.equal(press(root(), "Enter", { ctrlKey: false }), true);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Hello", "World"]);
    assert.deepEqual(view.at(), ["r1", from, to]);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(press(root(), "Enter", { ctrlKey: false }), true);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  });
}

for (const repeatEnter of [true, false]) {
  test("Writer: " + (repeatEnter ? "second Enter on a blank splits it as on native main" : "Enter over Wo deletes and splits as on native main"), async t => {
    adoptReplacement(migrateRows({ title: "Standalone paragraph", rows: twoBeats, paragraphsDecided: true }));
    const local = writer(t);
    const enterKey = () => assert.equal(press(root(), "Enter", { ctrlKey: false }), true);
    if (repeatEnter) {
      local.caret("r1", 5);
      enterKey();
      assert.deepEqual(documentReader.current().rows.map(row => row.audioText), ["Hello", "", "World"]);
    } else local.caret("r2", 0, 2);
    enterKey();
    assert.deepEqual(documentReader.current().rows.map(row => [row.id, row.audioText, !!row.paragraphStart]), [
      ["r1", "Hello", false], ["r2", repeatEnter ? "World" : "rld", true]
    ]);
    assert.deepEqual(local.at(), ["r2", 0, 0]);
    writerControls().closeWriter();

    const show = await enter(t, twoBeats), native = writer(t);
    const snapshot = () => hook.read().app.rows.map(row => [row.id, row.audioText, !!row.paragraphStart]);
    if (repeatEnter) {
      native.caret("r1", 5);
      enterKey();
      const first = hook.read().app.rows[1].id;
      assert.deepEqual(snapshot(), [["r1", "Hello", false], [first, "", false], ["r2", "World", false]]);
      assert.deepEqual(native.at(), [first, 0, 0]);
    } else native.caret("r2", 0, 2);
    const before = hook.read().app, selection = native.at(), first = before.rows[1].id;
    enterKey();
    const created = hook.read().app.rows[2].id;
    assert.deepEqual(snapshot(), repeatEnter
      ? [["r1", "Hello", false], [first, "", false], [created, "", false], ["r2", "World", false]]
      : [["r1", "Hello", false], ["r2", "", false], [created, "rld", false]]);
    assert.deepEqual(native.at(), [created, 0, 0]);
    assert.equal(document.activeElement, root());
    const after = hook.read().app;
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, after);
    assert.equal(press(root(), "z"), true);
    assert.deepEqual(hook.read().app, before);
    assert.deepEqual(native.at(), selection);
    assert.equal(document.getSelection().toString(), repeatEnter ? "" : "Wo");
    assert.equal(press(root(), "y"), true);
    assert.deepEqual(hook.read().app, after);
    assert.deepEqual(native.at(), [created, 0, 0]);
    assert.equal(show.mock.callCount(), 0);
  });
}

for (const [name, kind] of Object.entries(views)) {
  test(name + ": insertion flushes buffered typing with a peer edit and gives insertion a separate undo step", async t => {
    const show = await enter(t, twoBeats), view = kind.open(t);
    const writerEnd = name === "Writer", offset = writerEnd ? 5 : 2;
    kind.caret(view, "r1", offset);
    typeKeys(kind.surface(), "X");
    assert.equal(app(), "Hello");
    assert.equal(hook.nativePeer.type("r1", 0, "P").kind, "written");
    assert.equal(press(kind.surface(), "Enter"), true);
    const text = writerEnd ? "PHelloX" : "PHeXllo";
    assert.equal(app(), text);
    const created = rowOrder()[1];
    assert.deepEqual(rowOrder(), ["r1", created, "r2"]);
    assert.notEqual(created, "r2");
    assert.deepEqual(kind.at(view, created), [created, 0, 0]);
    assert.equal(press(kind.surface(created), "z"), true);
    assert.deepEqual(rowOrder(), ["r1", "r2"]);
    assert.equal(app(), text);
    assert.deepEqual(kind.at(view, "r1"), ["r1", offset + 2, offset + 2]);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "PHello");
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });

  for (const remove of [false, true]) {
    test(name + ": insertion refuses when a peer " + (remove ? "removed the shown anchor" : "changed the shown neighbour"), async t => {
      const show = await enter(t, threeBeats()), view = kind.open(t);
      kind.caret(view, "r1", 5);
      const peerEdit = remove ? hook.nativePeer.removeBeat("r1") : hook.nativePeer.moveBeat("r2", null);
      assert.equal(peerEdit.kind, "written");
      assert.deepEqual(rowOrder(), ["r1", "r2", "r3"]);
      assert.equal(press(kind.surface(), "Enter"), true);
      assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
      await Promise.resolve();
      assert.deepEqual(rowOrder(), remove ? ["r2", "r3"] : ["r1", "r3", "r2"]);
      assert.deepEqual(hook.read().peer, hook.read().app);
    });
  }

  test(name + ": insertion shortcuts cancel during an open composition", async t => {
    const show = await enter(t, twoBeats), view = kind.open(t);
    kind.caret(view, "r1", 2);
    assert.equal(compose(kind.surface(), "start", ""), false);
    const before = kind.at(view, "r1");
    for (const shiftKey of [false, true]) assert.equal(press(kind.surface(), "Enter", { shiftKey }), true);
    assert.deepEqual(rowOrder(), ["r1", "r2"]);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.deepEqual(kind.at(view, "r1"), before);
    compose(kind.surface(), "end", "");
  });

  test(name + ": Alt+Enter splits only in Split", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 2);
    assert.equal(press(kind.surface(), "Enter", { altKey: true, ctrlKey: false }), true);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), name === "Split" ? ["He", "llo"] : ["Hello"]);
    await Promise.resolve();
    assert.deepEqual(hook.read().app, hook.read().peer);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Alt+Down refuses when an unseen peer move changed the adjacent beat", async t => {
    const show = await enter(t, threeBeats()), view = kind.open(t);
    kind.caret(view, "r1", 2);
    assert.equal(hook.nativePeer.moveBeat("r2", null).kind, "written");
    assert.deepEqual(rowOrder(), ["r1", "r2", "r3"]);
    assert.equal(press(kind.surface(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    await Promise.resolve();
    assert.deepEqual(rowOrder(), ["r1", "r3", "r2"]);
    assert.deepEqual(hook.read().peer, hook.read().app);
  });

  test(name + ": Alt+Down accepts the same neighbour after an unseen peer move", t => {
    return keepAdjacentAfterPeerMove(t, kind.open, view => {
      kind.caret(view, "r1", 2);
      assert.equal(press(kind.surface(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
    });
  });

  test(name + ": Alt+Down restores both selection ends after a repaint, undo and redo", async t => {
    const show = await enter(t, threeBeats()), view = kind.open(t);
    let repaints = 0;
    const stop = liveSession().subscribe(change => {
      if (change.changes.rowsMoved) {
        repaints++;
        document.getSelection().removeAllRanges();
      }
    });
    t.after(stop);
    kind.caret(view, "r1", 1, 4);
    assert.equal(press(kind.surface(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
    assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
    assert.equal(repaints, 1);
    const live = readSelection(kind.host("r1"), document.getSelection());
    assert.deepEqual(live && [live.anchor, live.head], [1, 4]);
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    kind.caret(view, "r2", 2);
    assert.equal(press(document.activeElement, "z"), true);
    assert.equal(repaints, 2);
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    kind.caret(view, "r2", 3);
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(repaints, 3);
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Alt+Down rebases a caret placed before buffered typing", async t => {
    const show = await enter(t, threeBeats()), view = kind.open(t);
    kind.caret(view, "r1", 3);
    typeKeys(kind.surface(), "X");
    assert.equal(app(), "Hello");
    kind.caret(view, "r1", 1);
    assert.equal(press(kind.surface(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
    assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
    assert.equal(app(1), "HelXlo");
    assert.deepEqual(kind.at(view), ["r1", 1, 1]);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "HelXlo");
    assert.deepEqual(kind.at(view), ["r1", 1, 1]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Alt+Arrow moves the beat, replays its caret and converges with a competing move", async t => {
    const show = await enter(t, threeBeats()), view = kind.open(t);
    kind.caret(view, "r2", 2);
    const move = key => press(document.activeElement, key, { altKey: true, ctrlKey: false });
    assert.equal(move("ArrowUp"), true);
    assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
    assert.deepEqual(kind.at(view, "r2"), ["r2", 2, 2]);
    assert.equal(press(document.activeElement, "z"), true);
    assert.deepEqual(rowOrder(), ["r1", "r2", "r3"]);
    assert.deepEqual(kind.at(view, "r2"), ["r2", 2, 2]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
    assert.deepEqual(kind.at(view, "r2"), ["r2", 2, 2]);
    assert.equal(press(document.activeElement, "z"), true);
    await Promise.resolve();
    hook.nativePeer.hold();
    assert.equal(move("ArrowUp"), true);
    assert.equal(hook.nativePeer.moveBeat("r2", null).kind, "written");
    hook.nativePeer.deliver();
    await Promise.resolve();
    const order = rowOrder().join(",");
    assert.ok(order === "r2,r1,r3" || order === "r1,r3,r2", order);
    assert.deepEqual(hook.read().peer, hook.read().app);
    const selector = name === "Split" ? "#rows .row" : "#writer-doc .wr-beat";
    assert.equal([...document.querySelectorAll(selector)].map(el => el.dataset.id).join(","), order);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Backspace removes a blank beat and undo restores it", async t => {
    const show = await enter(t, [twoBeats[0], { id: "r2", audioText: "" }]), view = kind.open(t);
    kind.caret(view, "r2", 0);
    assert.equal(press(document.activeElement, "Backspace", { ctrlKey: false }), true);
    assert.deepEqual(hook.read().app.rows.map(row => row.id), ["r1"]);
    assert.deepEqual(kind.at(view), ["r1", 5, 5]);
    await Promise.resolve();
    assert.equal(hook.nativePeer.type("r2", 0, "X").kind, "refused");
    assert.equal(press(kind.surface(), "z"), true);
    assert.deepEqual(hook.read().app.rows.map(row => row.id), ["r1", "r2"]);
    assert.deepEqual(kind.at(view, "r2"), ["r2", 0, 0]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.deepEqual(kind.at(view), ["r1", 5, 5]);
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });
  const splitKey = { ctrlKey: false, altKey: name === "Split" };
  test(name + ": the split shortcut flushes typing, splits once and replays both carets", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 2);
    typeKeys(kind.surface(), "x");
    assert.equal(app(), "Hello");
    assert.equal(press(kind.surface(), "Enter", splitKey), true);
    const { app: local } = hook.read();
    const created = local.rows[1].id;
    assert.deepEqual(local.rows.map(row => row.audioText), ["Hex", "llo"]);
    assert.deepEqual(kind.at(view, created), [created, 0, 0]);
    assert.equal(kind.host(created).textContent.replace(/\u200b/g, ""), "llo");
    assert.equal(press(document.activeElement, "z"), true);
    assert.equal(app(), "Hexllo");
    assert.deepEqual(kind.at(view), ["r1", 3, 3]);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(press(kind.surface(), "y"), true);
    assert.deepEqual(kind.at(view, created), [created, 0, 0]);
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": the split shortcut deletes the selection and splits with one undo step after buffered typing", async t => {
    const show = await enter(t, twoBeats), view = kind.open(t);
    kind.caret(view, "r1", 2);
    typeKeys(kind.surface(), "x");
    kind.caret(view, "r1", 1, 4);
    assert.equal(hook.nativePeer.type("r2", 0, "Y").kind, "written");
    assert.equal(press(kind.surface(), "Enter", splitKey), true);
    const created = hook.read().app.rows[1].id;
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["H", "lo", "YWorld"]);
    assert.deepEqual(kind.at(view, created), [created, 0, 0]);
    assert.equal(press(document.activeElement, "z"), true);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Hexllo", "YWorld"]);
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.deepEqual(kind.at(view, created), [created, 0, 0]);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["H", "lo", "YWorld"]);
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Enter refuses a selection during composition", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 1, 3);
    compose(kind.surface(), "start", "");
    assert.equal(press(kind.surface(), "Enter", { ctrlKey: false }), true);
    assert.equal(beforeInput(kind.surface(), "insertParagraph", null), true);
    compose(kind.surface(), "end", "");
    assert.equal(app(), "Hello");
    assert.equal(show.mock.callCount(), 1);
  });

  test(name + ": recognised structure keys cancel the browser default during composition", async t => {
    const show = await enter(t, twoBeats), view = kind.open(t);
    kind.caret(view, "r1", 5);
    assert.equal(compose(kind.surface(), "start", ""), false);
    const before = hook.read();
    for (const signal of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal(press(kind.surface(), "Enter", { ctrlKey: false, ...signal }), true);
      assert.equal(press(kind.surface(), "Delete", { ctrlKey: false, ...signal }), true);
      assert.equal(press(kind.surface(), "ArrowDown", { altKey: true, ctrlKey: false, ...signal }), true);
    }
    assert.deepEqual(hook.read(), before);
    assert.equal(show.mock.callCount(), 0);
    compose(kind.surface(), "end", "X");
    assert.equal(app(), "HelloX");
  });

  test(name + ": Enter refuses stale narration and leaves the peer edit intact", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 2);
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    assert.equal(press(kind.surface(), "Enter", { ctrlKey: false }), true);
    await Promise.resolve();
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["YHello"]);
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  });

  test(name + ": Enter after a stale typing stop is consumed silently", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 2);
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    typeKeys(kind.surface(), "x");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(press(kind.surface(), "Enter", { ctrlKey: false }), true);
    assert.equal(press(kind.surface(), "Enter", { ctrlKey: false }), true);
    assert.equal(beforeInput(kind.surface(), "insertParagraph", null), true);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Hello"]);
    assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), "Hexllo");
    assert.equal(peer(), "YHello");
  });

  for (const peerSplits of [true, false]) {
    test(name + ": the split shortcut converges with a simultaneous peer " + (peerSplits ? "split" : "insertion"), async t => {
      const show = await enter(t), view = kind.open(t);
      hook.nativePeer.hold();
      kind.caret(view, "r1", 2);
      assert.equal(press(kind.surface(), "Enter", splitKey), true);
      const other = peerSplits ? hook.nativePeer.split("r1", 4) : hook.nativePeer.type("r1", 3, "Y");
      assert.equal(other.kind, "written");
      hook.nativePeer.deliver();
      await Promise.resolve();
      const { app: local, peer: remote } = hook.read();
      const expected = peerSplits ? ["He", "ll", "o"] : ["He", "lYlo"];
      assert.deepEqual(remote, local);
      assert.deepEqual(local.rows.map(row => row.audioText), expected);
      assert.deepEqual(local.rows.map(row => kind.host(row.id).textContent.replace(/\u200b/g, "")), expected);
      assert.equal(show.mock.callCount(), 0);
    });
  }

  for (const backwards of [true, false]) {
    test(name + ": " + (backwards ? "Backspace" : "Delete") + " joins beats and replays the seam", async t => {
      const show = await enter(t, twoBeats), view = kind.open(t);
      const id = backwards ? "r2" : "r1", offset = backwards ? 0 : 5;
      kind.caret(view, id, offset);
      assert.equal(press(document.activeElement, backwards ? "Backspace" : "Delete", { ctrlKey: false }), true);
      assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Hello World"]);
      assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), "Hello World");
      assert.deepEqual(kind.at(view), ["r1", 6, 6]);
      assert.equal(press(kind.surface(), "z"), true);
      assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Hello", "World"]);
      assert.deepEqual(kind.at(view, id), [id, offset, offset]);
      assert.equal(press(document.activeElement, "y"), true);
      assert.deepEqual(kind.at(view), ["r1", 6, 6]);
      await Promise.resolve();
      assert.deepEqual(hook.read().peer, hook.read().app);
      assert.equal(show.mock.callCount(), 0);
    });
  }

  test(name + ": Ctrl+Z takes back each typed word with the caret where it began, and Ctrl+Y and Ctrl+Shift+Z put them back", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), " big");
    await flushed();
    assert.equal(app(), "Hello big");
    const steps = [["z", {}, "Hello ", 6], ["z", {}, "Hello", 5], ["y", {}, "Hello ", 6], ["z", { shiftKey: true }, "Hello big", 9]];
    for (const [key, extra, expected, caret] of steps) {
      assert.equal(press(kind.surface(), key, extra), true);
      assert.equal(app(), expected);
      assert.deepEqual(kind.at(view), ["r1", caret, caret], key + " " + JSON.stringify(extra));
      await Promise.resolve();
      assert.equal(peer(), expected);
      assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), expected);
    }
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": undo after a peer edit in the same beat keeps the peer's letters and moves the caret with them", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), " big");
    await flushed();
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    await Promise.resolve();
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "YHello ");
    assert.deepEqual(kind.at(view), ["r1", 7, 7]);
    await Promise.resolve();
    assert.equal(peer(), "YHello ");
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "YHello big");
    assert.deepEqual(kind.at(view), ["r1", 10, 10]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a press with letters still buffered sends them first and takes back only them", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "1 abc");
    assert.equal(app(), "Hello1 ");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello1 ");
    assert.deepEqual(kind.at(view), ["r1", 7, 7]);
    await Promise.resolve();
    assert.equal(peer(), "Hello1 ");
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Hello1 abc");
    assert.deepEqual(kind.at(view), ["r1", 10, 10]);
    await flushed();
    assert.equal(app(), "Hello1 abc");
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": undo in a joined row returns the caret in the row's own offsets", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }], joined);
    const view = kind.open(t);
    assert.equal(app(), "Hello World");
    kind.caret(view, "r1", 8);
    typeKeys(kind.surface(), "XY");
    await flushed();
    assert.equal(app(), "Hello WoXYrld");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello World");
    assert.deepEqual(kind.at(view), ["r1", 8, 8]);
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Hello WoXYrld");
    assert.deepEqual(kind.at(view), ["r1", 10, 10]);
    await Promise.resolve();
    assert.equal(peer(), "Hello WoXYrld");
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": undo of a replaced selection selects nothing new and puts the caret back at the selection's end on redo", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 1, 4);
    typeKeys(kind.surface(), "ipp");
    await flushed();
    assert.equal(app(), "Hippo");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Hippo");
    assert.deepEqual(kind.at(view), ["r1", 4, 4]);
    assert.equal(show.mock.callCount(), 0);
  });

  for (const [key, direction, start, first, second, remaining, end] of [
    ["Backspace", "Backward", 4, 3, 2, "Heo", 2],
    ["Delete", "Forward", 1, 1, 1, "Hlo", 1]
  ]) {
    test(name + ": held " + key + " is one undo step and replays the run's endpoint carets", async t => {
      const show = await enter(t), view = kind.open(t);
      kind.caret(view, "r1", start);
      for (const [index, from] of [first, second].entries()) {
        assert.equal(press(kind.surface(), key, { ctrlKey: false, repeat: index > 0 }), false);
        assert.equal(deleteIn(kind.surface(), kind.host("r1"), from, from + 1, direction), true);
      }
      await flushed();
      assert.equal(app(), remaining);
      assert.deepEqual(kind.at(view), ["r1", end, end]);
      await replayDeletion(kind, view, "z", "Hello", start);
      await replayDeletion(kind, view, "y", remaining, end);
      assert.equal(show.mock.callCount(), 0);
    });
  }

  test(name + ": switching from Backspace to Delete starts a new undo step", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 3);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 2, 3), true);
    await flushed();
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 2, 3, "Forward"), true);
    await flushed();
    assert.equal(app(), "Heo");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Helo");
    assert.deepEqual(kind.at(view), ["r1", 2, 2]);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
    assert.deepEqual(kind.at(view), ["r1", 3, 3]);
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Helo");
    assert.deepEqual(kind.at(view), ["r1", 2, 2]);
    await Promise.resolve();
    assert.equal(peer(), "Helo");
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a letter typed immediately after a deletion run has its own undo step", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 4);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 3, 4), true);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 2, 3), true);
    typeKeys(kind.surface(), "x");
    await flushed();
    assert.equal(app(), "Hexo");
    await replayDeletion(kind, view, "z", "Heo", 2);
    await replayDeletion(kind, view, "z", "Hello", 4);
    await replayDeletion(kind, view, "y", "Heo", 2);
    await replayDeletion(kind, view, "y", "Hexo", 3);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a one-second pause between deletions starts a new undo step", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 4);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 3, 4), true);
    await flushed();
    t.mock.timers.tick(999);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 2, 3), true);
    await flushed();
    t.mock.timers.tick(1000);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 1, 2), true);
    await flushed();
    assert.equal(app(), "Ho");
    await replayDeletion(kind, view, "z", "Heo", 2);
    await replayDeletion(kind, view, "z", "Hello", 4);
    await replayDeletion(kind, view, "y", "Heo", 2);
    await replayDeletion(kind, view, "y", "Ho", 1);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": moving the caret away and back ends a deletion run", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 4);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 3, 4), true);
    await flushed();
    press(kind.surface(), "ArrowLeft", { ctrlKey: false });
    kind.caret(view, "r1", 2);
    press(kind.surface(), "ArrowRight", { ctrlKey: false });
    kind.caret(view, "r1", 3);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 2, 3), true);
    await flushed();
    assert.equal(app(), "Heo");
    await replayDeletion(kind, view, "z", "Helo", 3);
    await replayDeletion(kind, view, "z", "Hello", 4);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": undo and redo of a deletion run keep a peer edit made between deletions", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 4);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 3, 4), true);
    await flushed();
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    await Promise.resolve();
    assert.equal(app(), "YHelo");
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 3, 4), true);
    await flushed();
    assert.equal(app(), "YHeo");
    await replayDeletion(kind, view, "z", "YHello", 5);
    await replayDeletion(kind, view, "y", "YHeo", 3);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a press with nothing to undo is silent and leaves the caret where it is", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 3);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Hello");
    assert.deepEqual(kind.at(view), ["r1", 3, 3]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a press during an open composition is refused with the notice and writes nothing", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "ab");
    await flushed();
    assert.equal(compose(kind.surface(), "start", ""), false);
    assert.equal(press(kind.surface(), "z", { isComposing: true }), true);
    assert.equal(app(), "Helloab");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(compose(kind.surface(), "end", "c"), false);
    await flushed();
    assert.equal(app(), "Helloabc");
  });

  test(name + ": a press from outside the text while a composition is open is refused with the notice and writes nothing", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "ab");
    await flushed();
    assert.equal(compose(kind.surface(), "start", ""), false);
    press(document.body, "z");
    assert.equal(app(), "Helloab");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(compose(kind.surface(), "end", "c"), false);
    await flushed();
    assert.equal(app(), "Helloabc");
  });

  test(name + ": a press after the buffer stopped on a stale paint writes nothing, adds no notice and keeps the unsent letter on screen", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "ab");
    await flushed();
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    kind.caret(view, "r1", 2);
    assert.equal(beforeInput(kind.surface(), "insertText", "x"), true);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(show.mock.callCount(), 1);
    assert.equal(app(), "Helloab");
    assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), "Hexlloab");
  });

  test(name + ": repeated Backspace is quiet after a stale paint stops a deletion", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 4);
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    for (const from of [3, 2, 2]) assert.equal(deleteIn(kind.surface(), kind.host("r1"), from, from + 1), true);
    assert.equal(app(), "Hello");
    assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), "Helo");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  });

  test(name + ": a one-second pause between typed letters ends the undo step", async t => {
    const show = await enter(t), view = kind.open(t);
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "a");
    await flushed();
    t.mock.timers.tick(999);
    typeKeys(kind.surface(), "b");
    await flushed();
    t.mock.timers.tick(1000);
    typeKeys(kind.surface(), "c");
    await flushed();
    assert.equal(app(), "Helloabc");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Helloab");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
    assert.equal(show.mock.callCount(), 0);
  });

  for (const gesture of name === "Split" ? ["pointerdown", "ArrowRight"] : ["pointerdown"]) {
    test(name + ": " + gesture + " at an unchanged caret preserves the typing group", async t => {
      const show = await enter(t), view = kind.open(t);
      kind.caret(view, "r1", 5);
      typeKeys(kind.surface(), "x");
      await flushed();
      if (gesture === "pointerdown") kind.surface().dispatchEvent(new window.MouseEvent(gesture, { bubbles: true }));
      else press(kind.surface(), gesture, { ctrlKey: false });
      assert.deepEqual(kind.at(view), ["r1", 6, 6]);
      typeKeys(kind.surface(), "y");
      await flushed();
      assert.equal(app(), "Helloxy");
      await replayDeletion(kind, view, "z", "Hello", 5);
      assert.equal(show.mock.callCount(), 0);
    });
  }

  for (const boundary of ["cancelled composition", "focus departure"]) {
    test(name + ": a " + boundary + " ends a pending deletion run", async t => {
      const show = await enter(t), view = kind.open(t);
      kind.caret(view, "r1", 4);
      assert.equal(deleteIn(kind.surface(), kind.host("r1"), 3, 4), true);
      if (boundary === "cancelled composition") {
        assert.equal(compose(kind.surface(), "start", ""), false);
        assert.equal(compose(kind.surface(), "end", ""), false);
      } else {
        document.getElementById("doc-title").focus();
        await Promise.resolve();
        kind.caret(view, "r1", 3);
      }
      assert.equal(deleteIn(kind.surface(), kind.host("r1"), 2, 3), true);
      await flushed();
      assert.equal(app(), "Heo");
      await replayDeletion(kind, view, "z", "Helo", 3);
      await replayDeletion(kind, view, "z", "Hello", 4);
      assert.equal(show.mock.callCount(), 0);
    });
  }

  for (const buffered of [true, false]) {
    test(name + ": a command boundary " + (buffered ? "with letters still buffered" : "after the letters were sent") + " ends the undo step", async t => {
      const show = await enter(t), view = kind.open(t);
      kind.caret(view, "r1", 5);
      typeKeys(kind.surface(), "ab");
      if (!buffered) await flushed();
      breakUndoGroup();
      await flushed();
      typeKeys(kind.surface(), "cd");
      await flushed();
      assert.equal(app(), "Helloabcd");
      assert.equal(press(kind.surface(), "z"), true);
      assert.equal(app(), "Helloab");
      assert.deepEqual(kind.at(view), ["r1", 7, 7]);
      assert.equal(press(kind.surface(), "z"), true);
      assert.equal(app(), "Hello");
      assert.equal(show.mock.callCount(), 0);
    });
  }

  test(name + ": the keys undo and redo a status change and a posted comment one at a time and leave the caret alone", async t => {
    const show = await enter(t);
    const status = doc => doc.rows[0].status, comments = doc => doc.comments.map(item => item.body);
    const anchored = doc => /cmt-anchor/.test(doc.rows[0].audioText);
    document.querySelector('#rows [data-action="cycle-status"][data-id="r1"]').click();
    await Promise.resolve();
    cell().focus();
    setCellSelection(cell(), 0, 5);
    cell().closest(".field-wrap").querySelector('[data-cmd="comment"]').click();
    document.getElementById("comment-body-editable").textContent = "Check this";
    document.getElementById("comment-post").click();
    await Promise.resolve();
    const both = () => { const { app: mine, peer: theirs } = hook.read(); return [mine, theirs]; };
    for (const copy of both()) assert.deepEqual([status(copy), comments(copy), anchored(copy)], ["ready", ["Check this"], true]);
    const view = kind.open(t);
    kind.caret(view, "r1", 3);
    const steps = [["z", "ready", [], false], ["z", "todo", [], false], ["y", "ready", [], false], ["y", "ready", ["Check this"], true]];
    for (const [key, expectedStatus, expectedComments, expectedAnchor] of steps) {
      assert.equal(press(kind.surface(), key), true);
      await Promise.resolve();
      for (const copy of both()) assert.deepEqual([status(copy), comments(copy), anchored(copy)], [expectedStatus, expectedComments, expectedAnchor], key);
      assert.deepEqual(kind.at(view), ["r1", 3, 3], key);
    }
    assert.equal(show.mock.calls.filter(call => call.arguments[1] === "warn").length, 0);
  });

  test(name + ": the browser's own history input steps the session like the keys", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "!");
    await flushed();
    assert.equal(beforeInput(kind.surface(), "historyUndo", null), true);
    assert.equal(app(), "Hello");
    assert.deepEqual(kind.at(view), ["r1", 5, 5]);
    assert.equal(beforeInput(kind.surface(), "historyRedo", null), true);
    assert.equal(app(), "Hello!");
    assert.deepEqual(kind.at(view), ["r1", 6, 6]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a deletion with nothing in its range is refused with the notice and changes nothing", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 3);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 3, 3), true);
    await flushed();
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(app(), "Hello");
    assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), "Hello");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
  });
}

test("Writer: a burst of 200 keys reaches both copies whole with the caret after the last key", async t => {
  const show = await enter(t), view = writer(t);
  view.caret("r1", 5);
  const keys = Array.from({ length: 200 }, (_, index) => index % 7 === 6 ? " " : String.fromCharCode(97 + index % 26));
  typeKeys(root(), keys);
  await flushed();
  const expected = "Hello" + keys.join("");
  assert.equal(app(), expected);
  assert.equal(beat().textContent.replace(/\u200b/g, ""), expected);
  assert.deepEqual(view.at(), ["r1", 205, 205]);
  await Promise.resolve();
  assert.equal(peer(), expected);
  assert.equal(show.mock.callCount(), 0);
});

const boldPeerEdits = [
  ["inserting before the range", peer => peer.type("r1", 0, "X"), [2, 4], "Xabcd"],
  ["inserting inside the range", peer => peer.type("r1", 2, "X"), [1, 4], "abXcd"],
  ["inserting after the range", peer => peer.type("r1", 4, "X"), [1, 3], "abcdX"],
  ["deleting the character before the range", peer => peer.delete("r1", 0, 1), [0, 2], "bcd"],
  ["deleting part of the range", peer => peer.delete("r1", 1, 2), [1, 2], "acd"]
];

for (const [name, change, [from, to], text] of boldPeerEdits) for (const peerFirst of [false, true]) {
  test(`Writer: bold selection replay after a peer edits by ${name}, peer first=${peerFirst}`, async t => {
    await enter(t, [{ id: "r1", audioText: "abcd" }]);
    const view = writer(t), other = hook.nativePeer;
    if (peerFirst) {
      assert.equal(change(other).kind, "written");
      await Promise.resolve();
    } else other.hold();
    view.caret("r1", peerFirst ? from : 1, peerFirst ? to : 3);
    assert.equal(press(root(), "b"), true);
    assert.match(app(), /<strong>/);
    if (!peerFirst) {
      assert.equal(change(other).kind, "written");
      other.deliver();
      await Promise.resolve();
    }
    for (const key of ["z", "y", "z"]) {
      assert.equal(press(root(), key), true);
      assert.deepEqual(view.flow.selection(), {
        anchor: { kind: "beat", rowId: "r1", offset: from },
        head: { kind: "beat", rowId: "r1", offset: to }
      });
      if (key === "z") assert.equal(app(), text);
      else assert.match(app(), /<strong>/);
      await Promise.resolve();
      assert.equal(peer(), app());
    }
  });
}

test("Writer: append to a 120,000-character beat and replay the caret through undo and redo", async t => {
  const original = "a".repeat(120000);
  await enter(t, [{ id: "r1", audioText: original }]);
  const view = writer(t);
  view.caret("r1", original.length);
  typeKeys(root(), "x");
  assert.equal(press(root(), "z"), true);
  assert.equal(app(), original);
  assert.deepEqual(view.flow.selection(), {
    anchor: { kind: "beat", rowId: "r1", offset: 120000 },
    head: { kind: "beat", rowId: "r1", offset: 120000 }
  });
  assert.equal(press(root(), "y"), true);
  assert.equal(app(), original + "x");
  assert.deepEqual(view.flow.selection(), {
    anchor: { kind: "beat", rowId: "r1", offset: 120001 },
    head: { kind: "beat", rowId: "r1", offset: 120001 }
  });
  await Promise.resolve();
  assert.equal(peer(), original + "x");
});

test("Writer: a peer edit in the same beat while letters are buffered keeps both", async t => {
  const show = await enter(t), view = writer(t);
  view.caret("r1", 5);
  typeKeys(root(), "ab");
  assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
  typeKeys(root(), "c");
  await flushed();
  assert.equal(app(), "YHelloabc");
  assert.equal(beat().textContent.replace(/\u200b/g, ""), "YHelloabc");
  assert.deepEqual(view.at(), ["r1", 9, 9]);
  await Promise.resolve();
  assert.equal(peer(), "YHelloabc");
  assert.equal(show.mock.callCount(), 0);
});

test("Writer: buffered letters are sent when focus leaves the page text or the page hides", async t => {
  await enter(t);
  const view = writer(t);
  view.caret("r1", 5);
  typeKeys(root(), "ab");
  root().dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  await Promise.resolve();
  assert.equal(app(), "Helloab");
  view.caret("r1", 7);
  typeKeys(root(), "c");
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(app(), "Helloabc");
});

test("a buffered write records its after-selection only when the session wrote it", t => {
  const doc = migrateRows({ title: "Native script", rows: [{ id: "r1", audioText: "Hello" }] });
  adoptReplacement(doc);
  const native = openNativeSession({ kind: "state", state: nativeBytes(doc) }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(native.close);
  const recorded = t.mock.fn(), results = [{ kind: "unchanged" }, { kind: "written" }];
  const typeText = Object.assign(() => assert.fail("a write without a recorded selection"),
    { withSelection: () => ({ result: results.shift(), recordAfter: recorded }) });
  const input = mountNativeSharedInput({
    native: { ...native, commands: { ...native.commands, typeText } }, report: assert.fail,
    editAttribution: () => ({ by: "Writer", at: "now" }), session: { admit: () => null, refuse: t.mock.fn(), subscribe: () => () => {} }
  });
  t.after(() => { input.dispose(); cell().textContent = "Hello"; });
  cell().focus();
  setCellSelection(cell(), 2);
  assert.equal(beforeInput(cell(), "insertText", "x"), true);
  assert.equal(input.finish(), null);
  assert.equal(recorded.mock.callCount(), 0);
  setCellSelection(cell(), 2);
  assert.equal(beforeInput(cell(), "insertText", "y"), true);
  assert.equal(input.finish(), null);
  assert.equal(recorded.mock.callCount(), 1);
});

const twoBeats = [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }];

test("Writer: moving between beats shows no notice, and a beat sync that changes the text is still refused", async t => {
  const show = await enter(t, twoBeats), view = writer(t);
  view.caret("r1", 2);
  view.caret("r2", 3);
  view.caret("r1", 1);
  assert.equal(show.mock.callCount(), 0);
  beat("r1").textContent = "Changed";
  view.caret("r2", 1);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  assert.deepEqual([app(0), app(1)], ["Hello", "World"]);
  await Promise.resolve();
  assert.deepEqual([peer(0), peer(1)], ["Hello", "World"]);
});

async function openFixture(t) {
  const fixture = entrySwitchFixture(), refused = t.mock.fn();
  const ports = { ...fixture.ports, commandRefused: refused };
  let native;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  t.after(cleanSession);
  return { native, refused };
}

const fixtureViews = {
  Split: {
    open: () => null,
    surface: () => cell("R1"),
    caret: (_view, offset) => { cell("R1").focus(); setCellSelection(cell("R1"), offset); },
    host: () => cell("R1")
  },
  Writer: {
    open: t => writer(t),
    surface: () => root(),
    caret: (view, offset) => { view.caret("R1", offset); },
    host: () => beat("R1")
  }
};

for (const [name, kind] of Object.entries(fixtureViews)) {
  test(name + ": insertion shortcuts stay quiet after native typing stops", async t => {
    const { native, refused } = await openFixture(t), view = kind.open(t);
    kind.caret(view, 8);
    assert.equal(compose(kind.surface(), "start", ""), false);
    native.close();
    await Promise.resolve();
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"]]);
    for (const shiftKey of [false, true]) assert.equal(press(kind.surface(), "Enter", { shiftKey }), true);
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"]]);
    assert.equal(kind.host().textContent.replace(/\u200b/g, ""), "Captured words");
  });

  test(name + ": retries share a single refusal during composition and at the size ceiling", async t => {
    const { native, refused } = await openFixture(t), view = kind.open(t), filler = new Doc();
    t.after(() => filler.destroy());
    search(t, "Captured", "New");
    const replace = () => document.getElementById("find-replace-all").click();
    const line = () => press(kind.surface(), "Enter", { ctrlKey: false, shiftKey: true });
    kind.caret(view, 4);
    assert.equal(compose(kind.surface(), "start", ""), false);
    for (let i = 0; i < 2; i++) { replace(); assert.equal(line(), true); }
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"]]);
    assert.equal(compose(kind.surface(), "end", ""), false);
    filler.getMap("sizeFixture").set("payload", "x".repeat(Math.ceil(native.sizeLimits.limit * 1.06)));
    assert.equal(applyNativePeerUpdate(native, encodeStateAsUpdate(filler)), true);
    await Promise.resolve();
    assert.equal(native.size, "full");
    kind.caret(view, 4);
    const revision = native.revision();
    for (let i = 0; i < 2; i++) { replace(); assert.equal(line(), true); }
    assert.equal(native.revision(), revision);
    assert.equal(kind.host().textContent, "Captured words");
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"], ["full"]]);
    typeKeys(kind.surface(), "  x");
    assert.equal(native.revision(), revision);
    assert.equal(kind.host().textContent, "Capt ured words");
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"], ["full"]]);
  });

  test(name + ": closed editor and Find retries stay quiet without reading the native projection", async t => {
    const { native, refused } = await openFixture(t), view = kind.open(t);
    const field = search(t, "Captured", "New");
    kind.caret(view, 4);
    native.close();
    await Promise.resolve();
    const reads = t.mock.method(NativeScriptReader.prototype, "document", () => { assert.fail("closed native projection was read"); });
    try {
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
      for (let i = 0; i < 2; i++) {
        assert.equal(press(kind.surface(), "Enter", { ctrlKey: false, shiftKey: true }), true);
        document.getElementById("find-replace").click();
        document.getElementById("find-replace-all").click();
      }
      assert.equal(reads.mock.callCount(), 0);
      assert.equal(kind.host().textContent, "Captured words");
      assert.equal(refused.mock.callCount(), 0);
    } finally { reads.mock.restore(); }
  });

  test(name + ": an undo press at the size ceiling with a letter buffered is silent and keeps the letter on screen", async t => {
    const { native, refused } = await openFixture(t), view = kind.open(t), filler = new Doc();
    t.after(() => filler.destroy());
    kind.caret(view, 8);
    assert.equal(beforeInput(kind.surface(), "insertText", "!"), true);
    filler.getMap("sizeFixture").set("payload", "x".repeat(native.sizeLimits.limit));
    assert.equal(applyNativePeerUpdate(native, encodeStateAsUpdate(filler)), true);
    await Promise.resolve();
    assert.equal(native.size, "full");
    const revision = native.revision();
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(native.revision(), revision);
    assert.equal(native.narrationHtml("R1"), "Captured words");
    assert.equal(kind.host().textContent.replace(/\u200b/g, ""), "Captured! words");
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), []);
  });

  test(name + ": an undo press after the session stopped during a composition adds nothing to the stop notice", async t => {
    const { native, refused } = await openFixture(t), view = kind.open(t);
    kind.caret(view, 8);
    assert.equal(compose(kind.surface(), "start", ""), false);
    native.close();
    await Promise.resolve();
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"]]);
    assert.equal(press(kind.surface(), "z", { isComposing: true }), true);
    press(document.body, "z");
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"]]);
    assert.equal(kind.host().textContent.replace(/\u200b/g, ""), "Captured words");
  });
}

for (const to of [2, 3]) test("Split: plain Enter matches standalone with " + (to === 2 ? "a caret" : "a selection"), async t => {
  const rows = [{ id: "r1", audioText: "Hello" }];
  const from = to === 2 ? 2 : 1;
  for (const native of [false, true]) {
    if (native) await enter(t, rows);
    else adoptReplacement(migrateRows({ title: "Split", rows: structuredClone(rows) }));
    views.Split.caret(null, "r1", from, to);
    assert.equal(press(cell(), "Enter", { ctrlKey: false }), true);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), [to === 2 ? "He<br>llo" : "H<br>lo"]);
    assert.deepEqual(views.Split.at(null), ["r1", from + 1, from + 1]);
    if (native) {
      assert.equal(press(cell(), "z"), true);
      assert.equal(app(), "Hello");
      assert.deepEqual(views.Split.at(null), ["r1", from, to]);
      assert.equal(press(cell(), "y"), true);
      assert.equal(app(), to === 2 ? "He<br>llo" : "H<br>lo");
      assert.deepEqual(views.Split.at(null), ["r1", from + 1, from + 1]);
    }
  }
});
const outOfScope = [
  ["typing over a selection across two beats", view => {
    view.flow.place({ anchor: { kind: "beat", rowId: "r1", offset: 2 }, head: { kind: "beat", rowId: "r2", offset: 2 } });
  }, () => beforeInput(root(), "insertText", "x")],
  ["formatting a selection across two beats", view => {
    view.flow.place({ anchor: { kind: "beat", rowId: "r1", offset: 1 }, head: { kind: "beat", rowId: "r2", offset: 3 } });
  }, () => press(root(), "b")],
  ["a rich paste", view => { view.caret("r1", 2); }, () => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      types: ["text/plain", "text/html"], getData: type => type === "text/html" ? "<strong>New</strong>" : "New"
    } });
    root().dispatchEvent(event);
    return event.defaultPrevented;
  }]
];
for (const [situation, place, act] of outOfScope) {
  test("Writer: " + situation + " is refused with the notice and loses nothing", async t => {
    const show = await enter(t, twoBeats), view = writer(t);
    view.caret("r1", 5);
    typeKeys(root(), "!");
    await flushed();
    place(view);
    const before = show.mock.callCount();
    assert.equal(act(), true);
    await flushed();
    assert.deepEqual(show.mock.calls.slice(before).map(call => call.arguments), [UNAVAILABLE]);
    assert.deepEqual([app(0), app(1)], ["Hello!", "World"]);
    assert.deepEqual([beat("r1").textContent, beat("r2").textContent].map(text => text.replace(/\u200b/g, "")), ["Hello!", "World"]);
    await Promise.resolve();
    assert.deepEqual([peer(0), peer(1)], ["Hello!", "World"]);
  });
}
