import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sharedSplitBindings } from "../bootstrap/wiring/shared-split.ts";
import { sharedWriterBindings } from "../bootstrap/wiring/shared-writer.ts";
import { viewFlags } from "../bootstrap/wiring/preferences-owner.ts";
import { SHARED_SPLIT_SURFACE_NOTICES, SHARED_SPLIT_SURFACE_PENDING, sharedSplitSurfaces } from "../bootstrap/wiring/shared-split-surfaces.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { openingStatus } from "../bootstrap/wiring/ports/transitions.ts";
import { TITLE_FIELD_KEY, headingFieldKey } from "../application/editing/buffered-field-key.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveSharedSession, sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { currentWhoList } from "../bootstrap/wiring/who-list.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { screenIsStale } from "../features/rows/render.ts";
import { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState, readSharedRevision } from "../adapters/collab/document.ts";
import { projectSharedDocument } from "../adapters/collab/project.ts";
import { registerSharedOperationFamilies } from "../adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../adapters/collab/execute.ts";
import { readSharedPaintedText } from "../adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../adapters/collab/buffer.ts";
import { bufferedFieldKey } from "../core/collab/buffer.ts";
import { flowBaseReference } from "../core/collab/base-reference.ts";
import { readOperation } from "../core/collab/read-operation.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const reports = [], errors = [], noticeCalls = [], actualShow = notices.show;
notices.show = (...args) => { noticeCalls.push(args); return actualShow(...args); };
after(() => { notices.show = actualShow; });
const allowed = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
const effects = { report: value => { reports.push(value); }, missingBase: () => {}, recovered: () => {} };
let serial = 0, remoteSerial = 0;
const endings = [], originals = new WeakMap(), hookedParts = new WeakMap(), realSplit = sharedSplitBindings(effects);
let probe = null;
const DOM = window.EventTarget.prototype, nativeAdd = DOM.addEventListener, nativeRemove = DOM.removeEventListener;
const labelOf = (target, type) => (target === document ? "document" : target === window ? "window" : target.id ? "#" + target.id : target.className || target.nodeName) + " " + type;
DOM.addEventListener = function (type, listener, options) {
  if (probe?.recording) {
    probe.labels.push(labelOf(this, type));
    if (probe.labels.length === probe.inject) { probe.recording = false; throw new Error("injected at " + labelOf(this, type)); }
    probe.live.push({ target: this, type, listener, label: labelOf(this, type) });
  }
  return nativeAdd.call(this, type, listener, options);
};
DOM.removeEventListener = function (type, listener, options) {
  if (probe) probe.live = probe.live.filter(entry => !(entry.target === this && entry.type === type && entry.listener === listener));
  return nativeRemove.call(this, type, listener, options);
};
after(() => { DOM.addEventListener = nativeAdd; DOM.removeEventListener = nativeRemove; });
function hooked(parts) {
  if (!probe) return parts;
  if (hookedParts.has(parts)) return hookedParts.get(parts);
  let waited = false;
  const subscribe = listener => {
    if (!waited) {
      waited = true;
      const watched = probe;
      return parts.session.subscribe(change => { watched.recording = true; try { listener(change); } finally { watched.recording = false; } });
    }
    if (!probe?.recording) return parts.session.subscribe(listener);
    probe.labels.push("session subscribe");
    if (probe.labels.length === probe.inject) { probe.recording = false; throw new Error("injected at session subscribe"); }
    const entry = { label: "session subscribe" }, stop = parts.session.subscribe(listener), watched = probe;
    watched.live.push(entry);
    return () => { watched.live = watched.live.filter(other => other !== entry); stop(); };
  };
  const made = { ...parts, session: { ...parts.session, subscribe } };
  hookedParts.set(parts, made); originals.set(made, parts);
  return made;
}
const split = { enter: parts => realSplit.enter(originals.get(parts) ?? parts), settle: () => realSplit.settle(), leave: () => realSplit.leave(),
  abandon: () => realSplit.abandon(), drop: () => realSplit.drop(), abandonable: () => realSplit.abandonable() };
const surfaces = sharedSplitSurfaces(split, effects);
const writing = sharedWriterBindings(effects);
let withWriter = false;
const ports = {
  opening: openingStatus,
  refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
  left: landed => { endings.push(landed); },
  bindings: { enter: parts => { if (withWriter) writing.enter(parts); surfaces.enter(hooked(parts)); },
    settle: () => (withWriter ? writing.settle() : null) ?? surfaces.settle(),
    leave: () => { surfaces.leave(); if (withWriter) writing.leave(); withWriter = false; },
    abandon: () => { if (withWriter) writing.abandon(); surfaces.abandon(); },
    drop: () => { if (withWriter) writing.drop(); surfaces.drop(); } },
  common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
  docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice", structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); }, timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
};
const ORDERS = ["local-first", "remote-first"];
const SOURCE = { schema: 5, title: "Shared Split", paragraphsDecided: true,
  people: [{ id: "pSam", name: "Sam" }],
  sections: [{ id: "H1", name: "Scene", firstSceneId: "r1" }],
  rows: [{ id: "r1", audioText: "abc", visualText: "Wide for ", status: "todo" }, { id: "r2", audioText: "Other", visualText: "Close", status: "todo" }] };

