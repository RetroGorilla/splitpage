import { bootApp, closeApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sharedSplitBindings } from "../bootstrap/wiring/shared-split.ts";
import { adoptReplacement, currentDocument, onSessionChange } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveSharedSession, sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { openingStatus } from "../bootstrap/wiring/ports/transitions.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { splitRowFieldCore } from "../bootstrap/wiring/rows.ts";
import { pasteBeatsAt, selectBeats } from "../features/clipboard/beat-select.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { posToDom, domToPos } from "../features/common/cell-dom.ts";
import { screenIsStale } from "../features/rows/render.ts";
import { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { projectSharedDocument } from "../adapters/collab/project.ts";
import { registerSharedOperationFamilies } from "../adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../adapters/collab/execute.ts";
import { readSharedPaintedText } from "../adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../adapters/collab/buffer.ts";
import { captureSharedTextRange } from "../adapters/collab/executor-references.ts";
import { collabState } from "../adapters/collab/state.ts";
import { bufferedFieldKey } from "../core/collab/buffer.ts";
import { readOperation } from "../core/collab/read-operation.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

export const reports = [], errors = [], noticeCalls = [], actualShow = notices.show;
notices.show = (...args) => { noticeCalls.push(args); return actualShow(...args); };
after(() => { notices.show = actualShow; });
export const toastHost = () => { const host = document.getElementById("toast-host"); assert.ok(host); return host; };
export const warnings = () => [...toastHost().querySelectorAll(".toast.warn")].map(el => el.firstChild.textContent);
export const clearWarnings = () => { toastHost().replaceChildren(); };
export const REFUSED = "This is not available in a shared session yet.";
let editRefusal = null;
export const setEditRefusal = reason => { editRefusal = reason; };
const allowed = { edit: () => editRefusal ? { allowed: false, reason: editRefusal } : { allowed: true }, comment: () => ({ allowed: true }) };
let serial = 0, remoteSerial = 0;
export const ports = {
  opening: openingStatus,
  refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
  bindings: sharedSplitBindings({ report: value => { reports.push(value); }, missingBase: () => {}, recovered: () => {} }),
  common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
  docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice", structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); }, timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
};
export const ORDERS = ["local-first", "remote-first"];
export const SOURCE = { schema: 2, title: "Shared callers", paragraphsDecided: true, wordsPerMinute: 150, rows: [
  { id: "r1", audioText: "abcdef", visualText: "Wide", status: "todo" }, { id: "r2", audioText: "Other", visualText: "", status: "todo" },
  { id: "r3", audioText: "Third", visualText: "", status: "todo" }
], sections: [{ id: "s1", name: "Scene", firstSceneId: "r3" }] };

export const cellOf = (field, rowId = "r1") => {
  const cell = document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
  assert.ok(cell, rowId + " " + field); return cell;
};
export function select(cell, from, to = from) {
  cell.focus();
  const anchor = posToDom(cell, from), head = posToDom(cell, to);
  document.getSelection().setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
}
export function caret() {
  const selection = document.getSelection(), cell = selection.anchorNode?.parentElement?.closest(".cell-editable") ?? selection.anchorNode?.closest?.(".cell-editable");
  return cell ? [cell.getAttribute("data-id"), cell.getAttribute("data-field"), domToPos(cell, selection.anchorNode, selection.anchorOffset)] : null;
}
export function press(target, key, modifiers = {}) {
  const handled = !target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
  target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true, ...modifiers }));
  return handled;
}
export async function enter(source = SOURCE) {
  reports.length = 0; errors.length = 0; clearWarnings();
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(source)));
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts(); assert.ok(parts); assert.equal(screenIsStale(), false);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  const beat = new RegExp("^structure_" + collabState(parts.handle).doc.clientID + "_[0-9a-f]+_beat_0$");
  return { parts, peer, beat, close: () => { destroySharedDocument(peer); assert.deepEqual(leaveSharedSession(ports), { ok: true }); } };
}
export function remoteInsert(handle, rowId, field, offset, text) {
  const target = sharedBufferedTarget(handle, bufferedFieldKey(rowId, field)), painted = readSharedPaintedText(handle, target);
  assert.ok(painted);
  const op = readOperation({ kind: "text-insert", id: "bob_" + ++remoteSerial, by: "Bob", target,
    at: { left: offset === painted.text.length ? painted.endGap : null, right: painted.identity(offset), affinity: offset === painted.text.length ? "after" : "before" },
    content: [{ value: text, marks: [] }] });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
export function remoteErase(handle, rowId, from, to) {
  const target = sharedBufferedTarget(handle, bufferedFieldKey(rowId, "audioText")), observed = captureSharedTextRange(handle, target, from, to);
  assert.ok(observed);
  const op = readOperation({ kind: "text-delete", id: "bob_" + ++remoteSerial, by: "Bob", target, observed: [observed] });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
export function remoteCreate(handle, left, right, affinity) {
  const name = "bob_" + ++remoteSerial;
  const op = readOperation({ kind: "segment-create", id: name, by: "Bob", segment: name + "_segment", beat: name + "_beat",
    at: { left, right, affinity },
    fields: { audioText: "", visualText: "", imageRef: null, status: "todo", stamp: { at: "2026-11-14T00:00:00.000Z", by: "Bob" } } });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
export function remoteSplit(handle, rowId, offset) {
  const name = "bob_" + ++remoteSerial, target = sharedBufferedTarget(handle, bufferedFieldKey(rowId, "audioText")), painted = readSharedPaintedText(handle, target);
  assert.ok(painted);
  const op = readOperation({ kind: "split", id: name, by: "Bob", target, at: { left: null, right: painted.identity(offset), affinity: "before" },
    observed: Array.from({ length: painted.text.length }, (_, index) => painted.identity(index)), boundary: name + "_boundary", beat: name + "_beat",
    fields: { visualText: "", imageRef: null, status: "todo", stamp: { at: "2026-11-14T00:00:00.000Z", by: "Bob" } } });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
export function deliverInsideNextPublication(f) {
  let armed = true;
  const stop = onSessionChange(() => {
    if (!armed) return;
    armed = false;
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
  });
  return () => { stop(); assert.equal(armed, false, "the peer update was delivered inside the local command"); };
}
export function type(cell, character) {
  const key = type => cell.dispatchEvent(new window.KeyboardEvent(type, { key: character, bubbles: true, cancelable: true }));
  if (!key("keydown")) return false;
  key("keypress");
  const range = document.getSelection().getRangeAt(0).cloneRange();
  const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: character, bubbles: true, cancelable: true });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  if (!cell.dispatchEvent(before)) { key("keyup"); return false; }
  range.deleteContents();
  const text = document.createTextNode(character); range.insertNode(text);
  document.getSelection().setBaseAndExtent(text, character.length, text, character.length);
  cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: character, bubbles: true }));
  key("keyup"); return true;
}
export function exchange(f, order) {
  const toPeer = () => { assert.equal(applySharedUpdate(f.peer, encodeSharedState(f.parts.handle)).ok, true); };
  const toLocal = () => { assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true); };
  if (order === "local-first") { toPeer(); toLocal(); } else { toLocal(); toPeer(); }
}
export function shape(doc) {
  return { rows: doc.rows.map(row => [row.id, row.audioText, row.visualText, row.status, row.lengthSeconds ?? null]),
    sections: (doc.sections ?? []).map(scene => [scene.id, scene.firstSceneId]), target: doc.targetSeconds ?? null, wpm: doc.wordsPerMinute };
}
export function agree(f, expected, view = shape) {
  const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: html => fromHtml(html) });
  try {
    assert.equal(applySharedUpdate(late, encodeSharedState(f.parts.handle)).ok, true);
    assertReplicasAgree("composed Split callers", [
      { order: "D1", replica: "A", output: currentDocument() }, { order: "D1", replica: "B", output: projectSharedDocument(f.peer) },
      { order: "late-C", replica: "C", output: projectSharedDocument(late) }
    ]);
    assert.deepEqual(view(currentDocument(), f), expected);
    assert.deepEqual([reports, errors], [[], []]);
  } finally { destroySharedDocument(late); }
}
export const row = (id, audio, visual = "", status = "todo", length = null) => [id, audio, visual, status, length];
export const START = (r1 = row("r1", "abcdef", "ZWide")) => [r1, row("r2", "Other"), row("r3", "Third")];
export const base = (rows = START(), extra = {}) => ({ rows, sections: [["s1", "r3"]], target: null, wpm: 150, ...extra });
export function undoOnce(f, order) {
  assert.equal(press(cellOf("audioText", "r3"), "z", { ctrlKey: true }), true);
  exchange(f, order);
}
export function redoOnce(f, order) {
  assert.equal(press(cellOf("audioText", "r3"), "z", { ctrlKey: true, shiftKey: true }), true);
  exchange(f, order);
}
export function minted(f) {
  const ids = currentDocument().rows.map(r => r.id).filter(id => !["r1", "r2", "r3"].includes(id));
  assert.equal(ids.length, 1); assert.match(ids[0], f.beat);
  return ids[0];
}

