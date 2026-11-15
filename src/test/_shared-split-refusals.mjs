import { bootApp, closeApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import { adoptReplacement, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { useDesktopForTest, restoreDesktop } from "../adapters/desktop/desktop-port.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { encodeSharedState } from "../adapters/collab/document.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
useDesktopForTest({ writeDraft: async payload => ({ ok: true, seq: payload.seq }), discardDraft: async () => ({ ok: true }),
  setDocumentState: () => {}, draftRestoreDone: () => {} });
after(() => { restoreDesktop(); closeApp(); });
export const hook = window.__sharedTest, calls = [], errors = [], warningCalls = [];
const notice = notices.show;
notices.show = (...args) => { warningCalls.push(args); return notice(...args); };
after(() => { notices.show = notice; });
const legacy = undoOwner(), methods = new Map();
let watching = false;
export const setWatching = on => { watching = on; };
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
export const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
export const cellOf = (field, id = "r1") => document.querySelector(`#rows .cell-editable[data-id="${id}"][data-field="${field}"]`);
export function select(cell, from, to = from) {
  cell.focus();
  const a = posToDom(cell, from), h = posToDom(cell, to);
  document.getSelection().setBaseAndExtent(a.node, a.offset, h.node, h.offset);
}
export function snapshot(cell) {
  const s = document.getSelection();
  return { doc: hook.read(), encoded: encodeSharedState(sharedSessionParts().handle), updates: hook.peer.appliedUpdates().slice(), sizes: sharedSessionParts().undo.sizes(),
    html: cell.innerHTML, active: document.activeElement,
    anchor: s.anchorNode, head: s.focusNode, offsets: [s.anchorOffset, s.focusOffset] };
}
export async function enter(order, mention = false) {
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
export function pending(cell, composition) {
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
export const ROUTES = [
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
export function servedRow(route, field, state, before, e, label) {
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