async function enter(source = SOURCE, adopt = true, writer = false) {
  reports.length = 0; errors.length = 0; noticeCalls.length = 0; endings.length = 0;
  if (adopt) { writerControls().closeWriter(); adoptReplacement(migrateRows(structuredClone(source))); }
  withWriter = writer;
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts(); assert.ok(parts); assert.equal(screenIsStale(), false);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  return { parts, peer, close: () => { destroySharedDocument(peer); assert.deepEqual(leaveSharedSession(ports), { ok: true }); } };
}
function remoteInsert(handle, rowId, field, offset, text) {
  remoteInsertAt(handle, bufferedFieldKey(rowId, field), offset, text);
}
function remoteInsertAt(handle, key, offset, text) {
  const target = sharedBufferedTarget(handle, key), painted = readSharedPaintedText(handle, target);
  assert.ok(painted);
  const op = readOperation({ kind: "text-insert", id: "bob_" + ++remoteSerial, by: "Bob", target,
    at: { left: offset === painted.text.length ? painted.endGap : null, right: painted.identity(offset), affinity: offset === painted.text.length ? "after" : "before" },
    content: [{ value: text, marks: [] }] });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
function exchange(f, order) {
  const toPeer = () => { assert.equal(applySharedUpdate(f.peer, encodeSharedState(f.parts.handle)).ok, true); };
  const toLocal = () => { assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true); };
  if (order === "local-first") { toPeer(); toLocal(); } else { toLocal(); toPeer(); }
}
function shape(doc) {
  return { title: doc.title, scenes: (doc.sections ?? []).map(s => [s.name, s.firstSceneId]), rows: doc.rows.map(r => [r.audioText, r.visualText]) };
}
function agree(f, expected) {
  const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: html => fromHtml(html) });
  try {
    assert.equal(applySharedUpdate(late, encodeSharedState(f.parts.handle)).ok, true);
    assertReplicasAgree("composed Split surfaces", [
      { order: "D1", replica: "A", output: currentDocument() }, { order: "D1", replica: "B", output: projectSharedDocument(f.peer) },
      { order: "late-C", replica: "C", output: projectSharedDocument(late) }
    ]);
    assert.deepEqual(shape(currentDocument()), expected);
    assert.deepEqual([reports, errors], [[], []]);
  } finally { destroySharedDocument(late); }
}
const withZ = s => ({ ...s, rows: s.rows.map((r, i) => i === 1 ? ["Z" + r[0], r[1]] : r) });
const edit = (s, change) => { const next = structuredClone(s); change(next); return next; };
const warnings = () => noticeCalls.filter(call => call[1] === "warn");

function keys(target, key, init = {}) {
  const handled = !target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true, ...init }));
  return handled;
}
function typeInput(input, text) {
  const key = type => input.dispatchEvent(new window.KeyboardEvent(type, { key: text, bubbles: true, cancelable: true }));
  if (!key("keydown")) return false;
  key("keypress");
  if (!input.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }))) { key("keyup"); return false; }
  const from = input.selectionStart ?? input.value.length, to = input.selectionEnd ?? from;
  input.value = input.value.slice(0, from) + text + input.value.slice(to);
  input.setSelectionRange(from + text.length, from + text.length);
  input.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
  key("keyup"); return true;
}
function composeInput(input, text) {
  const from = input.selectionStart ?? input.value.length;
  input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  input.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertCompositionText", data: text, isComposing: true, bubbles: true }));
  input.value = input.value.slice(0, from) + text + input.value.slice(from);
  input.setSelectionRange(from + text.length, from + text.length);
  input.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: text, isComposing: true, bubbles: true }));
  return { end: () => { input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: text })); } };
}
function typeCell(cell, character) {
  const key = type => cell.dispatchEvent(new window.KeyboardEvent(type, { key: character, bubbles: true, cancelable: true }));
  if (!key("keydown")) return false;
  key("keypress");
  const range = document.getSelection().getRangeAt(0).cloneRange();
  const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: character, bubbles: true, cancelable: true });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  if (!cell.dispatchEvent(before)) { key("keyup"); return false; }
  range.deleteContents();
  const node = document.createTextNode(character); range.insertNode(node);
  document.getSelection().setBaseAndExtent(node, character.length, node, character.length);
  cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: character, bubbles: true }));
  key("keyup"); return true;
}
const submit = box => { assert.ok(box.form); box.form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); };
const title = () => { const input = document.getElementById("doc-title"); assert.ok(input); return input; };
const atEnd = input => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); return input; };
const cellOf = (field, rowId) => {
  const cell = document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
  assert.ok(cell, rowId + " " + field); return cell;
};
function caret(cell, offset) {
  cell.focus();
  const at = posToDom(cell, offset);
  document.getSelection().setBaseAndExtent(at.node, at.offset, at.node, at.offset);
}
function renameBox() {
  const button = document.querySelector('#rows .section-header[data-section-id="H1"] [data-section-action="rename"]'); assert.ok(button);
  button.click();
  const input = document.querySelector("#rows .section-rename input"); assert.ok(input); return input;
}
function addSceneBox(rowId) {
  const button = document.querySelector(`#rows [data-action="add-section"][data-id="${rowId}"]`); assert.ok(button, "add-section " + rowId);
  button.click();
  const input = document.querySelector("#rows .section-rename input"); assert.ok(input); return input;
}

