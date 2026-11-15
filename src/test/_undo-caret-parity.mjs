import { bootApp, closeApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();

const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { adoptReplacement, currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { enterSharedSession, leaveSharedSession, sharedSessionParts } = await import("../bootstrap/wiring/shared-session.ts");
const { sharedWriterBindings } = await import("../bootstrap/wiring/shared-writer.ts");
const { createSessionCapabilities } = await import("../application/session/capabilities.ts");
const { fromHtml } = await import("../bootstrap/richtext.ts");
const { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } = await import("../adapters/collab/document.ts");
const { executeSharedOperations } = await import("../adapters/collab/execute.ts");
const { registerSharedOperationFamilies } = await import("../adapters/collab/operation-families.ts");
const { readSharedPaintedText } = await import("../adapters/collab/paint-base.ts");
const { resolveSharedAnchor } = await import("../adapters/collab/anchors.ts");
const { captureSharedTextRange } = await import("../adapters/collab/executor-references.ts");
const { sharedBufferedTarget } = await import("../adapters/collab/buffer.ts");
const { readOperation } = await import("../core/collab/read-operation.ts");
const { beatPos } = await import("../core/flow/flow.ts");
const { cellSelection, setCellSelection } = await import("../features/common/cell-selection.ts");
const { splitSpaceSwitch } = await import("./_shared-split-space.mjs");
const { cellCaretAfterStep } = await import("../bootstrap/wiring/editor.ts");

after(closeApp);

const ALLOWED = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
let ids = 0, opIds = 0;
const reported = [];
const writerPorts = {
  opening: { openingPending: () => false },
  refusal: () => null,
  commandRefused: undefined,
  settle: () => { undoOwner().flush(); },
  detach: () => {},
  bindings: sharedWriterBindings({ missingBase: () => {}, recovered: () => {}, report: outcome => { reported.push(outcome); } }),
  common: ALLOWED,
  standalone: createSessionCapabilities("standalone", ALLOWED),
  migrate: raw => migrateRows(raw),
  docId: () => "p" + String(++ids).padStart(32, "0"),
  editor: () => "Ada",
  structure: { cells: html => fromHtml(html) },
  report: error => { reported.push(error); },
  timers: { now: () => Date.now(), start: (run, ms) => setTimeout(run, ms), stop: handle => { clearTimeout(handle); } },
  now: () => Date.now()
};
const splitPorts = splitSpaceSwitch().ports;

const BROLL = id => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;

function field(view, rowId) {
  const selector = view === "writer" ? '#writer-doc .wr-beat[data-id="' + rowId + '"]' : '#rows .cell-editable[data-id="' + rowId + '"][data-field="audioText"]';
  const element = document.querySelector(selector);
  assert.ok(element, view + " shows " + rowId);
  return element;
}

function select(view, rowId, from, to, headRow = rowId) {
  if (view === "writer") writerControls().writerFlowControl().place({ anchor: beatPos(rowId, from), head: beatPos(headRow, to) });
  else { const cell = field(view, rowId); cell.focus(); setCellSelection(cell, from, to); }
  return window.getSelection().getRangeAt(0).cloneRange();
}

function caret(view) {
  if (view === "writer") {
    const range = writerControls().writerFlowControl().selection();
    return range && range.anchor.kind === "beat" && range.head.kind === "beat" ? [range.anchor.rowId, range.anchor.offset, range.head.offset, range.head.rowId] : null;
  }
  const cell = document.activeElement?.closest?.(".cell-editable"), range = cell ? cellSelection(cell) : null;
  return cell && range ? [cell.getAttribute("data-id"), range.from, range.to, cell.getAttribute("data-field")] : null;
}

function nativeInput(view, rowId, from, to, text, type, collapseAt) {
  const element = field(view, rowId), root = view === "writer" ? document.getElementById("writer-doc") : element;
  const target = select(view, rowId, from, to);
  if (collapseAt !== undefined) select(view, rowId, collapseAt, collapseAt);
  const key = text ? text[0] : type === "deleteContentForward" ? "Delete" : "Backspace";
  root.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data: text || null });
  Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
  if (element.dispatchEvent(before)) {
    target.deleteContents();
    if (text) {
      const node = document.createTextNode(text);
      target.insertNode(node);
      window.getSelection().setBaseAndExtent(node, text.length, node, text.length);
    } else window.getSelection().setBaseAndExtent(target.startContainer, target.startOffset, target.startContainer, target.startOffset);
    element.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type, data: text || null }));
  }
  root.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true }));
}

