import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";
import { adapterReplica, sharedHarness } from "../../tests/application/session/shared-session-support.ts";
import { bufferReaders, bufferStamps } from "../../tests/collab/buffer-readers.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { htmlToPlainText } from "../bootstrap/plain-text.ts";
import { sharedSplitBindings } from "../bootstrap/wiring/shared-split.ts";
import { sharedWriterBindings } from "../bootstrap/wiring/shared-writer.ts";
import { adoptReplacement, currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveSharedSession, sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { sharedAuthorPort } from "../bootstrap/wiring/ports/shared-author.ts";
import { sharedUndoOwner } from "../bootstrap/wiring/ports/shared-undo.ts";
import { sharedBrollKeyingPorts } from "../bootstrap/wiring/ports/shared-broll-keying.ts";
import { sharedStructurePorts } from "../bootstrap/wiring/ports/shared-values.ts";
import { keySharedLeftCell } from "../application/commands/shared-broll-keying.ts";
import { deleteBeatCommand } from "../application/commands/rows.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { fromHtml, scriptCellOf } from "../bootstrap/richtext.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { beatPos, caretAt } from "../core/flow/flow.ts";
import { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { projectSharedDocument } from "../adapters/collab/project.ts";
import { registerSharedOperationFamilies } from "../adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../adapters/collab/execute.ts";
import { readSharedPaintedText } from "../adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../adapters/collab/buffer.ts";
import { bufferedFieldKey } from "../core/collab/buffer.ts";
import { readOperation } from "../core/collab/read-operation.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { openingStatus } from "../bootstrap/wiring/ports/transitions.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const reports = [], errors = [], warnings = [], actualNotice = notices.show;
notices.show = (...args) => { warnings.push(args); return actualNotice(...args); };
after(() => { notices.show = actualNotice; });
const allowed = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
const effects = { report: value => { reports.push(value); }, missingBase: () => {}, recovered: () => {} };
const writing = sharedWriterBindings(effects), splitting = sharedSplitBindings(effects);
let serial = 0, operationSerial = 0;
const ports = {
  opening: openingStatus,
  refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
  bindings: {
    enter: parts => { writing.enter(parts); splitting.enter(parts); },
    settle: () => writing.settle() ?? splitting.settle(),
    leave: () => { try { splitting.leave(); } finally { writing.leave(); } },
    abandon: () => { writing.abandon(); splitting.abandon(); },
    drop: () => { writing.drop(); splitting.drop(); }
  },
  common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
  docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice", structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); }, timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
};
const KEY = id => '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">B-roll:</span>';
const KEYING = ["drop-repeated-broll-keys", "key-broll-lines"];
const keysIn = html => fromHtml(String(html ?? "")).filter(run => run.atom === "broll").map(run => run.id);

function beat(rowId) {
  const element = document.querySelector('#writer-doc .wr-beat[data-id="' + rowId + '"]');
  assert.ok(element, "the Writer shows beat " + rowId);
  return element;
}
function box() {
  const element = document.querySelector(".wr-flow-visual-box"), cell = element?.querySelector(".wr-flow-visual-text");
  assert.ok(element && cell);
  return { element, cell };
}
function openVisual(rowId = "r1") {
  if (document.getElementById("writer").hidden) writerControls().openWriter();
  writerControls().writerFlowControl().openVisual(rowId);
  const shown = box();
  assert.equal(shown.element.hidden, false);
  return shown.cell;
}
function typeInBox(cell, at, value, input = true) {
  cell.focus(); setCellSelection(cell, at, at);
  const range = document.getSelection().getRangeAt(0).cloneRange();
  const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: value, bubbles: true, cancelable: true });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  if (!cell.dispatchEvent(before)) return false;
  range.deleteContents();
  const text = document.createTextNode(value); range.insertNode(text);
  document.getSelection().setBaseAndExtent(text, value.length, text, value.length);
  if (input) cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: value, bubbles: true }));
  return true;
}
function key(target, init) { target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); }
const escape = cell => { key(cell, { key: "Escape" }); };
const cellOf = (field, rowId = "r1") => {
  const cell = document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
  assert.ok(cell); return cell;
};
function leaveSplitVisual(rowId = "r1") {
  const cell = cellOf("visualText", rowId);
  cell.focus();
  const point = posToDom(cell, 1);
  document.getSelection().setBaseAndExtent(point.node, point.offset, point.node, point.offset);
  cellOf("audioText", "r2").focus();
}

