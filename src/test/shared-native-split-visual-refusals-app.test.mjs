import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { trackGlobalListeners } from "./_global-listener-inventory.mjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { currentWhoList } from "../bootstrap/wiring/who-list.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { nativeEntrySwitchFixture as entrySwitchFixture } from "../../tests/bootstrap/native-entry-switch-support.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const inventory = trackGlobalListeners();
await bootApp();
after(closeApp);
const eventErrors = [];
const onError = event => { eventErrors.push(event.error); event.preventDefault(); };
window.addEventListener("error", onError);
after(() => { window.removeEventListener("error", onError); });

const warning = ["This is not available in a shared session yet.", "warn"];
const field = "visualText";
const cell = (id = "r1") => document.querySelector(`#rows .cell-editable[data-id="${id}"][data-field="${field}"]`);
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const cells = doc => doc.rows.map(({ id, audioText, visualText }) => [id, audioText, visualText]);
const currentSelection = () => {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = document.getSelection();
  return [document.activeElement, anchorNode, anchorOffset, focusNode, focusOffset];
};
const projected = () => structuredClone(currentDocument());
const place = (node, from, to = from) => { node.focus(); setCellSelection(node, from, to); };

const transferRoutes = [
  ["paste", "paste"], ["cut", "cut"], ["drop", "drop"], ["drop other", "drop", true]
].map(([name, type, elsewhere]) => ({ name, type, elsewhere }));
const inputRoutes = [
  "insertFromPaste", "insertFromDrop", "deleteByCut", "deleteByDrag", "insertParagraph", "insertLineBreak",
  "formatBold", "formatItalic", "formatUnderline", "historyUndo", "historyRedo", "insertOrderedList",
  "insertUnorderedList", "insertTranspose"
].map(inputType => ({ name: inputType, type: "beforeinput", inputType }));
const keyRoutes = [
  ["Enter", "Enter"], ["Ctrl+Enter", "Enter", { ctrlKey: true }], ["Alt+Enter", "Enter", { altKey: true }],
  ["Alt+Up", "ArrowUp", { altKey: true }], ["Alt+Down", "ArrowDown", { altKey: true }],
  ["Ctrl+B", "b", { ctrlKey: true }], ["Ctrl+I", "i", { ctrlKey: true }], ["Ctrl+U", "u", { ctrlKey: true }],
  ["Tab", "Tab"]
].map(([name, key, modifiers]) => ({ name, type: "keydown", key, modifiers }));
const routes = [...transferRoutes, ...inputRoutes, ...keyRoutes];
const states = ["caret", "selection", "typed", "composition"];

function input(node, inputType, data = null) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data });
  const range = document.getSelection().getRangeAt(0);
  Object.defineProperty(event, "getTargetRanges", { value: () => [range.cloneRange()] });
  node.dispatchEvent(event);
  return event;
}

function compose(node, stage, data = "") {
  node.dispatchEvent(new window.CompositionEvent("composition" + stage, { bubbles: true, data }));
}

function preview(node) {
  compose(node, "start");
  compose(node, "update", "X");
  const range = document.getSelection().getRangeAt(0);
  const before = new window.InputEvent("beforeinput", {
    bubbles: true, cancelable: false, inputType: "insertCompositionText", data: "X", isComposing: true
  });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  assert.equal(node.dispatchEvent(before), true);
  const inserted = document.createTextNode("X");
  range.insertNode(inserted);
  document.getSelection().collapse(inserted, 1);
  node.dispatchEvent(new window.InputEvent("input", {
    bubbles: true, inputType: "insertCompositionText", data: "X", isComposing: true
  }));
}

