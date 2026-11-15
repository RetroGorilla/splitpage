import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { currentWhoList } from "../bootstrap/wiring/who-list.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { useDesktopForTest, restoreDesktop } from "../adapters/desktop/desktop-port.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { registerSharedOperationFamilies } from "../adapters/collab/operation-families.ts";
import { projectSharedDocumentWithRecovery } from "../adapters/collab/project.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
useDesktopForTest({ writeDraft: async payload => ({ ok: true, seq: payload.seq }), discardDraft: async () => ({ ok: true }),
  setDocumentState: () => {}, draftRestoreDone: () => {} });
after(() => { restoreDesktop(); closeApp(); });
const hook = window.__sharedTest, calls = [], errors = [], warningCalls = [];
const notice = notices.show;
notices.show = (...args) => { warningCalls.push(args); return notice(...args); };
after(() => { notices.show = notice; });
const legacy = undoOwner(), methods = new Map();
let watching = false;
for (const name of Object.keys(legacy)) if (typeof legacy[name] === "function") {
  const method = legacy[name]; methods.set(name, method);
  legacy[name] = function (...args) {
    if (watching && sharedSession()) { calls.push(name); assert.fail("Split native route reached standalone undo: " + name); }
    return method.apply(this, args);
  };
}
after(() => { for (const [name, method] of methods) legacy[name] = method; });
const onError = event => { errors.push(event.error); event.preventDefault(); };
window.addEventListener("error", onError);
after(() => { window.removeEventListener("error", onError); });
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const cellOf = (field, id = "r1") => document.querySelector(`#rows .cell-editable[data-id="${id}"][data-field="${field}"]`);
function select(cell, from, to = from) {
  cell.focus();
  const a = posToDom(cell, from), h = posToDom(cell, to);
  document.getSelection().setBaseAndExtent(a.node, a.offset, h.node, h.offset);
}
function snapshot(cell) {
  const s = document.getSelection();
  return { doc: hook.read(), encoded: encodeSharedState(sharedSessionParts().handle), updates: hook.peer.appliedUpdates().slice(), sizes: sharedSessionParts().undo.sizes(),
    html: cell.innerHTML, active: document.activeElement,
    anchor: s.anchorNode, head: s.focusNode, offsets: [s.anchorOffset, s.focusOffset] };
}
async function enter(order, mention = false) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ schema: 2, title: "Split refusals", paragraphsDecided: true,
    people: [{ id: "p1", name: "Alice" }], rows: [
      { id: "r1", audioText: mention ? "@Alice" : "abcdef", visualText: mention ? "@Alice" : "abcdef" },
      { id: "r2", audioText: "other", visualText: "other" }
    ] }));
  undoOwner().flush(); writerControls().openWriter();
  assert.deepEqual(await hook.enter(), { ok: true });
  writerControls().closeWriter();
  hook.peer.hold(); hook.peer.type("r2", 0, "P"); hook.peer.type("r2", 1, "Q"); hook.peer.release(order);
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), [mention ? "@Alice" : "abcdef", "PQother"]);
}
function pending(cell, composition) {
  const r = document.getSelection().getRangeAt(0).cloneRange();
  if (composition) {
    cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    cell.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, data: "X" }));
  }
  const e = new window.InputEvent("beforeinput", { bubbles: true, cancelable: !composition,
    inputType: composition ? "insertCompositionText" : "insertText", data: "X", isComposing: composition });
  Object.defineProperty(e, "getTargetRanges", { value: () => [r.cloneRange()] });
  assert.equal(cell.dispatchEvent(e), true);
  r.deleteContents(); const n = document.createTextNode("X"); r.insertNode(n);
  document.getSelection().setBaseAndExtent(n, 1, n, 1);
  if (composition) cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "X", isComposing: true }));
}
const INPUTS = ["insertFromPaste", "insertFromDrop", "deleteByCut", "deleteByDrag", "insertParagraph", "insertLineBreak",
  "formatBold", "formatItalic", "formatUnderline", "historyUndo", "historyRedo", "insertOrderedList", "insertUnorderedList", "insertTranspose"];