async function enter(visual) {
  reports.length = 0; errors.length = 0; warnings.length = 0;
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ schema: 2, title: "Shared Writer leave", paragraphsDecided: true, rows: [
    { id: "r1", audioText: "Pour the coffee", visualText: visual, status: "todo" }, { id: "r2", audioText: "Other", visualText: "Wide", status: "todo" }
  ] }));
  undoOwner().flush();
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts(); assert.ok(parts);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  const author = sharedAuthorPort({ handle: () => peer, name: () => "Bob" });
  const owner = sharedUndoOwner(peer, () => author.next(), () => 0, error => { throw error; });
  const harness = sharedHarness(adapterReplica(peer, owner));
  const keying = sharedBrollKeyingPorts(peer, { author: () => author.next(), cells: scriptCellOf, readers: bufferReaders, plainTextOf: htmlToPlainText, stamps: bufferStamps("Bob") });
  const toPeer = () => { assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true); };
  const fromPeer = () => { assert.equal(applySharedUpdate(parts.handle, encodeSharedState(peer)).ok, true); };
  return { parts, peer, harness, author, toPeer, fromPeer, peerLeave: () => keySharedLeftCell(harness.session, "r1", keying).map(outcome => outcome.kind),
    close: () => {
      try { writerControls().closeWriter(); assert.deepEqual(leaveSharedSession(ports), { ok: true }); }
      finally { harness.session.dispose(); destroySharedDocument(peer); }
    } };
}
function peerInsert(fixture, offset, value) {
  const target = sharedBufferedTarget(fixture.peer, bufferedFieldKey("r1", "visualText")), painted = readSharedPaintedText(fixture.peer, target);
  assert.ok(painted);
  const end = offset === painted.text.length;
  const op = readOperation({ kind: "text-insert", id: "bob_" + ++operationSerial, by: "Bob", target,
    at: { left: end ? painted.endGap : null, right: end ? null : painted.identity(offset), affinity: end ? "after" : "before" }, content: [{ value, marks: [] }] });
  assert.ok(op); assert.deepEqual(executeSharedOperations(fixture.peer, [op]), { ok: true });
}
function agreed(fixture, label, order = "D1") {
  if (order === "rev") { fixture.toPeer(); fixture.fromPeer(); } else { fixture.fromPeer(); fixture.toPeer(); }
  if (order === "dup") { fixture.fromPeer(); fixture.toPeer(); }
  const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: html => fromHtml(html) });
  try {
    assert.equal(applySharedUpdate(late, encodeSharedState(fixture.parts.handle)).ok, true);
    const snapshot = doc => ({ text: doc.rows.map(row => [row.visualText, row.audioText]), shots: doc.brollShots, keys: doc.rows.map(row => keysIn(row.visualText)) });
    assertReplicasAgree(label, [
      { order, replica: "A", output: snapshot(currentDocument()) }, { order, replica: "B", output: snapshot(projectSharedDocument(fixture.peer)) },
      { order: "late-C", replica: "C", output: snapshot(projectSharedDocument(late)) }
    ]);
    const doc = currentDocument();
    return { visual: doc.rows[0].visualText, shots: doc.brollShots.map(shot => [shot.id, shot.name]) };
  } finally { destroySharedDocument(late); }
}
function counting(parts) {
  const run = parts.session.run, names = [];
  parts.session.run = command => { names.push(command.name); return run(command); };
  return { names, restore: () => { parts.session.run = run; } };
}