export function copiedBeat(rowId) {
  selectBeats(rowId, rowId);
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const data = new Map(), copy = new window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(copy, "clipboardData", { value: { setData: (type, value) => { data.set(type, value); }, getData: type => data.get(type) ?? "" } });
  document.body.dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, true);
  return { getData: type => data.get(type) ?? "" };
}

export function cutBeat(rowId) {
  selectBeats(rowId, rowId);
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const cut = new window.Event("cut", { bubbles: true, cancelable: true });
  Object.defineProperty(cut, "clipboardData", { value: { setData: () => {}, getData: () => "" } });
  document.body.dispatchEvent(cut);
}

export function pendingTyping(cell, at) {
  select(cell, at);
  const range = document.getSelection().getRangeAt(0).cloneRange();
  const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "X" });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  assert.equal(cell.dispatchEvent(before), true);
  const text = document.createTextNode("X"); range.insertNode(text);
  document.getSelection().setBaseAndExtent(text, 1, text, 1);
  assert.equal(collabState(sharedSessionParts().handle).ingress.holds.has("buffer"), true, "the typing is pending");
}

export const MERGED = {
  before: { before: "ZaXbcdefgh", inside: "aXbcZdefgh", after: "aXbcdefghZ" },
  inside: { before: "ZabcdXefgh", inside: "abcZdXefgh", after: "abcdXefghZ" },
  after: { before: "ZabcdefgXh", inside: "abcZdefgXh", after: "abcdefgXhZ" }
};