const KEYS = [
  ["Enter", {}], ["Enter", { ctrlKey: true }], ["Enter", { altKey: true }],
  ["ArrowUp", { altKey: true }], ["ArrowDown", { altKey: true }],
  ["b", { ctrlKey: true }], ["i", { ctrlKey: true }], ["u", { ctrlKey: true }]
];
const ROUTES = [
  ...["paste", "cut", "drop"].map(type => ({ name: type, type })),
  ...INPUTS.map(inputType => ({ name: inputType, type: "beforeinput", inputType })),
  ...KEYS.map(([key, modifiers]) => ({ name: key + JSON.stringify(modifiers), type: "keydown", key, modifiers })),
  { name: "Tab accepts a person suggestion", type: "keydown", key: "Tab", mention: true }
];
const SERVED = {
  'Enter{"ctrlKey":true}': { audioText: "add", visualText: "add" },
  'Enter{"altKey":true}': { audioText: "split", visualText: "refused by name" }
};
function servedRows(command, field, state) {
  const typed = state === "pending" ? "abcXdef" : "abcdef", other = field === "audioText" ? "abcdef" : typed;
  const mine = field === "audioText" ? typed : "abcdef";
  if (command === "add") return [["r1", field === "audioText" ? typed : "abcdef", field === "visualText" ? typed : "abcdef"], ["new", "", ""], ["r2", "PQother", "other"]];
  const cut = state === "selection" ? [2, 4] : state === "pending" ? [4, 4] : [3, 3];
  return [["r1", mine.slice(0, cut[0]), other], ["new", mine.slice(cut[1]), ""], ["r2", "PQother", "other"]];
}
function servedRow(route, field, state, before, e, label) {
  const command = SERVED[route.name]?.[field];
  if (!command || state === "composition" || command === "refused by name" && state !== "pending") return false;
  assert.equal(e.defaultPrevented, true, label);
  if (command === "refused by name") {
    assert.deepEqual(warningCalls, [["This is not available in a shared session yet.", "warn"]], label);
    assert.deepEqual(hook.read().app.rows.map(row => [row.id, row.audioText, row.visualText]), [["r1", "abcdef", "abcXdef"], ["r2", "PQother", "other"]], label);
    assert.deepEqual(hook.read().app, hook.read().peer, label);
    assert.deepEqual(sharedSessionParts().undo.sizes(), { ...before.sizes, undo: before.sizes.undo + 1 }, label);
    assert.equal(document.activeElement, cellOf(field), label);
    return true;
  }
  assert.deepEqual(warningCalls, [], label);
  const app = hook.read().app, made = app.rows.map(row => row.id).filter(id => id !== "r1" && id !== "r2");
  assert.equal(made.length, 1, label);
  assert.deepEqual(app.rows.map(row => [made.includes(row.id) ? "new" : row.id, row.audioText, row.visualText]), servedRows(command, field, state), label);
  assert.deepEqual(app, hook.read().peer, label);
  assert.notDeepEqual(encodeSharedState(sharedSessionParts().handle), before.encoded, label);
  assert.deepEqual(sharedSessionParts().undo.sizes(), { ...before.sizes, undo: before.sizes.undo + (state === "pending" ? 2 : 1) }, label);
  assert.equal(document.activeElement, cellOf(command === "split" ? "audioText" : field, made[0]), label);
  return true;
}
for (const field of ["audioText", "visualText"]) for (const order of ["forward", "reverse"]) {
  test(`rule 55 refusal table: ${field}, encoded delivery ${order}, every unserved route and cell state`, async t => {
    let rows = 0, served = 0;
    for (const route of ROUTES) for (const state of ["caret", "selection", "pending", "composition"]) {
      if (route.mention && field === "audioText") continue;
      for (const elsewhere of route.type === "drop" ? [false, true] : [false]) {
        await enter(order, route.mention);
        const cell = cellOf(field), target = elsewhere ? cellOf(field, "r2") : cell;
        try {
          select(cell, 3);
          if (route.mention) {
            select(cell, 1);
            currentWhoList().maybeOpen({ inputType: "insertText", data: "@" }, cell);
            assert.equal(currentWhoList().isOpen(cell), true);
          }
          select(cell, state === "selection" ? 2 : 3, state === "selection" ? 4 : 3);
          if (state === "pending" || state === "composition") pending(cell, state === "composition");
          const before = snapshot(cell), access = [];
          const data = { files: [], types: ["text/plain"], getData: format => { access.push(format); return format === "text/plain" ? "pasted" : ""; },
            setData: (...args) => { access.push(args); } };
          const e = route.type === "keydown" ? new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: route.key, ...route.modifiers })
            : route.type === "beforeinput" ? new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: route.inputType, data: null })
              : new window.Event(route.type, { bubbles: true, cancelable: true });
          if (route.type === "drop") Object.defineProperty(e, "dataTransfer", { value: data });
          if (route.type === "paste" || route.type === "cut") Object.defineProperty(e, "clipboardData", { value: data });
          warningCalls.length = 0; errors.length = 0; calls.length = 0;
          watching = true;
          assert.doesNotThrow(() => { target.dispatchEvent(e); });
          await tick(); watching = false;
          const label = `${route.name}/${state}/other=${elsewhere}`;
          assert.deepEqual([errors, calls, access], [[], [], []], label);
          if (servedRow(route, field, state, before, e, label)) { rows++; served++; continue; }
          assert.equal(e.defaultPrevented, true, label);
          assert.deepEqual(warningCalls, [["This is not available in a shared session yet.", "warn"]], label);
          assert.deepEqual(hook.read(), before.doc, label);
          assert.deepEqual(encodeSharedState(sharedSessionParts().handle), before.encoded, label);
          assert.deepEqual(hook.peer.appliedUpdates(), before.updates, label);
          assert.equal(cell.innerHTML, before.html, label);
          assert.equal(document.activeElement, before.active, label);
          assert.equal(document.getSelection().anchorNode, before.anchor, label);
          assert.equal(document.getSelection().focusNode, before.head, label);
          assert.deepEqual([document.getSelection().anchorOffset, document.getSelection().focusOffset], before.offsets, label);
          rows++;
        } finally {
          watching = false; currentWhoList().cancel();
          if (state === "composition") cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
          assert.deepEqual(hook.leave(), { ok: true });
        }
      }
    }
    assert.deepEqual([rows, served], field === "audioText" ? [104, 6] : [108, 4]);
    t.diagnostic((rows - served) + " refusal rows and " + served + " served rows; standalone undo is instrumented on every event");
  });
}
for (const field of ["audioText", "visualText"]) for (const order of ["forward", "reverse"]) {
  test(`rule 29 drained removal: ${field}, ${order}, one recovery entry and one announcement`, async () => {
    await enter(order);
    const cell = cellOf(field); select(cell, 3); pending(cell, true);
    hook.peer.hold(); hook.peer.remove("r1"); hook.peer.type("r2", 0, "Z"); hook.peer.release(order);
    assert.equal(currentDocument().rows[0].id, "r1");
    hook.peer.hold();
    warningCalls.length = 0;
    const count = hook.counters().recovered;
    try {
      cell.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, data: "X" }));
      cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "X", isComposing: true }));
      cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "X" }));
      await tick(); assert.equal(hook.peer.deliver("duplicate"), 1);
      assert.equal(hook.counters().recovered, count + 1);
      assert.deepEqual(warningCalls, [["Your writing was kept in recovery.", "warn"]]);
      assert.deepEqual(hook.read().app, hook.read().peer);
      assert.deepEqual(hook.read().app.rows.map(row => [row.id, row.audioText, row.visualText]), [["r2", "ZPQother", "other"]]);
      const kept = hook.recovery();
      assert.deepEqual(kept.app, kept.peer);
      assert.equal(kept.app.length, 1);
      assert.equal(kept.app[0].kind, "removed-beat");
      assert.deepEqual([kept.app[0].row.id, kept.app[0].row.audioText, kept.app[0].row.visualText],
        ["r1", field === "audioText" ? "abcXdef" : "abcdef", field === "visualText" ? "abcXdef" : "abcdef"]);
      const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: fromHtml });
      try {
        assert.equal(applySharedUpdate(late, encodeSharedState(sharedSessionParts().handle)).ok, true);
        assertReplicasAgree("drained removal recovery", [{ order, replica: "A", output: kept.app }, { order, replica: "B", output: kept.peer },
          { order: "late-C", replica: "C", output: projectSharedDocumentWithRecovery(late).recovery }]);
      } finally { destroySharedDocument(late); }
      hook.peer.deliver("duplicate");
      assert.equal(hook.counters().recovered, count + 1);
      assert.equal(warningCalls.length, 1);
    } finally { assert.deepEqual(hook.leave(), { ok: true }); }
  });
}
test("Split legacy event and undo inventories require a new native route to be classified", () => {
  const editor = readFileSync(new URL("../bootstrap/wiring/editor.ts", import.meta.url), "utf8");
  const root = editor.slice(editor.indexOf("export function onRootKeydown"));
  assert.deepEqual([...new Set([...root.matchAll(/e\.key === "([^"]+)"/g)].map(match => match[1]))].sort(),
    ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]);
  const methods = [...editor.matchAll(/undoOwner\(\)\.(\w+)\(/g)].map(match => match[1]);
  assert.deepEqual(methods, ["flush", "last", "redo", "undo", "last", "settleAfterApply", "compositionMark", "dropEmptySince", "last", "last", "last", "last"]);
});