const served = [
  { name: "typing in the title", steps: 1, act: () => { assert.equal(typeInput(atEnd(title()), "X"), true); },
    undo: () => keys(title(), "z", { ctrlKey: true }), after: s => edit(s, n => { n.title = "Shared SplitX"; }) },
  { name: "renaming a scene in its name box", steps: 1, act: () => {
    const box = atEnd(renameBox()); assert.equal(box.value, "Scene");
    assert.equal(typeInput(box, "s"), true, "typed");
    submit(box);
  }, undo: () => keys(cellOf("audioText", "r1"), "z", { ctrlKey: true }), after: s => edit(s, n => { n.scenes[0][0] = "Scenes"; }) },
  { name: "creating a scene from the add-scene box (rule 202: Ctrl+Z removes the heading it made)", steps: 1, act: () => {
    const box = addSceneBox("r2");
    assert.equal(typeInput(box, "N"), true, "typed");
    submit(box);
  }, undo: () => keys(cellOf("audioText", "r1"), "z", { ctrlKey: true }), after: s => edit(s, n => { n.scenes.push(["N", "r2"]); }) }
];

for (const literal of served) for (const order of ORDERS) test(`C7 surface literal: ${literal.name}, ${order}`, async () => {
  const f = await enter();
  try {
    const start = shape(currentDocument()), sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
    remoteInsert(f.peer, "r2", "audioText", 0, "Z");
    literal.act();
    exchange(f, order);
    agree(f, withZ(literal.after(start)));
    assert.deepEqual(warnings(), []);
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + literal.steps });
    assert.deepEqual(undoOwner().sizes(), standalone);
    assert.equal(literal.undo(), true);
    exchange(f, order);
    agree(f, withZ(start));
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, redo: sizes.redo + 1 });
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

function removeAll(f) {
  const op = (id, beat, length, at) => readOperation({ kind: "remove", id, by: "Bob", removalKind: "beat", targets: [beat], boundaries: [beat],
    observed: [flowBaseReference(beat, "audioText", 0, length)], components: [], gallery: [], at });
  const ops = [op("bob_cut1", "r1", 3, 0), op("bob_cut2", "r2", 5, 1)];
  assert.ok(ops.every(Boolean));
  assert.deepEqual(executeSharedOperations(f.peer, ops, { base: readSharedRevision(f.peer) }), { ok: true });
  assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
}

for (const order of ORDERS) test(`C7 surface literal: typing into the emptied Split script makes its first beat, ${order}`, async () => {
  const f = await enter({ ...SOURCE, sections: [] });
  try {
    removeAll(f);
    assert.equal(currentDocument().rows.length, 0);
    const host = document.getElementById("rows"), area = host?.previousElementSibling, input = area?.querySelector("textarea");
    assert.ok(area instanceof window.HTMLElement && input); assert.equal(area.hidden, false);
    const sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
    input.focus();
    assert.equal(input.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: "Hi", bubbles: true, cancelable: true })), true);
    input.value = "Hi"; input.setSelectionRange(2, 2);
    input.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: "Hi", bubbles: true }));
    assert.equal(area.hidden, true);
    assert.equal(document.activeElement?.getAttribute("data-field"), "audioText");
    exchange(f, order);
    agree(f, { title: "Shared Split", scenes: [], rows: [["Hi", ""]] });
    assert.deepEqual(warnings(), []);
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 1 });
    assert.deepEqual(undoOwner().sizes(), standalone);
  } finally { f.close(); }
});

test("C7 surface settle: an open title composition holds the leave, and the standalone title comes back after it", async () => {
  const f = await enter();
  let composing = null;
  try {
    composing = composeInput(atEnd(title()), "é");
    assert.deepEqual(leaveSharedSession(ports), { ok: false, reason: "buffer-pending" });
    assert.deepEqual(errors, []);
    assert.equal(sharedSession(), true);
  } finally { composing?.end(); f.close(); }
  assert.equal(sharedSession(), false);
  const before = currentDocument().title;
  assert.equal(typeInput(atEnd(title()), "!"), true);
  assert.equal(currentDocument().title, before + "!");
  const box = atEnd(renameBox());
  assert.equal(typeInput(box, "!"), true);
  submit(box);
  assert.equal(currentDocument().sections[0].name, "Scene!");
});

for (const box of ["rename", "add-scene"]) test(`C7 surface settle: an open composition in the ${box} box holds the leave until it ends`, async () => {
  const f = await enter();
  let composing = null;
  try {
    const input = box === "rename" ? atEnd(renameBox()) : addSceneBox("r2");
    composing = composeInput(input, "é");
    assert.deepEqual(leaveSharedSession(ports), { ok: false, reason: "buffer-pending" });
    assert.deepEqual(errors, []);
    assert.equal(sharedSession(), true);
    composing.end(); composing = null; submit(input);
    assert.deepEqual(currentDocument().sections.map(s => s.name), box === "rename" ? ["Sceneé"] : ["Scene", "é"]);
  } finally { composing?.end(); f.close(); }
  assert.equal(sharedSession(), false);
});