function compose(view, rowId, from, to, text) {
  const element = field(view, rowId), root = view === "writer" ? document.getElementById("writer-doc") : element;
  const target = select(view, rowId, from, to);
  root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertCompositionText", data: text, isComposing: true });
  Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
  if (element.dispatchEvent(before)) {
    target.deleteContents();
    const node = document.createTextNode(text);
    target.insertNode(node);
    window.getSelection().setBaseAndExtent(node, text.length, node, text.length);
    element.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: text, isComposing: true }));
  }
  root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: text }));
}

function apply(view, edit) {
  const [kind, rowId, from, to, text] = edit;
  if (kind === "type") nativeInput(view, rowId, from, to, text, "insertText");
  else if (kind === "delete") nativeInput(view, rowId, from, to, "", "deleteContentBackward");
  else if (kind === "forward") nativeInput(view, rowId, from, from + 1, "", "deleteContentForward", from);
  else if (kind === "compose") compose(view, rowId, from, to, text);
  else if (kind === "press") {
    const [, , , , key, mods, headRow] = edit;
    select(view, rowId, from, to, headRow);
    field(view, rowId).dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
  }
  else throw new Error("unknown edit " + kind);
}

function press(view, rowId, key, onCell = false) {
  const element = document.querySelector('#writer-doc .wr-beat[data-id="' + rowId + '"]') ?? document.getElementById("writer-doc");
  if (view === "writer") element.dispatchEvent(new window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
  else (onCell ? document.activeElement : document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
}

function operate(other, input) {
  const operation = readOperation({ id: "peer" + ++opIds, by: "Bob", ...input });
  assert.ok(operation);
  assert.deepEqual(executeSharedOperations(other, [operation]), { ok: true });
}

const peer = {
  join: (from, into, glue) => other => { operate(other, { kind: "join", from, into, glue }); },
  insert: (rowId, offset, value) => other => {
    const target = sharedBufferedTarget(other, rowId), painted = readSharedPaintedText(other, target);
    assert.ok(painted);
    const end = offset === painted.text.length;
    operate(other, { kind: "text-insert", target, at: { left: end ? painted.endGap : null, right: end ? null : painted.identity(offset), affinity: end ? "after" : "before" },
      content: [{ value, marks: [] }] });
  },
  picture: (rowId, offset) => other => {
    const target = sharedBufferedTarget(other, rowId), painted = readSharedPaintedText(other, target);
    assert.ok(painted);
    operate(other, { kind: "text-insert", target, at: { left: null, right: painted.identity(offset), affinity: "before" },
      content: [{ value: { atom: "image", ref: { sha256: "c".repeat(64), width: 3, height: 3, mime: "image/png" } }, marks: [] }] });
  },
  erase: (rowId, from, to) => other => {
    const target = sharedBufferedTarget(other, rowId), observed = captureSharedTextRange(other, target, from, to);
    assert.ok(observed);
    operate(other, { kind: "text-delete", target, observed: [observed] });
  },
  bold: (rowId, from, to) => other => {
    const target = sharedBufferedTarget(other, rowId), observed = captureSharedTextRange(other, target, from, to);
    assert.ok(observed);
    operate(other, { kind: "mark", target, observed: [observed], mark: { kind: "b", value: true } });
  }
};

function seedDocument(rows, written = false) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ schema: 2, rows: rows.map(([id, audioText, visualText = ""]) => written ? { id, visualText, audioText, status: "todo" } : { id, audioText, visualText, status: "todo" }) }));
  undoOwner().flush();
}

function open(view) {
  if (view !== "split") writerControls().openWriter();
}

const editView = view => view === "split" ? "split" : "writer", undoView = view => view === "writer" ? "writer" : "split";

function undoRedo(view, rowId, again, onCell = false) {
  if (view === "writer>split") writerControls().closeWriter();
  const at = undoView(view), carets = [];
  press(at, rowId, "z", onCell); carets.push(caret(at));
  press(at, rowId, "y", onCell); carets.push(caret(at));
  if (again) { press(at, rowId, "z", onCell); carets.push(caret(at)); }
  return carets;
}

function runStandalone(row, view) {
  seedDocument(row.seed, row.written);
  open(view);
  row.edits.forEach(edit => { apply(editView(view), edit); });
  undoOwner().flush();
  return undoRedo(view, row.caretRow ?? row.edits[0][1], row.again, row.onCell);
}