for (const order of ["D1", "rev", "dup"]) test(`a marker typed in the shared Writer's visual is keyed when the box is left, with its shot, on every copy: ${order}`, async () => {
  const f = await enter("Close up");
  try {
    const cell = openVisual();
    assert.equal(typeInBox(cell, 0, "B-roll: "), true);
    assert.equal(currentDocument().rows[0].visualText, "B-roll: Close up");
    const seen = counting(f.parts);
    try { escape(cell); } finally { seen.restore(); }
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), ["key-broll-lines"]);
    assert.equal(box().element.hidden, true);
    assert.deepEqual(writerControls().writerFlowControl().selection(), caretAt(beatPos("r1", 0)));
    const { visual, shots } = agreed(f, "Writer leave keyed", order), id = shots[0]?.[0];
    assert.match(id ?? "", /^bs_w\d+_\d+_0$/);
    assert.deepEqual({ visual, shots }, { visual: KEY(id) + " Close up", shots: [[id, "Close up"]] });
    assert.deepEqual(f.parts.undo.sizes(), { undo: 2, redo: 0, dropped: 0 });
    assert.deepEqual([reports, errors, warnings], [[], [], []]);
  } finally { f.close(); }
});

test("undo and redo of the keying from the Writer take back and bring back the same key and shot on every copy", async () => {
  const f = await enter("Close up");
  try {
    const cell = openVisual();
    typeInBox(cell, 0, "B-roll: ");
    key(cell, { key: "Escape" });
    const made = agreed(f, "keyed"), id = made.shots[0]?.[0];
    key(beat("r1"), { key: "z", ctrlKey: true });
    assert.deepEqual(agreed(f, "undone"), { visual: "B-roll: Close up", shots: [] });
    assert.deepEqual(f.parts.undo.sizes(), { undo: 1, redo: 1, dropped: 0 });
    key(beat("r1"), { key: "y", ctrlKey: true });
    assert.deepEqual(agreed(f, "redone"), { visual: KEY(id) + " Close up", shots: [[id, "Close up"]] });
    assert.deepEqual([reports, errors, warnings], [[], [], []]);
  } finally { f.close(); }
});

test("Ctrl+Z inside the box closes it without keying and takes back the typing, as the standalone Writer's undo does", async () => {
  const f = await enter("Close up");
  try {
    const cell = openVisual();
    typeInBox(cell, 0, "B-roll: ");
    const seen = counting(f.parts);
    try { key(cell, { key: "z", ctrlKey: true }); } finally { seen.restore(); }
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), []);
    assert.deepEqual(agreed(f, "typing undone"), { visual: "Close up", shots: [] });
    assert.deepEqual(f.parts.undo.sizes(), { undo: 0, redo: 1, dropped: 0 });
  } finally { f.close(); }
});

test("undo of the keying reopens the box; Ctrl+Y pressed there closes it without keying and redoes the same key and shot", async () => {
  const f = await enter("Close up");
  try {
    const cell = openVisual();
    typeInBox(cell, 0, "B-roll: ");
    escape(cell);
    const made = agreed(f, "keyed"), id = made.shots[0]?.[0];
    key(beat("r1"), { key: "z", ctrlKey: true });
    assert.equal(box().element.hidden, false);
    assert.equal(document.activeElement, box().cell);
    assert.deepEqual(agreed(f, "undone"), { visual: "B-roll: Close up", shots: [] });
    const seen = counting(f.parts);
    try { key(box().cell, { key: "y", ctrlKey: true }); } finally { seen.restore(); }
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), []);
    assert.deepEqual(agreed(f, "redone from the box"), { visual: KEY(id) + " Close up", shots: [[id, "Close up"]] });
    assert.deepEqual(f.parts.undo.sizes(), { undo: 2, redo: 0, dropped: 0 });
  } finally { f.close(); }
});