function dispatch(route, target, accesses) {
  if (route.type === "beforeinput") return input(target, route.inputType);
  const event = route.type === "keydown"
    ? new window.KeyboardEvent(route.type, { bubbles: true, cancelable: true, key: route.key, ...route.modifiers })
    : new window.Event(route.type, { bubbles: true, cancelable: true });
  if (route.type !== "keydown") {
    Object.defineProperty(event, route.type === "drop" ? "dataTransfer" : "clipboardData", { value: {
      files: [], types: ["text/plain"],
      getData: format => { accesses.push(["get", format]); return format === "text/plain" ? "pasted" : ""; },
      setData: (...args) => accesses.push(["set", ...args])
    } });
  }
  target.dispatchEvent(event);
  return event;
}

async function enter(order, mention) {
  const fixture = entrySwitchFixture();
  const audio = mention ? "@Alice" : "abcdef";
  const visual = mention ? "Alice" : "abcdef";
  adoptReplacement(migrateRows({ schema: 2, title: "Split Visual refusals", paragraphsDecided: true,
    people: [{ id: "p1", name: "Alice" }], rows: [
      { id: "r1", audioText: audio, visualText: visual }, { id: "r2", audioText: "other", visualText: "other" }
    ] }));
  undoOwner().flush();
  const writer = writerControls();
  writer.openWriter();
  const ports = { ...fixture.ports, commandRefused: sharedCommandRefusalNotice(notices) };
  let native;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  writer.closeWriter();
  const peer = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Peer" });
  const packets = [];
  const unsubscribe = peer.subscribeLocalUpdates(bytes => packets.push(bytes));
  for (const [offset, letter] of [[0, "P"], [1, "Q"]]) {
    const at = peer.commands.anchorText({ beat: "r2", cell: "narration" }, offset);
    assert.equal(at.kind, "anchored");
    assert.equal(peer.commands.typeText(at.range, letter, {}).kind, "written");
  }
  unsubscribe();
  assert.equal(packets.length, 2);
  for (const bytes of order === "reverse" ? packets.toReversed() : packets) {
    assert.equal(applyNativePeerUpdate(native, bytes), true);
  }
  await tick();
  assert.deepEqual(cells(currentDocument()), [["r1", audio, visual], ["r2", "PQother", "other"]]);
  assert.deepEqual(currentDocument(), peer.document());
  return { native, peer, errors: fixture.errors };
}

const marks = new Map([
  ["formatBold", "strong"], ["Ctrl+B", "strong"], ["formatItalic", "em"], ["Ctrl+I", "em"],
  ["formatUnderline", "u"], ["Ctrl+U", "u"]
]);
const breaks = new Set(["Enter", "insertParagraph", "insertLineBreak"]);

function expectedEdit(route, state) {
  if (state === "composition") return null;
  const mark = state === "selection" && marks.get(route.name);
  if (mark) return { html: `ab<${mark}>cd</${mark}>ef`, from: 2, to: 4 };
  if (route.name === "historyUndo" && state === "typed") return { html: "abcdef", from: 3, to: 3 };
  if (route.name === "Ctrl+Enter") return { added: true, from: 0, to: 0 };
  if (route.name !== "paste" && !breaks.has(route.name)) return null;
  const insert = route.name === "paste" ? "pasted" : "<br>";
  const prefix = state === "selection" ? "ab" : state === "typed" ? "abcX" : "abc";
  const offset = prefix.length + (insert === "<br>" ? 1 : insert.length);
  return { html: prefix + insert + (state === "selection" ? "ef" : "def"), from: offset, to: offset };
}

function expectedNotices(route, state, edit) {
  if (route.name === "Tab" && (state === "selection" || state === "composition")) return [];
  if (edit || state !== "composition" && route.name.startsWith("history")) return [];
  return [warning];
}

function expectedPrevented(route, state) {
  return !(route.name === "Tab" && state === "composition");
}

function expectedPickerOpen(route, state) {
  return route.name === "Tab" && state === "composition";
}

function paint(expected) {
  for (const [id, , html] of cells(expected)) assert.equal(cell(id).innerHTML, html);
}