async function runShared(row, view, order) {
  const shared = row.shared ?? {};
  seedDocument(shared.seed ?? row.seed, row.written);
  reported.length = 0;
  assert.deepEqual(await enterSharedSession(view === "split" ? splitPorts : writerPorts), { ok: true }, String(reported.map(error => error?.stack ?? JSON.stringify(error))));
  const handle = sharedSessionParts().handle, other = createSharedDocument();
  try {
    registerSharedOperationFamilies(other, { cells: html => fromHtml(html) });
    assert.equal(applySharedUpdate(other, encodeSharedState(handle)).ok, true);
    const exchange = () => { assert.equal(applySharedUpdate(handle, encodeSharedState(other)).ok, true); assert.equal(applySharedUpdate(other, encodeSharedState(handle)).ok, true); };
    (shared.before ?? []).forEach(step => { step(other); });
    if (shared.before) exchange();
    open(view);
    const edits = shared.edits?.[order] ?? shared.edits ?? row.edits;
    if (order === "peer first") { (shared.during ?? []).forEach(step => { step(other); }); exchange(); }
    edits.forEach(edit => { apply(editView(view), edit); });
    if (order !== "peer first") { (shared.during ?? []).forEach(step => { step(other); }); exchange(); }
    const caretRow = row.caretRow ?? edits[0][1], watched = shared.watch ? watch(other, shared.watch) : null;
    const carets = undoRedo(view, caretRow, row.again, row.onCell);
    if (watched) { assert.equal(applySharedUpdate(other, encodeSharedState(handle)).ok, true); watched(); }
    return carets;
  } finally {
    destroySharedDocument(other);
    assert.deepEqual(leaveSharedSession(view === "split" ? splitPorts : writerPorts), { ok: true });
  }
}

function watch(other, [rowId, offset]) {
  const painted = readSharedPaintedText(other, sharedBufferedTarget(other, rowId)), own = painted.identity(offset), character = painted.text[offset];
  return () => {
    const at = resolveSharedAnchor(other, own), now = readSharedPaintedText(other, sharedBufferedTarget(other, rowId));
    assert.notEqual(at, "gone");
    assert.equal(now.text[at.offset], character, "the other copy's own caret stays on its character");
  };
}

