import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sharedSplitBindings } from "../bootstrap/wiring/shared-split.ts";
import { adoptReplacement, currentDocument, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveSharedSession, sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { openingStatus } from "../bootstrap/wiring/ports/transitions.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { addRow, addRowAndFocus, armDelete, splitRowFieldCore } from "../bootstrap/wiring/rows.ts";
import { cycleRowStatus, setBeatFilmed } from "../bootstrap/wiring/beat-status.ts";
import { promptForTarget, promptForWpm } from "../bootstrap/wiring/title-chrome.ts";
import { sharedStructureCommands, sharedValueCommands } from "../bootstrap/wiring/ports/shared-commands.ts";
import { setBeatLength } from "../features/rows/read-time.ts";
import { setTargetLength } from "../features/rundown/target.ts";
import { deleteSelectedBeats, pasteBeatsAt, selectBeats } from "../features/clipboard/beat-select.ts";
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
import { collabState } from "../adapters/collab/state.ts";
import { bufferedFieldKey } from "../core/collab/buffer.ts";
import { readOperation } from "../core/collab/read-operation.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const reports = [], errors = [], noticeCalls = [], actualShow = notices.show;
notices.show = (...args) => { noticeCalls.push(args); return actualShow(...args); };
after(() => { notices.show = actualShow; });
const toastHost = () => { const host = document.getElementById("toast-host"); assert.ok(host); return host; };
const warnings = () => [...toastHost().querySelectorAll(".toast.warn")].map(el => el.firstChild.textContent);
const clearWarnings = () => { toastHost().replaceChildren(); };
const REFUSED = "This is not available in a shared session yet.";
const allowed = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
let serial = 0, remoteSerial = 0;
const ports = {
  opening: openingStatus,
  refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
  bindings: sharedSplitBindings({ report: value => { reports.push(value); }, missingBase: () => {}, recovered: () => {} }),
  common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
  docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice", structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); }, timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
};
const ORDERS = ["local-first", "remote-first"];
const SOURCE = { schema: 2, title: "Shared callers", paragraphsDecided: true, wordsPerMinute: 150, rows: [
  { id: "r1", audioText: "abcdef", visualText: "Wide", status: "todo" }, { id: "r2", audioText: "Other", visualText: "", status: "todo" },
  { id: "r3", audioText: "Third", visualText: "", status: "todo" }
], sections: [{ id: "s1", name: "Scene", firstSceneId: "r3" }] };

const cellOf = (field, rowId = "r1") => {
  const cell = document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
  assert.ok(cell, rowId + " " + field); return cell;
};
function select(cell, from, to = from) {
  cell.focus();
  const anchor = posToDom(cell, from), head = posToDom(cell, to);
  document.getSelection().setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
}
function caret() {
  const selection = document.getSelection(), cell = selection.anchorNode?.parentElement?.closest(".cell-editable") ?? selection.anchorNode?.closest?.(".cell-editable");
  return cell ? [cell.getAttribute("data-id"), cell.getAttribute("data-field"), domToPos(cell, selection.anchorNode, selection.anchorOffset)] : null;
}
function press(target, key, modifiers = {}) {
  const handled = !target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
  target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true, ...modifiers }));
  return handled;
}
async function enter() {
  reports.length = 0; errors.length = 0; clearWarnings();
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts(); assert.ok(parts); assert.equal(screenIsStale(), false);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  const beat = new RegExp("^structure_" + collabState(parts.handle).doc.clientID + "_[0-9a-f]+_beat_0$");
  return { parts, peer, beat, close: () => { destroySharedDocument(peer); assert.deepEqual(leaveSharedSession(ports), { ok: true }); } };
}
function remoteInsert(handle, rowId, field, offset, text) {
  const target = sharedBufferedTarget(handle, bufferedFieldKey(rowId, field)), painted = readSharedPaintedText(handle, target);
  assert.ok(painted);
  const op = readOperation({ kind: "text-insert", id: "bob_" + ++remoteSerial, by: "Bob", target,
    at: { left: offset === painted.text.length ? painted.endGap : null, right: painted.identity(offset), affinity: offset === painted.text.length ? "after" : "before" },
    content: [{ value: text, marks: [] }] });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
function remoteCreate(handle, left, right, affinity) {
  const name = "bob_" + ++remoteSerial;
  const op = readOperation({ kind: "segment-create", id: name, by: "Bob", segment: name + "_segment", beat: name + "_beat",
    at: { left, right, affinity },
    fields: { audioText: "", visualText: "", imageRef: null, status: "todo", stamp: { at: "2026-11-14T00:00:00.000Z", by: "Bob" } } });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
function remoteSplit(handle, rowId, offset) {
  const name = "bob_" + ++remoteSerial, target = sharedBufferedTarget(handle, bufferedFieldKey(rowId, "audioText")), painted = readSharedPaintedText(handle, target);
  assert.ok(painted);
  const op = readOperation({ kind: "split", id: name, by: "Bob", target, at: { left: null, right: painted.identity(offset), affinity: "before" },
    observed: Array.from({ length: painted.text.length }, (_, index) => painted.identity(index)), boundary: name + "_boundary", beat: name + "_beat",
    fields: { visualText: "", imageRef: null, status: "todo", stamp: { at: "2026-11-14T00:00:00.000Z", by: "Bob" } } });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
function deliverInsideNextPublication(f) {
  let armed = true;
  const stop = onSessionChange(() => {
    if (!armed) return;
    armed = false;
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
  });
  return () => { stop(); assert.equal(armed, false, "the peer update was delivered inside the local command"); };
}
function type(cell, character) {
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
function exchange(f, order) {
  const toPeer = () => { assert.equal(applySharedUpdate(f.peer, encodeSharedState(f.parts.handle)).ok, true); };
  const toLocal = () => { assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true); };
  if (order === "local-first") { toPeer(); toLocal(); } else { toLocal(); toPeer(); }
}
function shape(doc) {
  return { rows: doc.rows.map(row => [row.id, row.audioText, row.visualText, row.status, row.lengthSeconds ?? null]),
    sections: (doc.sections ?? []).map(scene => [scene.id, scene.firstSceneId]), target: doc.targetSeconds ?? null, wpm: doc.wordsPerMinute };
}
function agree(f, expected) {
  const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: html => fromHtml(html) });
  try {
    assert.equal(applySharedUpdate(late, encodeSharedState(f.parts.handle)).ok, true);
    assertReplicasAgree("composed Split callers", [
      { order: "D1", replica: "A", output: currentDocument() }, { order: "D1", replica: "B", output: projectSharedDocument(f.peer) },
      { order: "late-C", replica: "C", output: projectSharedDocument(late) }
    ]);
    assert.deepEqual(shape(currentDocument()), expected);
    assert.deepEqual([reports, errors], [[], []]);
  } finally { destroySharedDocument(late); }
}
const row = (id, audio, visual = "", status = "todo", length = null) => [id, audio, visual, status, length];
const START = (r1 = row("r1", "abcdef", "ZWide")) => [r1, row("r2", "Other"), row("r3", "Third")];
const base = (rows = START(), extra = {}) => ({ rows, sections: [["s1", "r3"]], target: null, wpm: 150, ...extra });
function undoOnce(f, order) {
  assert.equal(press(cellOf("audioText", "r3"), "z", { ctrlKey: true }), true);
  exchange(f, order);
}
function minted(f) {
  const ids = currentDocument().rows.map(r => r.id).filter(id => !["r1", "r2", "r3"].includes(id));
  assert.equal(ids.length, 1); assert.match(ids[0], f.beat);
  return ids[0];
}

const served = [
  { name: "Ctrl+Enter adds a beat and focuses the minted beat", act: () => {
    select(cellOf("audioText"), 3);
    assert.equal(press(cellOf("audioText"), "Enter", { ctrlKey: true }), true);
  }, after: id => base([row("r1", "abcdef", "ZWide"), row(id, ""), row("r2", "Other"), row("r3", "Third")]),
  caret: id => [id, "audioText", 0], undone: null },
  { name: "the add bar adds a beat at the end and returns the minted id", act: f => {
    const id = addRow(null);
    assert.match(id, f.beat);
    return id;
  }, after: id => base([...START(), row(id, "")]), undone: null },
  { name: "Alt+Enter splits the narration at the caret and focuses the minted beat", act: () => {
    select(cellOf("audioText"), 3);
    assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
  }, after: id => base([row("r1", "abc", "ZWide"), row(id, "def"), row("r2", "Other"), row("r3", "Third")]),
  caret: id => [id, "audioText", 0], undone: base() },
  { name: "Alt+Enter over selected narration splits and removes the selection in one change", act: () => {
    select(cellOf("audioText"), 2, 4);
    assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
  }, after: id => base([row("r1", "ab", "ZWide"), row(id, "ef"), row("r2", "Other"), row("r3", "Third")]),
  caret: id => [id, "audioText", 0], undone: base() },
  { name: "the split core returns the minted id", act: f => {
    select(cellOf("audioText"), 1);
    const split = splitRowFieldCore(cellOf("audioText"));
    assert.equal(split?.field, "audioText"); assert.match(split?.id, f.beat);
    return split.id;
  }, after: id => base([row("r1", "a", "ZWide"), row(id, "bcdef"), row("r2", "Other"), row("r3", "Third")]), undone: base() },
  { name: "the delete button removes a beat", act: () => {
    const button = document.createElement("button");
    armDelete(button, "r2"); armDelete(button, "r2");
  }, after: () => base([row("r1", "abcdef", "ZWide"), row("r3", "Third")]), undone: base() },
  { name: "deleting selected beats removes them", act: () => {
    selectBeats("r2", "r2"); assert.doesNotThrow(deleteSelectedBeats);
    assert.deepEqual([...toastHost().querySelectorAll(".toast")].map(el => [el.firstChild.textContent, el.querySelector(".toast-action")]),
      [["1 beat deleted.", null]]);
  }, after: () => base([row("r1", "abcdef", "ZWide"), row("r3", "Third")]), undone: base() },
  { name: "cutting selected beats removes them", act: () => {
    selectBeats("r2", "r2");
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const data = new Map(), cut = new window.Event("cut", { bubbles: true, cancelable: true });
    Object.defineProperty(cut, "clipboardData", { value: { setData: (type, value) => { data.set(type, value); }, getData: type => data.get(type) ?? "" } });
    document.body.dispatchEvent(cut);
    assert.equal(cut.defaultPrevented, true); assert.match(data.get("text/plain"), /Other/);
    assert.deepEqual([...toastHost().querySelectorAll(".toast")].map(el => [el.firstChild.textContent, el.querySelector(".toast-action")]),
      [["1 beat cut — paste them with Ctrl+V.", null]]);
  }, after: () => base([row("r1", "abcdef", "ZWide"), row("r3", "Third")]), undone: base() },
  { name: "the scene menu removes a scene header and keeps its beats", act: () => {
    const remove = document.querySelector('.section-header[data-section-id="s1"] [data-section-action="remove"]');
    assert.ok(remove); remove.click();
  }, after: () => ({ ...base(), sections: [] }), undone: base() },
  { name: "the status chip cycles a beat's status", act: () => { cycleRowStatus("r1"); },
    after: () => base(START(row("r1", "abcdef", "ZWide", "ready"))), undone: base() },
  { name: "the Filmed box films a beat", act: () => { setBeatFilmed("r1", true); },
    after: () => base(START(row("r1", "abcdef", "ZWide", "shot"))), undone: base() },
  { name: "the read-time box sets a beat length", act: () => { assert.equal(setBeatLength("r1", 42), true); },
    after: () => base(START(row("r1", "abcdef", "ZWide", "todo", 42))), undone: base() },
  { name: "the rundown sets the target length", act: () => { assert.equal(setTargetLength(90), true); },
    after: () => base(START(), { target: 90 }), undone: base() },
  { name: "the title popover sets the target length", act: () => {
    promptForTarget();
    const input = document.getElementById("target-input"); assert.ok(input);
    input.value = "2:00";
    assert.equal(press(input, "Enter"), true);
  }, after: () => base(START(), { target: 120 }), undone: base() },
  { name: "the title popover sets words per minute", act: () => {
    promptForWpm();
    const input = document.getElementById("wpm-input"); assert.ok(input);
    input.value = "180";
    document.getElementById("wpm-save").click();
  }, after: () => base(START(), { wpm: 180 }), undone: base() }
];

for (const literal of served) for (const order of ORDERS) test(`C7 caller literal: ${literal.name}, ${order}`, async () => {
  const f = await enter();
  try {
    const sizes = f.parts.undo.sizes();
    remoteInsert(f.peer, "r1", "visualText", 0, "Z");
    const returned = literal.act(f);
    exchange(f, order);
    const id = literal.after.length ? minted(f) : null;
    if (returned !== undefined) assert.equal(returned, id);
    agree(f, literal.after(id));
    if (literal.caret) assert.deepEqual(caret(), literal.caret(id));
    assert.deepEqual(warnings(), []);
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 1 });
    if (literal.undone === null) return;
    undoOnce(f, order);
    assert.deepEqual(warnings(), []);
    agree(f, literal.undone);
  } finally { f.close(); }
});