test("a line another copy typed is keyed when the Writer leaves its visual, by the Close button, with one undo entry", async () => {
  const f = await enter("Close up");
  try {
    peerInsert(f, 0, "B-roll: "); f.fromPeer();
    openVisual();
    box().element.querySelector(".wr-flow-visual-close").click();
    const { visual, shots } = agreed(f, "remote marker keyed"), id = shots[0]?.[0];
    assert.deepEqual({ visual, shots }, { visual: KEY(id) + " Close up", shots: [[id, "Close up"]] });
    assert.deepEqual(f.parts.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  } finally { f.close(); }
});

test("a pending visual buffer commits first, lets the held update in, and only then is the line keyed", async () => {
  const f = await enter("Close up");
  try {
    const cell = openVisual();
    assert.equal(typeInBox(cell, 0, "B-roll: ", false), true);
    peerInsert(f, 8, " shot"); f.fromPeer();
    assert.equal(currentDocument().rows[0].visualText, "Close up");
    const seen = counting(f.parts);
    try { escape(cell); } finally { seen.restore(); }
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), ["key-broll-lines"]);
    assert.notEqual(seen.names.indexOf("key-broll-lines"), 0);
    const { visual, shots } = agreed(f, "held then keyed"), id = shots[0]?.[0];
    assert.deepEqual({ visual, shots }, { visual: KEY(id) + " Close up shot", shots: [[id, "Close up shot"]] });
    assert.deepEqual([reports, errors, warnings], [[], [], []]);
  } finally { f.close(); }
});

for (const order of ["D1", "rev", "dup"]) test(`rule 197: text another copy types inside the marker, unseen when the Writer keys, stays and lands after the key: ${order}`, async () => {
  const f = await enter("B-roll: Close up");
  try {
    const cell = openVisual();
    peerInsert(f, 6, "s");
    escape(cell);
    const { visual, shots } = agreed(f, "unseen text kept", order), id = shots[0]?.[0];
    assert.deepEqual({ visual, shots }, { visual: KEY(id) + "s Close up", shots: [[id, "Close up"]] });
  } finally { f.close(); }
});

for (const order of ["D1", "rev", "dup"]) {
  test(`rule 196: a Writer leave and another copy's leave key at once; a later Split leave drops the later key: ${order}`, async () => {
    const f = await enter("B-roll: Close up");
    try {
      escape(openVisual());
      assert.deepEqual(f.peerLeave(), ["applied"]);
      const doubled = agreed(f, "doubled", order).visual, [first, later] = keysIn(doubled);
      assert.ok(first && later && first !== later);
      writerControls().closeWriter();
      leaveSplitVisual();
      const { visual, shots } = agreed(f, "cleaned by the Split", order);
      assert.deepEqual({ visual, shots }, { visual: KEY(first) + " Close up", shots: [[first, "Close up"]] });
      assert.deepEqual([reports, errors, warnings], [[], [], []]);
    } finally { f.close(); }
  });

  test(`rule 196: a Split leave and another copy's leave key at once; a later Writer leave drops the later key: ${order}`, async () => {
    const f = await enter("B-roll: Close up");
    try {
      leaveSplitVisual();
      assert.deepEqual(f.peerLeave(), ["applied"]);
      const [first, later] = keysIn(agreed(f, "doubled", order).visual);
      assert.ok(first && later && first !== later);
      escape(openVisual());
      const { visual, shots } = agreed(f, "cleaned by the Writer", order);
      assert.deepEqual({ visual, shots }, { visual: KEY(first) + " Close up", shots: [[first, "Close up"]] });
      assert.deepEqual([reports, errors, warnings], [[], [], []]);
    } finally { f.close(); }
  });
}

test("a refused cleanup stops the Writer leave before keying, with one notice", async () => {
  const f = await enter("B-roll: Close up");
  try {
    escape(openVisual());
    f.peerLeave(); assert.equal(keysIn(agreed(f, "doubled").visual).length, 2);
    const run = f.parts.session.run, names = [];
    f.parts.session.run = command => { names.push(command.name); return command.name === "drop-repeated-broll-keys" ? { kind: "rejected", reason: "read-only" } : run(command); };
    try { escape(openVisual()); } finally { f.parts.session.run = run; }
    assert.deepEqual(names.filter(name => KEYING.includes(name)), ["drop-repeated-broll-keys"]);
    assert.equal(warnings.length, 1);
  } finally { f.close(); }
});