function editedDocument(before, edit, route, focusId) {
  const rows = before.rows.slice();
  if (edit.added) {
    const { updatedAt } = currentDocument().rows[1];
    assert.equal(new Date(updatedAt).toISOString(), updatedAt);
    rows.splice(1, 0, {
      id: focusId, audioText: "", visualText: "", status: "todo", updatedAt, updatedBy: "Anonymous"
    });
  } else {
    const writesText = route.name === "paste" || breaks.has(route.name);
    const attribution = writesText ? { updatedAt: new Date(0).toISOString(), updatedBy: "Editor" } : {};
    rows[0] = { ...rows[0], visualText: edit.html, ...attribution };
  }
  return { ...before, rows };
}

function coherent(native, peer) {
  assert.equal(applyNativePeerUpdate(peer, native.encodeState()), true);
  assert.deepEqual(currentDocument(), native.document());
  assert.deepEqual(currentDocument(), peer.document());
}

async function verifyHistory(native, peer, route, state, edit, before) {
  const after = projected();
  const mention = route.name === "Tab";
  const undoable = route.name === "historyUndo" && edit ? false : !!edit || state === "typed" || mention;
  assert.equal(native.commands.undo().kind, undoable ? "written" : "unchanged");
  await tick();
  if (!undoable) {
    assert.deepEqual(currentDocument(), after);
    if (route.name === "historyUndo" && edit) {
      assert.equal(native.commands.redo().kind, "written");
      await tick();
      assert.deepEqual(cells(currentDocument()), cells(before));
      assert.equal(native.commands.undo().kind, "written");
      await tick();
    }
  } else {
    const previous = cells(before);
    if (!edit) previous[0][2] = mention ? (state === "typed" ? "@Alice" : "Alice") : "abcdef";
    assert.deepEqual(cells(currentDocument()), previous);
    if (state === "typed" && (edit || mention)) {
      assert.equal(native.commands.undo().kind, "written");
      await tick();
      previous[0][2] = mention ? "Alice" : "abcdef";
      assert.deepEqual(cells(currentDocument()), previous);
      assert.equal(native.commands.undo().kind, "unchanged");
      assert.equal(native.commands.redo().kind, "written");
      await tick();
      assert.deepEqual(cells(currentDocument()), mention ? cells(before).map((row, index) => index === 0 ? [row[0], row[1], "@Alice"] : row) : cells(before));
    } else assert.equal(native.commands.undo().kind, "unchanged");
    assert.equal(native.commands.redo().kind, "written");
    await tick();
  }
  assert.deepEqual(cells(currentDocument()), cells(after));
  coherent(native, peer);
}