for (const box of ["title", "add-scene"]) for (const step of ["abandon", "drop"]) {
  test(`C7 surface abandonment: ${step === "abandon" ? "an ordinary abandon" : "a drop on its own"} cancels an open composition in the ${box} box and the leave lands`, async () => {
    const f = await enter();
    try {
      const input = box === "title" ? atEnd(title()) : addSceneBox("r2"), before = input.value;
      composeInput(input, "held");
      assert.equal(surfaces.settle(), SHARED_SPLIT_SURFACE_PENDING);
      surfaces[step]();
      if (box === "add-scene") assert.equal(input.value, before, "the cancelled composition is not left in the box for a later Enter");
    } finally { f.close(); }
    assert.deepEqual([currentDocument().title, currentDocument().sections.map(s => s.name)], ["Shared Split", ["Scene"]]);
  });
}

test("C7 surface mount: with no first delivery nothing is half-mounted, and leaving before it stops the wait and keeps the standalone boxes", () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  const calls = [], listeners = [];
  const split = { enter: () => { calls.push("enter"); }, settle: () => { calls.push("settle"); return null; }, leave: () => { calls.push("leave"); } };
  const session = { revision: () => 0, subscribe: listener => { listeners.push(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); }; } };
  const surfaces = sharedSplitSurfaces(split, effects), parts = { session };
  surfaces.enter(parts);
  surfaces.enter(parts);
  assert.deepEqual([calls, listeners.length], [["enter", "enter"], 1]);
  assert.equal(typeInput(atEnd(title()), "X"), true);
  assert.equal(currentDocument().title, "Shared SplitX", "the standalone title still answers while the shared one waits");
  assert.equal(surfaces.settle(), null);
  surfaces.leave();
  assert.deepEqual([calls, listeners.length], [["enter", "enter", "settle", "leave"], 0]);
  const box = atEnd(renameBox());
  assert.equal(typeInput(box, "s"), true); submit(box);
  assert.equal(currentDocument().sections[0].name, "Scenes");
});

test("C7 surface standalone: the title and scene boxes run their whole-field commands with no shared session", () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  assert.equal(sharedSession(), false); assert.equal(sharedSessionParts(), null);
  undoOwner().flush();
  const steps = undoOwner().sizes().undo;
  assert.equal(typeInput(atEnd(title()), "X"), true);
  assert.equal(currentDocument().title, "Shared SplitX");
  undoOwner().flush();
  assert.equal(undoOwner().sizes().undo, steps + 1);
  const box = atEnd(renameBox());
  assert.equal(typeInput(box, "s"), true);
  submit(box);
  assert.equal(currentDocument().sections[0].name, "Scenes");
});