export const rows = [
  { name: "delete across a join", views: ["writer", "split"], seed: [["R1", "abcd ef"]], edits: [["delete", "R1", 2, 6]], undo: 6, redo: 2, again: true,
    shared: { seed: [["R1", "abcd"], ["R2", "ef"]], before: [peer.join("R2", "R1", " ")] } },
  { name: "replace keeping the last character", views: ["writer", "split"], seed: [["R1", "abcd"]], edits: [["type", "R1", 1, 3, "Zc"]], undo: 2, redo: 2, again: true },
  { name: "replace keeping the last character by composition", views: ["writer"], seed: [["R1", "abcd"]], edits: [["compose", "R1", 1, 3, "Zc"]], undo: 2, redo: 2 },
  { name: "typing then two forward Deletes", views: ["writer", "split"], seed: [["R1", "abcd"]], edits: [["type", "R1", 1, 1, "Z"], ["forward", "R1", 2], ["forward", "R1", 2]], undo: 3, redo: 2 },
  { name: "delete a join's glue", views: ["writer", "split"], seed: [["R1", "a   b"]], edits: [["delete", "R1", 2, 3]], undo: 2, redo: 1,
    shared: { seed: [["R1", "a "], ["R2", " b"]], before: [peer.join("R2", "R1", " ")] } },
  { name: "delete inside a row the other person joins", views: ["writer", "split"], seed: [["R1", "aaa"]], edits: [["delete", "R1", 2, 3]], undo: 1, redo: 0,
    orders: ["mine first", "peer first"], caretRow: "R1",
    shared: { seed: [["R1", "aa"], ["R2", "a"]], during: [peer.join("R2", "R1", "")], edits: { "mine first": [["delete", "R2", 0, 1]], "peer first": [["delete", "R1", 2, 3]] } } },
  { name: "delete the first of two b-roll atoms", views: ["writer", "split"], seed: [["R1", BROLL("bs1") + BROLL("bs2")]], edits: [["delete", "R1", 0, 1]] },
  { name: "delete after a line break", views: ["writer", "split"], seed: [["R1", "a<br>bc"]], edits: [["delete", "R1", 2, 3]] },
  { name: "change at the start only", views: ["writer", "split"], seed: [["R1", "abcd"]], edits: [["type", "R1", 0, 0, "X"]], undo: 0, redo: 1 },
  { name: "change at the end only", views: ["writer", "split"], seed: [["R1", "abcd"]], edits: [["type", "R1", 4, 4, "X"]], undo: 4, redo: 5 },
  { name: "change in the middle", views: ["writer", "split"], seed: [["R1", "abcd"]], edits: [["type", "R1", 1, 3, "Z"]], undo: 3, redo: 2 },
  { name: "type into an empty row", views: ["writer", "split"], seed: [["R1", ""], ["R2", "next"]], edits: [["type", "R1", 0, 0, "x"]], undo: 0, redo: 1 },
  { name: "delete the middle of aaa", views: ["writer", "split"], seed: [["R1", "aaa"]], edits: [["delete", "R1", 1, 2]], undo: 1, redo: 0 },
  { name: "the other person bolds the kept end", views: ["writer", "split"], seed: [["R1", "abc<b>d</b>"]], edits: [["delete", "R1", 1, 3]], undo: 3, redo: 1, again: true,
    shared: { seed: [["R1", "abcd"]], during: [peer.bold("R1", 3, 4)], watch: ["R1", 1] } },
  { name: "Enter in the middle of a row", views: ["writer"], seed: [["R1", "abcd"], ["R2", "ef"]], edits: [["press", "R1", 2, 2, "Enter", {}]], caretRow: "R1", again: true,
    expect: { writer: [["R1", 2, 2, "R1"], ["new row", 0, 0, "new row"], ["R1", 2, 2, "R1"]] } },
  { name: "bold across two rows", views: ["writer", "writer>split"], seed: [["R1", "abcd"], ["R2", "efgh"]], edits: [["press", "R1", 2, 2, "b", { ctrlKey: true }, "R2"]], caretRow: "R1", again: true,
    expect: { writer: [["R1", 2, 2, "R2"], ["R1", 2, 2, "R2"], ["R1", 2, 2, "R2"]], "writer>split": [["R2", 2, 2, "audioText"], ["R1", 4, 4, "audioText"], ["R2", 2, 2, "audioText"]] } },
  { name: "join two rows with Alt+Backspace", views: ["writer", "writer>split"], written: true, seed: [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]], edits: [["press", "R2", 0, 0, "Backspace", { altKey: true }]], caretRow: "R1", again: true,
    expect: { writer: [["R2", 0, 0, "R2"], ["R1", 5, 5, "R1"], ["R2", 0, 0, "R2"]] } },
  { name: "Enter, then join the next row into the new one with Alt+Backspace", views: ["writer", "writer>split"], written: true, seed: [["R1", "abcd", "foo"], ["R2", "efgh", "bar"]],
    edits: [["press", "R1", 2, 2, "Enter", {}], ["press", "R2", 0, 0, "Backspace", { altKey: true }]], caretRow: "R1", again: true,
    expect: { "writer>split": [["new row", 2, 2, "audioText"], ["new row", 3, 3, "visualText"], ["new row", 2, 2, "audioText"]] } },
  { name: "undo from the Split cell itself, with the Split binding mounted", views: ["split"], seed: [["R1", "abcd"]], edits: [["type", "R1", 1, 3, "Z"]], undo: 3, redo: 2, again: true, onCell: true }
];

export const longRows = [
  { name: "append to 120,000 characters", views: ["writer"], seed: [["R1", "a".repeat(120000)]], edits: [["type", "R1", 120000, 120000, "x"]], undo: 120000, redo: 120001 }
];

export async function checkParity(row, view, order) {
  const standalone = runStandalone(row, view);
  const shared = await runShared(row, view, order);
  const rowId = row.caretRow ?? row.edits[0][1];
  if (row.undo !== undefined) assert.deepEqual(standalone.slice(0, 2).map(at => at?.slice(0, 3)), [[rowId, row.undo, row.undo], [rowId, row.redo, row.redo]], "standalone gives the literal");
  const seeded = new Set([...row.seed, ...(row.shared?.seed ?? [])].map(([id]) => id)), named = carets => carets.map(at => at?.map((part, index) => (index === 0 || index === 3) && typeof part === "string" && !["audioText", "visualText"].includes(part) && !seeded.has(part) ? "new row" : part));
  if (row.expect?.[view]) assert.deepEqual(named(standalone), row.expect[view], "standalone gives the literal selections");
  assert.deepEqual(named(shared), named(standalone));
  assert.ok(currentDocument());
}

export { peer, runShared, cellCaretAfterStep };