for (const order of ORDERS) test(`C7 rule 133: Alt+Enter in the visual box is refused by name, warns once and writes nothing, ${order}`, async () => {
  const f = await enter();
  try {
    remoteInsert(f.peer, "r2", "audioText", 0, "Z");
    const before = encodeSharedState(f.parts.handle), sizes = f.parts.undo.sizes();
    select(cellOf("visualText"), 2);
    assert.equal(press(cellOf("visualText"), "Enter", { altKey: true }), true);
    assert.deepEqual(warnings(), [REFUSED]);
    assert.deepEqual(encodeSharedState(f.parts.handle), before);
    assert.deepEqual(f.parts.undo.sizes(), sizes);
    clearWarnings();
    exchange(f, order);
    agree(f, base([row("r1", "abcdef", "Wide"), row("r2", "ZOther"), row("r3", "Third")]));
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

test("C7 callers: a refused structure command reports its reason once even when the visual split is asked twice", async () => {
  const f = await enter();
  try {
    select(cellOf("visualText"), 1);
    assert.equal(splitRowFieldCore(cellOf("visualText")), null);
    assert.deepEqual(warnings(), [REFUSED]);
    clearWarnings();
    assert.equal(splitRowFieldCore(cellOf("visualText")), null);
    assert.deepEqual(warnings(), [REFUSED]);
  } finally { f.close(); }
});

function copiedBeat(rowId) {
  selectBeats(rowId, rowId);
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const data = new Map(), copy = new window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(copy, "clipboardData", { value: { setData: (type, value) => { data.set(type, value); }, getData: type => data.get(type) ?? "" } });
  document.body.dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, true);
  return { getData: type => data.get(type) ?? "" };
}

const ADMISSION_REFUSALS = [
  { name: "a visual split", arrange: () => { select(cellOf("visualText"), 1); }, act: () => { assert.equal(splitRowFieldCore(cellOf("visualText")), null); } },
  { name: "a beat paste", arrange: () => copiedBeat("r2"), act: data => { assert.equal(pasteBeatsAt(data, cellOf("audioText", "r3")), true); } }
];

const ADMISSIONS = [
  { name: "a session hold", arm: f => f.parts.session.hold("held-for-test"), notices: [[REFUSED, "warn"]] },
  { name: "a listener that announces its own refusal", arm: f => f.parts.session.beforeCommand(() => { notices.show("Held by the listener.", "warn"); return false; }),
    notices: [["Held by the listener.", "warn"]] }
];

for (const literal of ADMISSION_REFUSALS) for (const admission of ADMISSIONS) test(`C7 callers: ${literal.name} refused at admission by ${admission.name} is announced once`, async () => {
  const f = await enter();
  let stop = () => {};
  try {
    const data = literal.arrange();
    stop = admission.arm(f);
    clearWarnings(); noticeCalls.length = 0;
    const before = encodeSharedState(f.parts.handle), sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
    literal.act(data);
    assert.deepEqual(noticeCalls, admission.notices);
    assert.deepEqual([encodeSharedState(f.parts.handle), f.parts.undo.sizes(), undoOwner().sizes()], [before, sizes, standalone]);
  } finally { stop(); clearWarnings(); f.close(); }
});

test("C7 callers: a refusal the session already announced is not announced again", () => {
  clearWarnings();
  for (const commands of [sharedStructureCommands, sharedValueCommands]) {
    commands.refused({ kind: "rejected", reason: "not shared", notified: true });
    commands.refused({ kind: "noop" });
    assert.deepEqual(warnings(), []);
    commands.refused({ kind: "rejected", reason: "not shared" });
    assert.deepEqual(warnings(), [REFUSED]);
    clearWarnings();
  }
});

const concurrent = [
  { name: "Ctrl+Enter", peerClient: 1, remote: peer => { remoteCreate(peer, "r1", "r2", "before"); }, act: () => {
    select(cellOf("audioText"), 3);
    assert.equal(press(cellOf("audioText"), "Enter", { ctrlKey: true }), true);
  }, rows: (local, peer) => [row("r1", "abcdef", "Wide"), row(peer, ""), row(local, "x"), row("r2", "Other"), row("r3", "Third")] },
  { name: "Alt+Enter in the narration", peerClient: 1, remote: peer => { remoteSplit(peer, "r1", 3); }, act: () => {
    select(cellOf("audioText"), 3);
    assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
  }, rows: (local, peer) => [row("r1", "abc", "Wide"), row(peer, ""), row(local, "xdef"), row("r2", "Other"), row("r3", "Third")] },
  { name: "the add bar", peerClient: 0xfffffffe, remote: peer => { remoteCreate(peer, "r3", null, "after"); }, act: () => { addRowAndFocus(null, "audioText"); },
    rows: (local, peer) => [row("r1", "abcdef", "Wide"), row("r2", "Other"), row("r3", "Third"), row(local, "x"), row(peer, "")] }
];

for (const literal of concurrent) for (const order of ORDERS) test(`C7 created id: ${literal.name} focuses the beat it created while a peer's beat in the same gap arrives inside the command, ${order}`, async () => {
  const f = await enter();
  try {
    collabState(f.peer).doc.clientID = literal.peerClient;
    literal.remote(f.peer);
    const delivered = deliverInsideNextPublication(f);
    literal.act();
    delivered();
    const created = currentDocument().rows.map(r => r.id).filter(id => !["r1", "r2", "r3"].includes(id));
    const local = created.find(id => f.beat.test(id)), peer = created.find(id => !f.beat.test(id));
    assert.ok(local && peer, created.join(","));
    assert.deepEqual(caret(), [local, "audioText", 0]);
    assert.equal(document.activeElement, cellOf("audioText", local));
    assert.equal(type(cellOf("audioText", local), "x"), true);
    exchange(f, order);
    agree(f, base(literal.rows(local, peer)));
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

const splitR1 = () => {
  select(cellOf("audioText"), 3);
  assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
};
const successive = [
  { name: "two status clicks", first: () => { cycleRowStatus("r1"); }, second: () => { cycleRowStatus("r1"); }, undoes: 2,
    once: () => base(START(row("r1", "abcdef", "ZWide", "ready"))), twice: () => base(START(row("r1", "abcdef", "ZWide", "shot"))) },
  { name: "the add bar twice", first: () => { addRow(null); }, second: () => { addRow(null); }, undoes: 0,
    once: ([a]) => base([...START(), row(a, "")]), twice: ([a, b]) => base([...START(), row(a, ""), row(b, "")]) },
  { name: "the add bar then Alt+Enter", first: () => { addRow(null); }, second: splitR1, undoes: 1,
    once: ([a]) => base([...START(), row(a, "")]),
    twice: ([a, b]) => base([row("r1", "abc", "ZWide"), row(b, "def"), row("r2", "Other"), row("r3", "Third"), row(a, "")]) },
  { name: "a status click then Alt+Enter", first: () => { cycleRowStatus("r1"); }, second: splitR1, undoes: 2,
    once: () => base(START(row("r1", "abcdef", "ZWide", "ready"))),
    twice: ([b]) => base([row("r1", "abc", "ZWide", "ready"), row(b, "def"), row("r2", "Other"), row("r3", "Third")]) }
];

for (const literal of successive) for (const order of ORDERS) test(`C7 successive commands: ${literal.name} send two shared commands with two undo steps, ${order}`, async () => {
  const f = await enter();
  try {
    const sizes = f.parts.undo.sizes();
    const fresh = known => currentDocument().rows.map(r => r.id).filter(id => !["r1", "r2", "r3", ...known].includes(id));
    remoteInsert(f.peer, "r1", "visualText", 0, "Z");
    literal.first(); exchange(f, order);
    const first = fresh([]);
    agree(f, literal.once(first));
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 1 });
    literal.second(); exchange(f, order);
    const both = [...first, ...fresh(first)];
    for (const id of both) assert.match(id, f.beat);
    agree(f, literal.twice(both));
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 2 });
    assert.deepEqual(warnings(), []);
    if (literal.undoes < 1) return;
    undoOnce(f, order);
    agree(f, literal.once(first));
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 1, redo: sizes.redo + 1 });
    if (literal.undoes < 2) return;
    undoOnce(f, order);
    agree(f, base());
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, redo: sizes.redo + 2 });
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