test("C7 people guard: a shared Split visual commit cannot carry a who atom, and the list's forced pick warns once", async () => {
  const f = await enter();
  try {
    const cell = cellOf("visualText", "r1"); caret(cell, "Wide for ".length);
    for (const character of "@Sa") assert.equal(typeCell(cellOf("visualText", "r1"), character), true);
    const typed = currentDocument().rows[0].visualText, sizes = f.parts.undo.sizes();
    assert.equal(typed, "Wide for @Sa");
    assert.equal(currentWhoList()?.isOpen(), false, "native typing in a shared visual cell opens no People list");
    noticeCalls.length = 0;
    assert.equal(keys(cellOf("visualText", "r1"), "Tab"), false);
    const live = cellOf("visualText", "r1"); caret(live, "Wide for @".length);
    currentWhoList()?.maybeOpen({ inputType: "insertText", data: "@" }, live);
    assert.equal(currentWhoList()?.isOpen(live), true, "the list's own route opens it");
    assert.equal(currentWhoList()?.keydown(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }), live), true);
    assert.deepEqual(warnings().map(call => call[0]), ["This is not available in a shared session yet."]);
    assert.equal(currentWhoList()?.isOpen(), false);
    noticeCalls.length = 0;
    currentWhoList()?.cancel();
    exchange(f, "local-first");
    assert.doesNotMatch(currentDocument().rows[0].visualText, /who-anchor/);
    assert.equal(currentDocument().rows[0].visualText, typed);
    assert.doesNotMatch(projectSharedDocument(f.peer).rows[0].visualText, /who-anchor/);
    assert.deepEqual(currentDocument().productionTags.map(t => t.owner ?? ""), []);
    assert.deepEqual(f.parts.undo.sizes(), sizes);
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

test("C7 surface entry: a People list open in a Split cell closes when the shared session starts", async () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  caret(cellOf("visualText", "r1"), "Wide for ".length);
  assert.equal(typeCell(cellOf("visualText", "r1"), "@"), true);
  assert.equal(currentWhoList()?.isOpen(), true, "the standalone People list opens");
  const f = await enter(SOURCE, false);
  try {
    assert.equal(currentWhoList()?.isOpen(), false);
    assert.equal(document.getElementById("who-list")?.hidden, true);
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

function backspace(input) {
  const key = type => input.dispatchEvent(new window.KeyboardEvent(type, { key: "Backspace", bubbles: true, cancelable: true }));
  key("keydown");
  input.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
  const at = input.selectionStart ?? input.value.length;
  input.value = input.value.slice(0, at - 1) + input.value.slice(at);
  input.setSelectionRange(at - 1, at - 1);
  input.dispatchEvent(new window.InputEvent("input", { inputType: "deleteContentBackward", bubbles: true }));
  key("keyup");
}

const LONG = { ...SOURCE, title: "t".repeat(299), sections: [{ id: "H1", name: "n".repeat(199), firstSceneId: "r1" }] };
const LIMITED = [
  { name: "a title", limit: 300, key: TITLE_FIELD_KEY, notice: SHARED_SPLIT_SURFACE_NOTICES.titleCut, read: doc => doc.title,
    type: () => { assert.equal(typeInput(atEnd(title()), "A"), true); } },
  { name: "a scene name", limit: 200, key: headingFieldKey("H1"), notice: SHARED_SPLIT_SURFACE_NOTICES.sceneCut, read: doc => doc.sections[0].name,
    type: () => { const box = atEnd(renameBox()); assert.equal(typeInput(box, "A"), true, "typed"); submit(box); } }
];

for (const limited of LIMITED) for (const order of ORDERS) test(`C7 surface limit (rule 156): ${limited.name} two people took past its limit leaves with the text every copy showed, ${order}`, async () => {
  const f = await enter(LONG);
  const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: html => fromHtml(html) });
  try {
    limited.type();
    remoteInsertAt(f.peer, limited.key, limited.limit - 1, "B");
    exchange(f, order);
    assert.equal(applySharedUpdate(late, encodeSharedState(f.parts.handle)).ok, true);
    const copies = () => [limited.read(currentDocument()), limited.read(projectSharedDocument(f.peer)), limited.read(projectSharedDocument(late))];
    let shown = limited.read(currentDocument());
    assert.equal(Array.from(shown).length, limited.limit);
    assert.match(shown, /[AB]$/);
    assert.deepEqual(copies(), [shown, shown, shown], "every copy cuts at the same place the moment the two edits meet");
    assert.deepEqual(warnings().map(call => call[0]), shown.endsWith("B") ? [limited.notice] : [], "only the copy whose typing was cut is told, once");
    if (limited.key === TITLE_FIELD_KEY) {
      assert.equal(title().value, shown, "the box shows the cut");
      backspace(atEnd(title()));
      exchange(f, order);
      assert.equal(applySharedUpdate(late, encodeSharedState(f.parts.handle)).ok, true);
      const next = limited.read(currentDocument());
      assert.equal(next, "t".repeat(299) + (shown.endsWith("A") ? "B" : "A"), "deleting the last shown character shows the one the cut hid");
      assert.deepEqual(copies(), [next, next, next]);
      assert.equal(title().value, next);
      shown = next;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(leaveSharedSession(ports), { ok: true });
    assert.deepEqual(copies(), [shown, shown, shown], "leaving changes the text on no copy");
    if (limited.key === TITLE_FIELD_KEY) assert.equal(title().value, shown);
  } finally {
    destroySharedDocument(late); destroySharedDocument(f.peer);
    if (sharedSession()) leaveSharedSession(ports);
  }
});

test("C7 surface mount: a first-delivery mount that fails at any registration unwinds, ends the session through the switch's forced leave with its notice, and the standalone boxes answer", async () => {
  probe = { inject: null, labels: [], live: [], recording: false };
  const clean = await enter(SOURCE);
  const labels = probe.labels; probe = null;
  clean.close();
  for (const step of ["#doc-title beforeinput", "document pointerdown", "empty-script-input input", "session subscribe"]) assert.ok(labels.includes(step), step);
  for (let at = 1; at <= labels.length; at++) {
    const where = labels[at - 1] + " (registration " + at + ")";
    writerControls().closeWriter();
    adoptReplacement(migrateRows(structuredClone(SOURCE)));
    reports.length = 0; errors.length = 0; noticeCalls.length = 0; endings.length = 0;
    probe = { inject: at, labels: [], live: [], recording: false };
    let outcome;
    try { outcome = await enterSharedSession(ports); } finally { probe.recording = false; }
    assert.equal(sharedSession(), true, where + ": the session stays until the switch has returned");
    await new Promise(resolve => { setTimeout(resolve, 0); });
    const left = probe.live.map(entry => entry.label); probe = null;
    assert.deepEqual(outcome, { ok: true }, where);
    assert.deepEqual(endings, [true], where + ": the forced leave landed a standalone copy");
    assert.equal(sharedSession(), false, where);
    assert.deepEqual(left, [], where + ": nothing the failed mount registered stays registered");
    assert.deepEqual(warnings().map(call => call[0]), [SHARED_SPLIT_SURFACE_NOTICES.failed], where);
    assert.match(String(errors[0]?.message), new RegExp("injected at"), where);
    assert.equal(document.querySelector(".empty-script"), null, where);
    assert.equal(typeInput(atEnd(title()), "!"), true, where);
    assert.equal(currentDocument().title, "Shared Split!", where);
    const box = atEnd(renameBox());
    assert.equal(typeInput(box, "s"), true, where); submit(box);
    assert.equal(currentDocument().sections[0].name, "Scenes", where);
    const added = addSceneBox("r2");
    assert.equal(typeInput(added, "N"), true, where); submit(added);
    assert.deepEqual(currentDocument().sections.map(s => s.name), ["Scenes", "N"], where);
  }
});

function nativeInput(input, text) {
  assert.equal(input.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true })), true);
  const from = input.selectionStart ?? input.value.length, to = input.selectionEnd ?? from;
  input.value = input.value.slice(0, from) + text + input.value.slice(to);
  input.setSelectionRange(from + text.length, from + text.length);
}
function cellText(cell, text, composing, input) {
  const inputType = composing ? "insertCompositionText" : "insertText", range = document.getSelection().getRangeAt(0).cloneRange();
  const before = new window.InputEvent("beforeinput", { inputType, data: text, isComposing: composing, bubbles: true, cancelable: !composing });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  assert.equal(cell.dispatchEvent(before), true);
  range.deleteContents();
  const node = document.createTextNode(text); range.insertNode(node);
  document.getSelection().setBaseAndExtent(node, text.length, node, text.length);
  if (input) cell.dispatchEvent(new window.InputEvent("input", { inputType, data: text, isComposing: composing, bubbles: true }));
}
function composeCell(cell, text) {
  cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  cellText(cell, text, true, true);
  return { end: () => { cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: text })); } };
}
const box = { native: nativeInput, buffered: (input, text) => { assert.equal(typeInput(input, text), true); }, composing: composeInput };
const CONTRACT = [
  { name: "title", text: "X", open: () => atEnd(title()), read: doc => doc.title, start: "Shared Split", typed: "Shared SplitX", ...box },
  { name: "scene name", text: "X", open: () => atEnd(renameBox()), read: doc => doc.sections.map(s => s.name), start: ["Scene"], typed: ["SceneX"], ...box },
  { name: "add-scene box", text: "N", open: () => addSceneBox("r2"), read: doc => doc.sections.map(s => s.name), start: ["Scene"], typed: ["Scene", "N"], ...box },
  { name: "emptied-script input", text: "Hi", source: { ...SOURCE, sections: [] }, prepare: removeAll,
    open: () => { const input = document.getElementById("rows")?.previousElementSibling?.querySelector("textarea"); assert.ok(input); input.focus(); return input; },
    read: doc => doc.rows.map(r => r.audioText), start: [], typed: ["Hi"], ...box },
  { name: "Split field", text: "X", open: () => { const cell = cellOf("audioText", "r1"); caret(cell, 3); return cell; }, read: doc => doc.rows[0].audioText,
    start: "abc", typed: "abcX", held: "buffer-composition", native: (cell, text) => { cellText(cell, text, false, false); }, buffered: (cell, text) => { cellText(cell, text, false, true); },
    composing: composeCell }
];
for (const surface of CONTRACT.slice(0, 3)) for (const exit of ["blur", "outside press", "view switch"]) {
  test(`C7 surface contract: ${surface.name}, native with queued peer, ${exit}`, async () => {
    const f = await enter(SOURCE, true, exit === "view switch");
    try {
      const input = surface.open();
      surface.native(input, surface.text);
      const delivered = [];
      const stop = f.parts.session.subscribe(() => {
        if (currentDocument().rows[1].audioText === "ZOther") delivered.push(surface.read(currentDocument()));
      });
      remoteInsert(f.peer, "r2", "audioText", 0, "Z");
      assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
      assert.equal(currentDocument().rows[1].audioText, "Other", "the native edit holds the peer delivery");
      if (exit === "blur") input.blur();
      if (exit === "outside press") {
        document.body.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
        assert.deepEqual(surface.read(currentDocument()), surface.typed, "the outside press itself finishes native text");
        assert.equal(currentDocument().rows[1].audioText, "ZOther");
        input.blur();
        document.body.click();
      }
      if (exit === "view switch") {
        let switched = null;
        const off = viewFlags().onChange(change => {
          if (change.flag === "writerOpen" && change.value) switched = { value: surface.read(currentDocument()), peer: currentDocument().rows[1].audioText };
        });
        try { writerControls().openWriter(); } finally { off(); }
        assert.deepEqual(switched, { value: surface.typed, peer: "ZOther" }, "settlement precedes the view change");
      }
      await Promise.resolve();
      assert.deepEqual(surface.read(currentDocument()), surface.typed);
      assert.equal(currentDocument().rows[1].audioText, "ZOther", "the exit finishes before releasing the peer delivery");
      stop();
      assert.ok(delivered.length > 0);
      for (const value of delivered) assert.deepEqual(value, surface.typed, "no delivery sees the pending native edit discarded");
      exchange(f, "local-first");
      agree(f, withZ(edit(shape(SOURCE), doc => {
        if (surface.name === "title") doc.title = surface.typed;
        if (surface.name === "scene name") doc.scenes[0][0] = "SceneX";
        if (surface.name === "add-scene box") doc.scenes.push(["N", "r2"]);
      })));
      assert.deepEqual(leaveSharedSession(ports), { ok: true });
      assert.equal(surfaces.abandonable(), 0);
      assert.equal(writing.abandonable(), 0);
      assert.equal(document.querySelector("#rows .section-rename"), null);
    } finally {
      writerControls().closeWriter();
      destroySharedDocument(f.peer);
      if (sharedSession()) forceLeaveSharedSession();
    }
  });
}
for (const surface of CONTRACT.slice(1, 3)) for (const state of ["native"]) {
  test(`C7 surface contract: ${surface.name}, ${state} with queued peer, Escape cancels`, async () => {
    const f = await enter();
    try {
      const input = surface.open();
      surface[state](input, surface.text);
      remoteInsert(f.peer, "r2", "audioText", 0, "Z");
      assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
      keys(input, "Escape");
      await Promise.resolve();
      assert.deepEqual(surface.read(currentDocument()), surface.start);
      assert.equal(currentDocument().rows[1].audioText, "ZOther");
      assert.equal(document.querySelector("#rows .section-rename"), null);
      assert.deepEqual(leaveSharedSession(ports), { ok: true });
      assert.equal(surfaces.abandonable(), 0);
    } finally { destroySharedDocument(f.peer); if (sharedSession()) forceLeaveSharedSession(); }
  });
}
const failedAt = new Map();
test("C7 surface contract: title Escape keeps the title edit, as in standalone", async () => {
  const f = await enter();
  try {
    const input = atEnd(title()); nativeInput(input, "X");
    keys(input, "Escape");
    assert.equal(input.isConnected, true);
    assert.equal(input.value, "Shared SplitX");
    input.blur(); await Promise.resolve();
    assert.equal(currentDocument().title, "Shared SplitX");
  } finally { f.close(); }
});
async function failedEntry(source) {
  if (!failedAt.has(source)) {
    probe = { inject: null, labels: [], live: [], recording: false };
    const clean = await enter(source);
    const labels = probe.labels; probe = null;
    clean.close();
    failedAt.set(source, labels.indexOf("#doc-title beforeinput") + 1);
  }
  assert.ok(failedAt.get(source) > 0);
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(source)));
  reports.length = 0; errors.length = 0; noticeCalls.length = 0; endings.length = 0;
  probe = { inject: failedAt.get(source), labels: [], live: [], recording: false };
  try { assert.deepEqual(await enterSharedSession(ports), { ok: true }); } finally { probe.recording = false; probe = null; }
  const parts = sharedSessionParts(); assert.ok(parts);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  return { parts, peer };
}