test("leaving the Writer's narration, or a visual with nothing to key, runs no keying command", async () => {
  const f = await enter("Close up");
  try {
    const seen = counting(f.parts);
    try {
      escape(openVisual());
      writerControls().writerFlowControl().place(caretAt(beatPos("r1", 2)));
      writerControls().writerFlowControl().place(caretAt(beatPos("r2", 2)));
    } finally { seen.restore(); }
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), []);
    assert.deepEqual(f.parts.undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
  } finally { f.close(); }
});

test("rule 198: switching from the Writer to the Split with the box open commits its text but keys nothing", async () => {
  const f = await enter("Close up");
  try {
    const cell = openVisual();
    typeInBox(cell, 0, "B-roll: ");
    const seen = counting(f.parts);
    try { writerControls().closeWriter(); } finally { seen.restore(); }
    assert.equal(document.getElementById("writer").hidden, true);
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), []);
    assert.deepEqual(agreed(f, "view switch"), { visual: "B-roll: Close up", shots: [] });
  } finally { f.close(); }
});

test("rule 198: switching from the Split to the Writer with the caret in an unkeyed visual cell keys nothing", async () => {
  const f = await enter("B-roll: Close up");
  try {
    const cell = cellOf("visualText");
    cell.focus();
    const point = posToDom(cell, 3);
    document.getSelection().setBaseAndExtent(point.node, point.offset, point.node, point.offset);
    const loaded = currentDocument().brollShots.map(shot => [shot.id, shot.name]), seen = counting(f.parts);
    try { writerControls().openWriter(); } finally { seen.restore(); }
    assert.equal(document.getElementById("writer").hidden, false);
    assert.notEqual(document.activeElement, cell);
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), []);
    assert.deepEqual(agreed(f, "Split to Writer"), { visual: "B-roll: Close up", shots: loaded });
  } finally { f.close(); }
});

test("rule 198: a pending box committed by a view switch keys nothing either", async () => {
  const f = await enter("Close up");
  try {
    const cell = openVisual();
    typeInBox(cell, 0, "B-roll: ", false);
    const seen = counting(f.parts);
    try { writerControls().closeWriter(); } finally { seen.restore(); }
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), []);
    assert.deepEqual(agreed(f, "pending view switch"), { visual: "B-roll: Close up", shots: [] });
  } finally { f.close(); }
});

test("rule 198: leaving the shared session with the box open on an unkeyed line keys nothing", async () => {
  const f = await enter("B-roll: Close up");
  openVisual();
  const seen = counting(f.parts);
  try { assert.deepEqual(leaveSharedSession(ports), { ok: true }); } finally { seen.restore(); f.harness.session.dispose(); destroySharedDocument(f.peer); }
  assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), []);
  assert.equal(currentDocument().rows[0].visualText, "B-roll: Close up");
});

test("rule 198: the box left while the session is being abandoned keys nothing", async () => {
  const f = await enter("B-roll: Close up");
  try {
    const cell = openVisual();
    const seen = counting(f.parts);
    try { ports.bindings.abandon(); escape(cell); } finally { seen.restore(); }
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), []);
    assert.equal(currentDocument().rows[0].visualText, "B-roll: Close up");
  } finally { f.close(); }
});

test("rule 198: another copy removing the row under the open box keys nothing, and the box closes", async () => {
  const f = await enter("B-roll: Close up");
  try {
    openVisual();
    const structure = sharedStructurePorts({ handle: () => f.peer, author: () => f.author.next(), stamps: bufferStamps("Bob"), cells: scriptCellOf })();
    assert.ok(structure);
    assert.equal(f.harness.session.run(deleteBeatCommand("r1", structure)).kind, "applied");
    const seen = counting(f.parts);
    try { f.fromPeer(); writerControls().writerFlowControl().repaint(); } finally { seen.restore(); }
    assert.deepEqual(seen.names.filter(name => KEYING.includes(name)), []);
    assert.equal(box().element.hidden, true);
    assert.equal(currentDocument().rows.some(row => row.id === "r1"), false);
  } finally { f.close(); }
});
