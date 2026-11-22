import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { trackGlobalListeners } from "./_global-listener-inventory.mjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml } from "../bootstrap/richtext.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { cellSelection } from "../features/common/cell-selection.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const listenerInventory = trackGlobalListeners();
await bootApp();
after(closeApp);

const source = [
  { id: "r1", audioText: "abcdef", visualText: "abcdef" },
  { id: "r2", audioText: "other", visualText: "other" }
];
const inputs = ["insertFromPaste", "insertFromDrop", "deleteByCut", "deleteByDrag", "insertParagraph", "insertLineBreak",
  "formatBold", "formatItalic", "formatUnderline", "historyUndo", "historyRedo", "insertOrderedList", "insertUnorderedList", "insertTranspose"];
const keys = [
  ["Enter", {}], ["Enter", { ctrlKey: true }], ["Enter", { altKey: true }],
  ["ArrowUp", { altKey: true }], ["ArrowDown", { altKey: true }],
  ["b", { ctrlKey: true }], ["i", { ctrlKey: true }], ["u", { ctrlKey: true }]
];
const routes = [
  ...["paste", "cut", "drop"].map(type => ({ type, name: type })),
  ...inputs.map(inputType => ({ type: "beforeinput", inputType, name: inputType })),
  ...keys.map(([key, modifiers]) => ({ type: "keydown", key, modifiers, name: Object.keys(modifiers).join("") + key }))
];
const states = ["caret", "selection", "pending", "composition"];
const app = () => currentDocument();
const rows = doc => doc.rows.map(({ id, audioText, visualText }) => [id, audioText, visualText]);
const cell = (id = "r1") => document.querySelector(`#rows .cell-editable[data-id="${id}"][data-field="audioText"]`);
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const settle = () => window.dispatchEvent(new window.Event("pagehide"));

function select(node, from, to = from) {
  node.focus();
  const a = posToDom(node, from), h = posToDom(node, to);
  document.getSelection().setBaseAndExtent(a.node, a.offset, h.node, h.offset);
}

function selection(node) {
  const s = document.getSelection();
  return [node.innerHTML, document.activeElement, s.anchorNode, s.anchorOffset, s.focusNode, s.focusOffset];
}

function preview(node, composing) {
  const range = document.getSelection().getRangeAt(0).cloneRange();
  if (composing) {
    node.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    node.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, data: "X" }));
  }
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: !composing,
    inputType: composing ? "insertCompositionText" : "insertText", data: "X", isComposing: composing });
  Object.defineProperty(event, "getTargetRanges", { value: () => [range.cloneRange()] });
  assert.equal(node.dispatchEvent(event), composing);
  if (composing) {
    range.deleteContents();
    const text = document.createTextNode("X");
    range.insertNode(text);
    document.getSelection().setBaseAndExtent(text, 1, text, 1);
    node.dispatchEvent(new window.InputEvent("input", {
      bubbles: true, inputType: "insertCompositionText", data: "X", isComposing: true
    }));
  }
  assert.equal(node.textContent, "abcXdef");
  assertCaret("r1", 4);
}

function dispatch(route, target, access) {
  const event = route.type === "keydown" ? new window.KeyboardEvent("keydown", {
    bubbles: true, cancelable: true, key: route.key, ...route.modifiers
  }) : route.type === "beforeinput" ? new window.InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: route.inputType, data: null
  }) : new window.Event(route.type, { bubbles: true, cancelable: true });
  if (["paste", "cut", "drop"].includes(route.type)) {
    Object.defineProperty(event, route.type === "drop" ? "dataTransfer" : "clipboardData", {
      value: {
        files: [], types: ["text/plain"],
        getData: format => { access.push(format); return format === "text/plain" ? "pasted" : ""; },
        setData: (...args) => { access.push(args); }
      }
    });
  }
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function assertCaret(id, from, to = from) {
  assert.equal(document.activeElement, cell(id));
  assert.deepEqual(cellSelection(cell(id)), { from, to });
}