for (const surface of CONTRACT) for (const state of ["idle", "native", "buffered", "composing"]) for (const exit of ["leave", "stop", "failed mount"]) {
  if (exit === "failed mount" && surface.name !== "Split field" && state !== "idle") continue;
  test(`C7 surface contract: ${surface.name}, ${state}, ${exit}`, async () => {
    const source = surface.source ?? SOURCE, failed = exit === "failed mount";
    const f = failed ? await failedEntry(source) : await enter(source);
    let composition = null, element = null;
    try {
      if (!failed) surface.prepare?.(f);
      const before = surface.read(currentDocument());
      if (!failed) assert.deepEqual(before, surface.start);
      if (state !== "idle" || !failed) element = surface.open();
      if (state === "native" || state === "buffered") surface[state](element, surface.text);
      if (state === "composing") composition = surface.composing(element, surface.text);
      if (exit === "leave" && composition) {
        assert.deepEqual(leaveSharedSession(ports), { ok: false, reason: surface.held ?? SHARED_SPLIT_SURFACE_PENDING }, "an open composition holds an ordinary leave");
        assert.equal(sharedSession(), true);
        composition.end(); composition = null;
      }
      if (exit === "leave") assert.deepEqual(leaveSharedSession(ports), { ok: true });
      if (exit === "stop") assert.deepEqual(forceLeaveSharedSession(), { ok: true });
      if (failed) await new Promise(resolve => { setTimeout(resolve, 0); });
      const lands = state === "native" || state === "buffered" || state === "composing" && exit === "leave";
      assert.equal(sharedSession(), false);
      assert.deepEqual(endings, [true], "a standalone copy landed");
      assert.deepEqual(surface.read(currentDocument()), lands ? surface.typed : before);
      assert.equal(surfaces.abandonable(), 0, "nothing stays registered");
      assert.equal(document.querySelector("#rows .section-rename"), null, "no name box stays open");
      assert.equal(currentWhoList()?.isOpen() ?? false, false);
      if (surface.name === "emptied-script input" && element) assert.equal(element.isConnected, false);
      if (failed) assert.deepEqual(warnings().map(call => call[0]).filter(text => text === SHARED_SPLIT_SURFACE_NOTICES.failed), [SHARED_SPLIT_SURFACE_NOTICES.failed]);
      else assert.deepEqual(errors, []);
    } finally {
      composition?.end();
      destroySharedDocument(f.peer);
      if (sharedSession()) forceLeaveSharedSession();
    }
  });
}