export const CUT = {
  before: { before: ["ZaXb", "gh"], inside: ["aXb", "Zgh"], after: ["aXb", "ghZ"] },
  inside: { before: ["Zab", "gh"], inside: ["ab", "Zgh"], after: ["ab", "ghZ"] },
  after: { before: ["Zab", "gXh"], inside: ["ab", "ZgXh"], after: ["ab", "gXhZ"] }
};
export const UNSPLIT = text => base([row("r1", text, "Wide"), row("r2", "Other"), row("r3", "Third")]);
export const PENDING_CALLERS = [
  { name: "Alt+Enter", act: cell => { assert.equal(press(cell, "Enter", { altKey: true }), true); },
    after: (id, typed, peer) => base([row("r1", CUT[typed][peer][0], "Wide"), row(id, CUT[typed][peer][1]), row("r2", "Other"), row("r3", "Third")]) },
  { name: "the split core", act: (cell, f, data, refused) => {
    const split = splitRowFieldCore(cell);
    if (refused) assert.equal(split ?? null, null); else assert.match(split?.id, f.beat);
  },
    after: (id, typed, peer) => base([row("r1", CUT[typed][peer][0], "Wide"), row(id, CUT[typed][peer][1]), row("r2", "Other"), row("r3", "Third")]) },
  { name: "Ctrl+Enter", act: cell => { assert.equal(press(cell, "Enter", { ctrlKey: true }), true); },
    after: (id, typed, peer) => base([row("r1", MERGED[typed][peer], "Wide"), row(id, ""), row("r2", "Other"), row("r3", "Third")]) },
  { name: "an in-cell beat paste", arrange: () => copiedBeat("r2"), act: (cell, f, data) => { assert.equal(pasteBeatsAt(data, cell), true); },
    refused: true, after: (id, typed, peer) => UNSPLIT(MERGED[typed][peer]) }
];

export function remoteJoin(handle, from, into) {
  const op = readOperation({ kind: "join", id: "bob_" + ++remoteSerial, by: "Bob", from, into, glue: " " });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}

export const tail = rows => [...rows, ["r2", "Other"], ["r3", "Third"]];

export const kinds = (doc, f) => doc.rows.map(r => [f.beat.test(r.id) ? "mine" : /^r\d$/.test(r.id) ? r.id : "bob", r.audioText]);