async function enter(t, order) {
  const fixture = entrySwitchFixture();
  const show = t.mock.method(notices, "show", () => {});
  const ports = { ...fixture.ports, commandRefused: sharedCommandRefusalNotice(notices) };
  adoptReplacement(migrateRows({ schema: 2, title: "Split Audio refusals", paragraphsDecided: true,
    people: [{ id: "p1", name: "Alice" }], rows: source }));
  const originalId = app().docId;
  const writer = writerControls();
  const baseline = listenerInventory();
  writer.openWriter();
  let native;
  assert.deepEqual(await enterSharedSession(ports, (script, failed) => {
    const opened = openNativeEditor(ports, script, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  const peer = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml });
  t.after(() => {
    try {
      if (sharedSession()) forceLeaveSharedSession();
      writer.closeWriter();
    } finally { peer.close(); }
  });
  writer.closeWriter();
  const incoming = [];
  const stop = peer.subscribeLocalUpdates(bytes => incoming.push(bytes));
  for (const [offset, value] of [[0, "P"], [1, "Q"]]) {
    const anchored = peer.commands.anchorText({ beat: "r2", cell: "narration" }, offset);
    assert.equal(anchored.kind, "anchored");
    assert.equal(peer.commands.typeText(anchored.range, value, {}).kind, "written");
  }
  stop();
  assert.equal(incoming.length, 2);
  assert.deepEqual(rows(app()), [["r1", "abcdef", "abcdef"], ["r2", "other", "other"]]);
  for (const bytes of order === "reverse" ? incoming.toReversed() : incoming) {
    assert.equal(applyNativePeerUpdate(native, bytes), true);
  }
  await tick();
  assert.deepEqual(rows(app()), [["r1", "abcdef", "abcdef"], ["r2", "PQother", "other"]]);
  assert.deepEqual(native.document(), app());
  assert.deepEqual(peer.document(), app());
  const outgoing = [];
  native.subscribeLocalUpdates(bytes => outgoing.push(bytes));
  return { native, peer, outgoing, show, errors: fixture.errors, originalId, baseline };
}

const warning = [["This is not available in a shared session yet.", "warn"]];
const marks = new Map([["formatBold", "strong"], ["ctrlKeyb", "strong"], ["formatItalic", "em"], ["ctrlKeyi", "em"],
  ["formatUnderline", "u"], ["ctrlKeyu", "u"]]);
const baseRows = [["r1", "abcdef", "abcdef"], ["r2", "PQother", "other"]];
const typedRows = [["r1", "abcXdef", "abcdef"], baseRows[1]];

function expectation(route, state) {
  const pending = state === "pending";
  const typed = pending ? "abcXdef" : "abcdef";
  const [from, to] = state === "selection" ? [2, 4] : pending || state === "composition" ? [4, 4] : [3, 3];
  const base = { rows: baseRows, from, to, packets: 0, steps: 0, warnings: warning };
  if (state === "composition") return base;
  const result = (audio, offset, count = 1) => ({
    rows: [["r1", audio, "abcdef"], baseRows[1]], from: offset, to: offset,
    packets: count + Number(pending), steps: count + Number(pending), warnings: []
  });
  switch (route.name) {
    case "paste":
      return result(typed.slice(0, from) + "pasted" + typed.slice(to), from + 6);
    case "Enter":
    case "insertParagraph":
    case "insertLineBreak":
      return result(typed.slice(0, from) + "<br>" + typed.slice(to), from + 1);
    case "ctrlKeyEnter":
      return { ...result(typed, 0), rows: [["r1", typed, "abcdef"], ["new", "", ""], baseRows[1]], focus: "new" };
    case "altKeyEnter":
      return { ...result(typed, 0), rows: [["r1", typed.slice(0, from), "abcdef"], ["new", typed.slice(to), ""], baseRows[1]], focus: "new" };
    case "altKeyArrowDown":
      return { ...result(typed, from), to, rows: [baseRows[1], ["r1", typed, "abcdef"]] };
    case "historyUndo":
      return pending ? { ...base, from: 3, to: 3, packets: 2, warnings: [] } : { ...base, warnings: [] };
    case "historyRedo":
      return pending ? result(typed, 4, 0) : { ...base, warnings: [] };
  }
  const mark = marks.get(route.name);
  if (mark && state === "selection") {
    return { ...result("ab<" + mark + ">cd</" + mark + ">ef", 2), to: 4 };
  }
  if (mark && pending) return { ...base, rows: typedRows, steps: 1 };
  return base;
}

function assertReplicas(f) {
  assert.deepEqual(f.native.document(), app());
  assert.deepEqual(f.peer.document(), app());
}

function expectedDocument(before, content, made, blank) {
  return { ...before, rows: content.map(([id, audioText, visualText]) => id === "new"
    ? { id: made, audioText, visualText, ...(blank ? { status: "todo" } : {}) }
    : { ...before.rows.find(row => row.id === id), audioText, visualText }) };
}

function withoutEditStamps(doc) {
  const copy = structuredClone(doc);
  for (const row of copy.rows) {
    delete row.updatedAt;
    delete row.updatedBy;
  }
  return copy;
}

function assertDocument(f, expected) {
  assertReplicas(f);
  assert.deepEqual(withoutEditStamps(app()), withoutEditStamps(expected));
}

function sendOutgoing(f) {
  for (const bytes of f.outgoing.splice(0)) {
    assert.ok(bytes.length > 0);
    assert.equal(applyNativePeerUpdate(f.peer, bytes), true);
  }
  assertReplicas(f);
}

function assertPaint() {
  for (const row of app().rows) {
    assert.equal(cell(row.id).innerHTML.replace(/\u200b/g, ""), row.audioText);
    const visual = document.querySelector('#rows .cell-editable[data-id="' + row.id + '"][data-field="visualText"]');
    assert.equal(visual.innerHTML.replace(/\u200b/g, ""), row.visualText);
  }
}

async function checkHistory(f, steps, before, settled) {
  const typed = expectedDocument(before, typedRows);
  for (let step = 1; step <= steps; step++) {
    assert.equal(dispatch({ type: "beforeinput", inputType: "historyUndo" }, document.activeElement, []), true);
    await tick();
    assert.equal(f.outgoing.length, 1);
    sendOutgoing(f);
    assertDocument(f, step < steps ? typed : before);
    assertPaint();
  }
  const base = app(), bytes = f.native.encodeState();
  assert.equal(dispatch({ type: "beforeinput", inputType: "historyUndo" }, document.activeElement, []), true);
  await tick();
  assert.deepEqual(app(), base);
  assert.deepEqual(f.native.encodeState(), bytes);
  assert.deepEqual(f.outgoing, []);
  for (let step = 1; step <= steps; step++) {
    assert.equal(dispatch({ type: "beforeinput", inputType: "historyRedo" }, document.activeElement, []), true);
    await tick();
    assert.equal(f.outgoing.length, 1);
    sendOutgoing(f);
    assertDocument(f, step < steps ? typed : settled);
    assertPaint();
  }
}

for (const order of ["forward", "reverse"]) {
  test("Split Audio refusal table, " + order + " delivery", async t => {
    let mapped = 0, retained = 0;
    for (const route of routes) for (const state of states) for (const elsewhere of route.type === "drop" ? [false, true] : [false]) {
      if (route.name === "altKeyArrowUp" && state !== "composition") {
        retained++;
        continue;
      }
      await t.test(route.name + "/" + state + "/other=" + elsewhere, async sub => {
        const f = await enter(sub, order);
        const node = cell();
        select(node, state === "selection" ? 2 : 3, state === "selection" ? 4 : 3);
        if (state === "pending" || state === "composition") preview(node, state === "composition");
        const before = { doc: app(), bytes: f.native.encodeState(), peerBytes: f.peer.encodeState(), selection: selection(node) };
        const standalone = undoOwner();
        const hooks = Object.keys(standalone).filter(name => typeof standalone[name] === "function")
          .map(name => sub.mock.method(standalone, name, () => assert.fail("Split Audio reached standalone Undo: " + name)));
        const access = [];
        const expected = expectation(route, state);
        const pendingFormat = state === "pending" && marks.has(route.name);
        let made;
        try {
          assert.equal(dispatch(route, elsewhere ? cell("r2") : node, access), true);
          assert.deepEqual(f.show.mock.calls.map(call => call.arguments), expected.warnings);
          await tick();
          assert.deepEqual(f.show.mock.calls.map(call => call.arguments), expected.warnings);
          assert.deepEqual(access, route.type === "paste" ? ["text/plain"] : []);
          assert.deepEqual(f.peer.encodeState(), before.peerBytes);
          assert.deepEqual(f.peer.document(), before.doc);
          if (!pendingFormat) assert.equal(f.outgoing.length, expected.packets);
          if (!pendingFormat && !expected.packets) {
            assert.deepEqual(app(), before.doc);
            assert.deepEqual(f.native.encodeState(), before.bytes);
            assert.deepEqual(selection(node), before.selection);
          }
          if (expected.focus === "new") {
            const ids = app().rows.map(row => row.id).filter(id => id !== "r1" && id !== "r2");
            assert.equal(ids.length, 1);
            made = ids[0];
            assert.match(made, new RegExp("^r" + f.native.ydoc.clientID.toString(36) + "-[0-9a-z]+$"));
          }
          const afterGesture = expectedDocument(before.doc, expected.rows, made, route.name === "ctrlKeyEnter");
          if (!pendingFormat) {
            assert.deepEqual(withoutEditStamps(app()), withoutEditStamps(afterGesture));
            assertCaret(made ?? "r1", expected.from, expected.to);
          }
          if (state === "composition") {
            node.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
          }
          settle();
          await tick();
          const buffered = state === "pending" && !expected.packets;
          const typed = expectedDocument(before.doc, typedRows);
          if (buffered) {
            assertCaret("r1", 4);
            assert.equal(f.outgoing.length, 1);
          }
          if (state === "composition") {
            assert.deepEqual(app(), before.doc);
            assert.deepEqual(f.native.encodeState(), before.bytes);
            assert.deepEqual(f.outgoing, []);
            assertCaret("r1", 3);
          }
          sendOutgoing(f);
          const settled = buffered ? typed : afterGesture;
          assertDocument(f, settled);
          assertPaint();
          if (route.name === "historyUndo" && state === "pending") {
            assert.equal(dispatch({ type: "beforeinput", inputType: "historyRedo" }, document.activeElement, []), true);
            await tick();
            assert.equal(f.outgoing.length, 1);
            sendOutgoing(f);
            assertDocument(f, typed);
            assertCaret("r1", 4);
            assertPaint();
            await checkHistory(f, 1, before.doc, typed);
          } else {
            await checkHistory(f, buffered ? 1 : expected.steps, before.doc, settled);
          }
          assert.deepEqual(f.show.mock.calls.map(call => call.arguments), expected.warnings);
          assert.deepEqual(f.errors, []);
        } finally {
          for (const hook of hooks) hook.mock.restore();
        }
        const landed = app();
        assert.deepEqual(leaveRunningSharedSession(), { ok: true });
        assert.equal(sharedSession(), false);
        assert.equal(f.native.isClosingOrClosed(), true);
        assert.notEqual(app().docId, landed.docId);
        assert.notEqual(app().docId, f.originalId);
        assert.deepEqual(app(), migrateRows({ ...structuredClone(landed), docId: app().docId }));
        assert.deepEqual(listenerInventory(), f.baseline);
        assert.deepEqual(f.errors, []);
      });
      mapped++;
    }
    assert.deepEqual([mapped, retained], [101, 3]);
  });
}