test("C7 surface mount: an app stop in the failed-mount gap releases the failure hold and lands the shared copy without the failure notice", async () => {
  const f = await failedEntry(SOURCE);
  try {
    remoteInsert(f.peer, "r2", "audioText", 0, "Z");
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    assert.deepEqual(forceLeaveSharedSession(), { ok: true });
    assert.deepEqual(endings, [true]);
    assert.deepEqual(shape(currentDocument()), withZ(shape(SOURCE)));
    await new Promise(resolve => { setTimeout(resolve, 0); });
    assert.deepEqual(warnings(), [], "the delayed callback finds the session gone and says nothing");
    assert.equal(surfaces.abandonable(), 0);
  } finally {
    destroySharedDocument(f.peer);
    if (sharedSession()) forceLeaveSharedSession();
  }
});

for (const state of ["native", "buffered"]) {
  test(`C7 surface mount: an app stop in the failed-mount gap with ${state} Split typing lands the typing and the peer's text`, async () => {
    const f = await failedEntry(SOURCE);
    try {
      const cell = cellOf("audioText", "r1"); caret(cell, 3);
      cellText(cell, "X", false, state === "buffered");
      const typed = warnings().length;
      remoteInsert(f.peer, "r2", "audioText", 0, "Z");
      assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
      assert.deepEqual(forceLeaveSharedSession(), { ok: true });
      assert.deepEqual(endings, [true], "the exit lifted the failure hold, so the copy landed instead of being dropped");
      assert.deepEqual(shape(currentDocument()), withZ(edit(shape(SOURCE), s => { s.rows[0][0] = "abcX"; })));
      await new Promise(resolve => { setTimeout(resolve, 0); });
      assert.deepEqual([typed, warnings().length], state === "buffered" ? [1, 1] : [0, 0],
        "typing that reaches the held session is refused once and kept; the exit adds no notice of its own");
      assert.equal(surfaces.abandonable(), 0);
    } finally {
      destroySharedDocument(f.peer);
      if (sharedSession()) forceLeaveSharedSession();
    }
  });
}