test("C7 callers: the read-time button's own Ctrl+Z steps the shared owner", async () => {
  const f = await enter();
  try {
    assert.equal(setBeatLength("r1", 42), true);
    const button = document.querySelector('#rows .row-read[data-id="r1"]'); assert.ok(button);
    button.focus();
    assert.equal(press(button, "z", { ctrlKey: true }), true);
    exchange(f, "local-first");
    agree(f, base([row("r1", "abcdef", "Wide"), row("r2", "Other"), row("r3", "Third")]));
    assert.deepEqual(f.parts.undo.sizes(), { undo: 0, redo: 1, dropped: 0 });
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

for (const order of ORDERS) test(`C7 rule 73: pasting copied beats has no shared port, warns once and writes nothing, ${order}`, async () => {
  const f = await enter();
  try {
    remoteInsert(f.peer, "r1", "visualText", 0, "Z");
    selectBeats("r2", "r2");
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const data = new Map(), copy = new window.Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (type, value) => { data.set(type, value); }, getData: type => data.get(type) ?? "" } });
    document.body.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    clearWarnings(); noticeCalls.length = 0;
    const before = encodeSharedState(f.parts.handle), sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
    assert.doesNotThrow(() => { assert.equal(pasteBeatsAt({ getData: type => data.get(type) ?? "" }, cellOf("audioText", "r3")), true); });
    assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
    assert.deepEqual(warnings(), [REFUSED]);
    assert.deepEqual(encodeSharedState(f.parts.handle), before);
    assert.deepEqual(f.parts.undo.sizes(), sizes);
    assert.deepEqual(undoOwner().sizes(), standalone);
    clearWarnings();
    exchange(f, order);
    agree(f, base());
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

test("C7 standalone: the callers read no shared ports and keep the list-local ids", () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  assert.equal(sharedSession(), false);
  assert.equal(sharedStructureCommands.ports(), null);
  assert.equal(sharedValueCommands.ports(), null);
  clearWarnings();
  select(cellOf("audioText"), 3);
  assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
  const split = currentDocument().rows[1];
  assert.match(split.id, /^r/); assert.doesNotMatch(split.id, /^structure_/);
  assert.deepEqual(currentDocument().rows.map(r => [r.id, r.audioText]), [["r1", "abc"], [split.id, "def"], ["r2", "Other"], ["r3", "Third"]]);
  assert.deepEqual(caret(), [split.id, "audioText", 0]);
  const added = addRow(null);
  assert.equal(currentDocument().rows.at(-1).id, added);
  assert.doesNotMatch(added, /^structure_/);
  select(cellOf("visualText"), 2);
  assert.equal(press(cellOf("visualText"), "Enter", { altKey: true }), true);
  assert.deepEqual(currentDocument().rows.slice(0, 2).map(r => r.visualText), ["Wi", "de"]);
  assert.equal(currentDocument().rows[1].id === split.id, false);
  cycleRowStatus("r1"); setBeatFilmed("r2", true);
  assert.deepEqual(currentDocument().rows.filter(r => r.id === "r1" || r.id === "r2").map(r => r.status), ["ready", "shot"]);
  assert.equal(setBeatLength("r1", 42), true); assert.equal(setTargetLength(90), true);
  assert.deepEqual([currentDocument().rows[0].lengthSeconds, currentDocument().targetSeconds], [42, 90]);
  assert.deepEqual(warnings(), []);
});