for (const order of ["forward", "reverse"]) {
  test(`Split Visual refusal matrix, ${order}`, async t => {
    const show = t.mock.method(notices, "show", () => {});
    const owner = undoOwner();
    const standaloneUndo = Object.keys(owner).filter(name => typeof owner[name] === "function")
      .map(name => t.mock.method(owner, name));
    let checked = 0;
    for (const route of routes) for (const state of states) {
      const baseline = inventory(), mention = route.name === "Tab";
      const { native, peer, errors } = await enter(order, mention);
      const node = cell(), who = currentWhoList(), accesses = [];
      try {
        if (mention) {
          place(node, 0);
          assert.equal(input(node, "insertText", "@").defaultPrevented, true);
          await tick();
          assert.equal(applyNativePeerUpdate(peer, native.encodeState()), true);
          native.endTypingGroup();
          assert.equal(who.isOpen(node), true);
          assert.equal(document.getElementById("who-list").hidden, false);
        }
        place(node, state === "selection" ? 2 : 3, state === "selection" ? 4 : 3);
        if (state === "composition") preview(node);
        if (state === "typed") {
          assert.equal(input(node, "insertText", "X").defaultPrevented, true);
          await tick();
          assert.equal(applyNativePeerUpdate(peer, native.encodeState()), true);
        }
        const before = projected(), html = node.innerHTML, selection = currentSelection();
        const untouched = mention ? "@Alice" : "abcdef", typed = mention ? "@AlXice" : "abcXdef";
        assert.equal(before.rows[0].visualText, state === "typed" ? typed : untouched);
        assert.equal(html, state === "typed" || state === "composition" ? typed : untouched);
        const bytes = native.encodeState(), peerBytes = peer.encodeState(), updates = [];
        const stop = native.subscribeLocalUpdates(update => updates.push(update));
        show.mock.resetCalls();
        for (const method of standaloneUndo) method.mock.resetCalls();
        const event = dispatch(route, route.elsewhere ? cell("r2") : cell(), accesses);
        const immediate = show.mock.calls.map(call => call.arguments);
        await tick();
        stop();
        const edit = expectedEdit(route, state), warnings = expectedNotices(route, state, edit);
        const label = `${route.name}/${state}`;
        assert.deepEqual([errors, eventErrors], [[], []], label);
        assert.equal(standaloneUndo.reduce((count, method) => count + method.mock.calls.length, 0), 0, label);
        assert.deepEqual(accesses, route.name === "paste" ? [["get", "text/plain"]] : [], label);
        assert.equal(event.defaultPrevented, expectedPrevented(route, state), label);
        assert.deepEqual(immediate, warnings, label);
        assert.deepEqual(show.mock.calls.map(call => call.arguments), warnings, label);
        if (mention) {
          assert.equal(who.isOpen(node), expectedPickerOpen(route, state), label);
          assert.equal(document.getElementById("who-list").hidden, !expectedPickerOpen(route, state), label);
        }
        assert.deepEqual(peer.encodeState(), peerBytes, label);
        assert.deepEqual(peer.document(), before, label);
        if (edit) {
          const focusId = edit.added ? currentDocument().rows[1].id : "r1";
          if (edit.added) assert.ok(!before.rows.some(row => row.id === focusId), label);
          const expected = editedDocument(before, edit, route, focusId);
          assert.deepEqual(currentDocument(), expected, label);
          assert.notDeepEqual(native.encodeState(), bytes, label);
          assert.equal(updates.length, 1, label);
          assert.equal(applyNativePeerUpdate(peer, updates[0]), true, label);
          assert.deepEqual(currentDocument(), peer.document(), label);
          assert.deepEqual(currentDocument(), native.document(), label);
          assert.equal(document.activeElement, cell(focusId), label);
          assert.deepEqual(cellSelection(cell(focusId)), { from: edit.from, to: edit.to }, label);
          paint(expected);
        } else {
          assert.deepEqual(currentDocument(), before, label);
          assert.deepEqual(native.document(), before, label);
          assert.deepEqual(native.encodeState(), bytes, label);
          assert.deepEqual(updates, [], label);
          assert.equal(cell().innerHTML, html, label);
          currentSelection().forEach((value, index) => assert.equal(value, selection[index], label));
        }
        who.cancel();
        if (state === "composition") {
          compose(cell(), "end");
          assert.deepEqual(currentDocument(), before, label);
          assert.equal(cell().innerHTML, before.rows[0].visualText, label);
        }
        await verifyHistory(native, peer, route, state, edit, before);
        const landed = projected();
        assert.deepEqual(leaveRunningSharedSession(), { ok: true }, label);
        assert.notEqual(currentDocument().docId, landed.docId, label);
        assert.deepEqual({ ...currentDocument(), docId: landed.docId }, migrateRows(landed), label);
        assert.equal(native.isClosingOrClosed(), true, label);
        assert.equal(sharedSession(), false, label);
        checked++;
      } finally {
        who.cancel();
        if (sharedSession()) {
          if (state === "composition") compose(cell(), "end");
          if (!leaveRunningSharedSession().ok) forceLeaveSharedSession();
        }
        peer.close();
        assert.equal(peer.isClosingOrClosed(), true);
        assert.deepEqual(inventory(), baseline);
      }
    }
    assert.equal(checked, 108);
  });
}
