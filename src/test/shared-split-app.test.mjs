import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sharedSplitBindings } from "../bootstrap/wiring/shared-split.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveSharedSession, sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { posToDom, domToPos } from "../features/common/cell-dom.ts";
import { toggleCellFormat, screenIsStale, render } from "../features/rows/render.ts";
import { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { projectSharedDocument } from "../adapters/collab/project.ts";
import { registerSharedOperationFamilies } from "../adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../adapters/collab/execute.ts";
import { readSharedPaintedText } from "../adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../adapters/collab/buffer.ts";
import { bufferedFieldKey } from "../core/collab/buffer.ts";
import { readOperation } from "../core/collab/read-operation.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCellSpaceForm } from "../bootstrap/wiring/ports/shared-cell-space.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const reports = [], recovered = [], missing = [], errors = [];
const warningCalls = [], actualNotice = notices.show;
notices.show = (...args) => { warningCalls.push(args); return actualNotice(...args); };
after(() => { notices.show = actualNotice; });
const refusedWarning = ["This is not available in a shared session yet.", "warn"];
const legacyCompositionCalls = [], legacyUndo = undoOwner(), legacyCompositionMark = legacyUndo.compositionMark;
legacyUndo.compositionMark = (...args) => { legacyCompositionCalls.push(args); return legacyCompositionMark(...args); };
after(() => { legacyUndo.compositionMark = legacyCompositionMark; });
const allowed = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
let serial = 0, operationSerial = 0;
const ports = {
  refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
  bindings: sharedSplitBindings({ report: value => { reports.push(value); }, missingBase: key => { missing.push(key); }, recovered: key => { recovered.push(key); } }),
  common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
  docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice", structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); }, timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
};
const cellOf = (field, rowId = "r1") => {
  const cell = document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
  assert.ok(cell); return cell;
};
function select(cell, from, to = from) {
  cell.focus();
  const anchor = posToDom(cell, from), head = posToDom(cell, to);
  document.getSelection().setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
}
function points(cell) {
  const selection = document.getSelection();
  return [domToPos(cell, selection.anchorNode, selection.anchorOffset), domToPos(cell, selection.focusNode, selection.focusOffset)];
}
function type(cell, character, nativeCharacter = character) {
  const key = type => cell.dispatchEvent(new window.KeyboardEvent(type, { key: character, bubbles: true, cancelable: true }));
  if (!key("keydown")) return false;
  key("keypress");
  const range = document.getSelection().getRangeAt(0).cloneRange();
  const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: character, bubbles: true, cancelable: true });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  if (!cell.dispatchEvent(before)) { key("keyup"); return false; }
  range.deleteContents();
  const text = document.createTextNode(nativeCharacter); range.insertNode(text);
  document.getSelection().setBaseAndExtent(text, nativeCharacter.length, text, nativeCharacter.length);
  cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: character, bubbles: true }));
  key("keyup"); return true;
}
function history(cell, key) {
  const handled = !cell.dispatchEvent(new window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
  cell.dispatchEvent(new window.KeyboardEvent("keyup", { key, ctrlKey: true, bubbles: true }));
  return handled;
}
function composing(cell, offset, text) {
  select(cell, offset);
  const composition = (type, data) => cell.dispatchEvent(new window.CompositionEvent(type, { bubbles: true, cancelable: true, data }));
  composition("compositionstart", "");
  let length = 0;
  const update = text => {
    select(cell, offset, offset + length);
    composition("compositionupdate", text);
    const range = document.getSelection().getRangeAt(0).cloneRange();
    const before = new window.InputEvent("beforeinput", { inputType: "insertCompositionText", data: text, isComposing: true, bubbles: true });
    Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
    cell.dispatchEvent(before);
    range.deleteContents(); range.insertNode(document.createTextNode(text)); length = text.length;
    select(cell, offset + length);
    cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: text || null, isComposing: true, bubbles: true }));
  };
  update(text);
  return { commit: text => { update(text); composition("compositionend", text); } };
}
async function enter(audio = "abcdef", visual = "abcdef") {
  reports.length = 0; recovered.length = 0; missing.length = 0; errors.length = 0;
  warningCalls.length = 0;
  legacyCompositionCalls.length = 0;
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ schema: 2, title: "Shared Split", paragraphsDecided: true, rows: [
    { id: "r1", audioText: audio, visualText: visual, status: "todo" }, { id: "r2", audioText: "Other", visualText: "Wide", status: "todo" }
  ] }));
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts(); assert.ok(parts); assert.equal(screenIsStale(), false);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  return { parts, peer, close: () => { destroySharedDocument(peer); assert.deepEqual(leaveSharedSession(ports), { ok: true }); } };
}
function remoteInsert(handle, field, offset, text) {
  const target = sharedBufferedTarget(handle, bufferedFieldKey("r1", field)), painted = readSharedPaintedText(handle, target);
  assert.ok(painted);
  const op = readOperation({ kind: "text-insert", id: "bob_" + ++operationSerial, by: "Bob", target,
    at: { left: offset === painted.text.length ? painted.endGap : null, right: painted.identity(offset), affinity: offset === painted.text.length ? "after" : "before" },
    content: [{ value: text, marks: [] }] });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
function agree(fixture, expected, expectedWarnings = []) {
  assert.equal(applySharedUpdate(fixture.peer, encodeSharedState(fixture.parts.handle)).ok, true);
  const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: html => fromHtml(html) });
  try {
    assert.equal(applySharedUpdate(late, encodeSharedState(fixture.parts.handle)).ok, true);
    assertReplicasAgree("composed Split document", [
      { order: "D1", replica: "A", output: currentDocument() }, { order: "D1", replica: "B", output: projectSharedDocument(fixture.peer) },
      { order: "late-C", replica: "C", output: projectSharedDocument(late) }
    ]);
    assert.deepEqual(currentDocument().rows.map(row => [row.id, row.audioText, row.visualText]), expected);
    assert.deepEqual([reports, recovered, missing, errors], [[], [], [], []]);
    assert.deepEqual(warningCalls, expectedWarnings);
    assert.deepEqual(legacyCompositionCalls, []);
  } finally { destroySharedDocument(late); }
}