for (const surface of CONTRACT.filter(s => s.name === "add-scene box" || s.name === "emptied-script input")) {
  test(`C7 surface abandonment (rule 166): an ordinary abandon lands the text the browser already wrote in the ${surface.name}`, async () => {
    const f = await enter(surface.source ?? SOURCE);
    try {
      surface.prepare?.(f);
      surface.native(surface.open(), surface.text);
      surfaces.abandon();
      assert.deepEqual(surface.read(currentDocument()), surface.typed);
      assert.deepEqual(leaveSharedSession(ports), { ok: true });
      assert.deepEqual(surface.read(currentDocument()), surface.typed);
      assert.deepEqual(errors, []);
    } finally {
      destroySharedDocument(f.peer);
      if (sharedSession()) forceLeaveSharedSession();
    }
  });
}

for (const exit of ["leave", "stop"]) test(`C7 surface leave: a People list open in a shared Split cell closes on ${exit}`, async () => {
  const f = await enter();
  try {
    const live = cellOf("visualText", "r1"); caret(live, "Wide for ".length);
    assert.equal(typeCell(live, "@"), true);
    currentWhoList()?.maybeOpen({ inputType: "insertText", data: "@" }, cellOf("visualText", "r1"));
    assert.equal(currentWhoList()?.isOpen(), true);
    assert.deepEqual(exit === "leave" ? leaveSharedSession(ports) : forceLeaveSharedSession(), { ok: true });
    assert.equal(currentWhoList()?.isOpen(), false);
    assert.equal(document.getElementById("who-list")?.hidden, true);
  } finally {
    destroySharedDocument(f.peer);
    if (sharedSession()) forceLeaveSharedSession();
  }
});

const CUTS = [
  { name: "a title", source: { ...SOURCE, title: "t".repeat(299) }, key: TITLE_FIELD_KEY, notice: SHARED_SPLIT_SURFACE_NOTICES.titleCut, letter: "t",
    type: letter => { assert.equal(typeInput(atEnd(title()), letter), true); } },
  { name: "a scene name", source: { ...SOURCE, sections: [{ id: "H1", name: "n".repeat(199), firstSceneId: "r1" }] }, key: headingFieldKey("H1"),
    notice: SHARED_SPLIT_SURFACE_NOTICES.sceneCut, letter: "n", type: letter => { const name = atEnd(renameBox()); assert.equal(typeInput(name, letter), true); submit(name); } }
];
for (const cut of CUTS) for (const order of ORDERS) {
  test(`C7 surface limit (rule 156): ${cut.name} whose shown text stays the same while my letter is cut tells me once, ${order}`, async () => {
    const f = await enter(cut.source);
    try {
      cut.type(cut.letter);
      remoteInsertAt(f.peer, cut.key, 0, cut.letter);
      exchange(f, order);
      assert.deepEqual(warnings().map(call => call[0]), [cut.notice]);
    } finally { f.close(); }
  });
  test(`C7 surface limit (rule 156): ${cut.name} whose cut part grows with someone else's letters tells me only once, ${order}`, async () => {
    const f = await enter(cut.source);
    try {
      cut.type("A");
      remoteInsertAt(f.peer, cut.key, 0, "B");
      exchange(f, order);
      assert.deepEqual(warnings().map(call => call[0]), [cut.notice]);
      remoteInsertAt(f.peer, cut.key, 0, "C");
      exchange(f, order);
      assert.deepEqual(warnings().map(call => call[0]), [cut.notice]);
    } finally { f.close(); }
  });
}