for (const field of ["audioText", "visualText"]) test(`C7 composed ${field}: native typing, encoded peer updates and shared undo use one owner`, async () => {
  const f = await enter();
  try {
    const cell = cellOf(field); select(cell, 3);
    assert.equal(type(cell, "x"), true);
    assert.equal(currentDocument().rows[0][field], "abcxdef");
    assert.deepEqual(f.parts.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    assert.equal(applySharedUpdate(f.peer, encodeSharedState(f.parts.handle)).ok, true);
    remoteInsert(f.peer, field, 0, "Z");
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    assert.equal(history(cellOf(field), "z"), true);
    agree(f, [["r1", field === "audioText" ? "Zabcdef" : "abcdef", field === "visualText" ? "Zabcdef" : "abcdef"], ["r2", "Other", "Wide"]]);
    assert.deepEqual(f.parts.undo.sizes(), { undo: 0, redo: 1, dropped: 0 });
    assert.equal(history(cellOf(field), "y"), true);
    agree(f, [["r1", field === "audioText" ? "Zabcxdef" : "abcdef", field === "visualText" ? "Zabcxdef" : "abcdef"], ["r2", "Other", "Wide"]]);
    assert.deepEqual(f.parts.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    assert.equal(history(cellOf(field), "z"), true);
  } finally { f.close(); }
  assert.equal(sharedSession(), false);
  const originalTrack = undoOwner().track;
  let coldTracks = 0;
  undoOwner().track = (...args) => { coldTracks++; return originalTrack(...args); };
  try { render(); assert.equal(coldTracks, 1); } finally { undoOwner().track = originalTrack; }
  const cold = cellOf(field); select(cold, 7);
  assert.equal(type(cold, "y"), true);
  assert.equal(currentDocument().rows[0][field], "Zabcdefy");
  select(cold, 0); toggleCellFormat(cold, "bold");
  assert.equal(type(cold, "b"), false);
  assert.equal(currentDocument().rows[0][field], "<strong>b</strong>Zabcdefy");
});

for (const field of ["audioText", "visualText"]) test(`C7 D18 composed ${field}: idle caret follows its character across two encoded repaints`, async () => {
  const f = await enter("aaaaaa", "aaaaaa");
  try {
    select(cellOf(field), 3);
    remoteInsert(f.peer, field, 0, "a"); assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    assert.deepEqual(points(cellOf(field)), [4, 4]);
    remoteInsert(f.peer, field, 0, "a"); assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    assert.deepEqual(points(cellOf(field)), [5, 5]);
    assert.equal(type(cellOf(field), "z"), true);
    agree(f, [["r1", field === "audioText" ? "aaaaazaaa" : "aaaaaa", field === "visualText" ? "aaaaazaaa" : "aaaaaa"], ["r2", "Other", "Wide"]]);
  } finally { f.close(); }
});

for (const field of ["audioText", "visualText"]) test(`C7 D16 composed ${field}: a chosen typing format does not intercept the shared native key`, async () => {
  const f = await enter();
  try {
    const cell = cellOf(field); select(cell, 3); toggleCellFormat(cell, "bold");
    assert.equal(type(cell, "x"), true);
    agree(f, [["r1", field === "audioText" ? "abcxdef" : "abcdef", field === "visualText" ? "abcxdef" : "abcdef"], ["r2", "Other", "Wide"]]);
    assert.deepEqual(f.parts.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  } finally { f.close(); }
});

test("C7 D16 D18: native typing at the stage direction's closing edge continues that direction", async () => {
  const f = await enter('<span class="stage-dir">(beat)</span>word');
  try {
    const cell = cellOf("audioText"), node = cell.querySelector(".stage-dir").lastChild;
    cell.focus(); document.getSelection().setBaseAndExtent(node, 6, node, 6);
    assert.equal(type(cell, "x"), true);
    agree(f, [["r1", '<span class="stage-dir">(beat)x</span>word', "abcdef"], ["r2", "Other", "Wide"]]);
  } finally { f.close(); }
});

for (const field of ["audioText", "visualText"]) test(`C7 lifecycle ${field}: refused finish and dispose keep the composition and its held encoded update alive`, async () => {
  const f = await enter();
  let ime = null;
  try {
    const cell = cellOf(field); ime = composing(cell, 3, "か");
    assert.equal(currentDocument().rows[0][field], "abcdef");
    remoteInsert(f.peer, field, 0, "Q");
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    assert.equal(currentDocument().rows[0][field], "abcdef");
    assert.equal(cell.textContent, "abcかdef");
    assert.deepEqual(leaveSharedSession(ports), { ok: false, reason: "buffer-composition" });
    assert.throws(() => ports.bindings.leave(), /buffer-composition/);
    ports.bindings.enter(f.parts);
    assert.equal(sharedSessionParts(), f.parts);
    assert.equal(sharedCellSpaceForm(cell), "abcdef");
    assert.deepEqual(f.parts.undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
    ime.commit("かな"); ime = null;
    agree(f, [["r1", field === "audioText" ? "Qabcかなdef" : "abcdef", field === "visualText" ? "Qabcかなdef" : "abcdef"], ["r2", "Other", "Wide"]], [refusedWarning, refusedWarning]);
    assert.deepEqual(points(cellOf(field)), [6, 6]);
    assert.deepEqual(f.parts.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  } finally { ime?.commit(""); f.close(); }
  assert.equal(sharedCellSpaceForm(cellOf(field)), null);
  assert.equal(document.querySelector("[data-shared-cell-space-form], [data-shared-cell-space]"), null);
});

for (const kind of ["paste", "cut", "drop"]) test(`C7 rule 55 R5: a composed ${kind} refusal keeps native text and warns once without standalone clipboard work`, async () => {
  const f = await enter(), warnings = [], originalShow = notices.show;
  let ime = null;
  notices.show = (...args) => { warnings.push(args); return originalShow(...args); };
  try {
    const cell = cellOf("audioText"); ime = composing(cell, 3, "か");
    const accesses = [], event = new window.Event(kind, { bubbles: true, cancelable: true });
    const data = { files: [], getData: format => { accesses.push("get:" + format); return "Other"; }, setData: format => { accesses.push("set:" + format); } };
    Object.defineProperty(event, kind === "drop" ? "dataTransfer" : "clipboardData", { value: data });
    assert.equal(cell.dispatchEvent(event), false);
    assert.deepEqual(accesses, []);
    assert.equal(cell.textContent, "abcかdef");
    assert.equal(currentDocument().rows[0].audioText, "abcdef");
    assert.deepEqual(f.parts.undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
    assert.deepEqual(warnings, [["This is not available in a shared session yet.", "warn"]]);
    ime.commit("か"); ime = null;
    agree(f, [["r1", "abcかdef", "abcdef"], ["r2", "Other", "Wide"]], [refusedWarning]);
  } finally { notices.show = originalShow; ime?.commit(""); f.close(); }
});

test("C7 lifecycle: a beforeinput awaiting input refuses leave, the next native key settles it, and re-entry binds once", async () => {
  for (let cycle = 0; cycle < 2; cycle++) {
    const f = await enter();
    try {
      const cell = cellOf("audioText"); select(cell, 3);
      cell.dispatchEvent(new window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
      cell.dispatchEvent(new window.KeyboardEvent("keypress", { key: "x", bubbles: true, cancelable: true }));
      const range = document.getSelection().getRangeAt(0).cloneRange();
      const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true });
      Object.defineProperty(before, "getTargetRanges", { value: () => [range] });
      assert.equal(cell.dispatchEvent(before), true);
      cell.dispatchEvent(new window.KeyboardEvent("keyup", { key: "x", bubbles: true }));
      assert.deepEqual(leaveSharedSession(ports), { ok: false, reason: "buffer-pending" });
      assert.equal(type(cell, "y"), true);
      agree(f, [["r1", "abcydef", "abcdef"], ["r2", "Other", "Wide"]], [refusedWarning]);
      assert.deepEqual(f.parts.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    } finally { f.close(); }
  }
});

for (const field of ["audioText", "visualText"]) test(`C7 composed ${field}: a native terminal space and blur never call standalone text synchronization`, async () => {
  const f = await enter("Word", "Word");
  try {
    const cell = cellOf(field); select(cell, 4);
    assert.equal(type(cell, " ", "\u00a0"), true);
    assert.equal(cell.textContent, "Word\u00a0");
    assert.equal(currentDocument().rows[0][field], "Word ");
    cell.blur();
    agree(f, [["r1", field === "audioText" ? "Word " : "Word", field === "visualText" ? "Word " : "Word"], ["r2", "Other", "Wide"]]);
    assert.deepEqual(f.parts.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  } finally { f.close(); }
});

test("C7 lifecycle: failed entry releases the real binding and restores the kept standalone document and handlers", async () => {
  reports.length = 0; errors.length = 0; warningCalls.length = 0;
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ schema: 2, title: "Failed entry", rows: [{ id: "r1", audioText: "Word ", visualText: "Wide " }] }));
  const kept = currentDocument(), previousDetach = ports.detach, failure = new Error("File detach failed");
  let sawMounted = false;
  ports.detach = () => {
    sawMounted = sharedCellSpaceForm(cellOf("audioText")) === "Word " && !!document.querySelector("[data-shared-cell-space]");
    throw failure;
  };
  try { assert.deepEqual(await enterSharedSession(ports), { ok: false, reason: "enter-failed" }); }
  finally { ports.detach = previousDetach; }
  assert.equal(sawMounted, true);
  assert.deepEqual(errors, [failure]);
  assert.equal(sharedSession(), false);
  assert.equal(sharedSessionParts(), null);
  assert.deepEqual(currentDocument(), kept);
  assert.equal(sharedCellSpaceForm(cellOf("audioText")), null);
  assert.equal(document.querySelector("[data-shared-cell-space-form], [data-shared-cell-space]"), null);
  const cell = cellOf("audioText"); select(cell, 4);
  assert.equal(type(cell, "x"), true);
  assert.equal(currentDocument().rows[0].audioText, "Wordx ");
  assert.equal(screenIsStale(), false);
  assert.deepEqual(reports, []);
});

for (const field of ["audioText", "visualText"]) test(`C7 lifecycle ${field}: successful leave restores standalone composition ownership`, async () => {
  const f = await enter("Word", "Word");
  f.close();
  legacyCompositionCalls.length = 0;
  const cell = cellOf(field), ime = composing(cell, 0, "か");
  ime.commit("かな");
  assert.equal(currentDocument().rows[0][field], "かなWord");
  assert.equal(legacyCompositionCalls.length, 1);
  assert.equal(sharedSession(), false);
  assert.equal(sharedCellSpaceForm(cell), null);
});

test("C7 rule 73: a structure caller without its shared port still refuses visibly once", async () => {
  const f = await enter();
  try {
    const cell = cellOf("audioText"); select(cell, 3);
    const event = new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    assert.equal(cell.dispatchEvent(event), false);
    cell.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Enter", ctrlKey: true, bubbles: true }));
    agree(f, [["r1", "abcdef", "abcdef"], ["r2", "Other", "Wide"]], [refusedWarning]);
    assert.deepEqual(points(cellOf("audioText")), [3, 3]);
    assert.deepEqual(f.parts.undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
  } finally { f.close(); }
});
