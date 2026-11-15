import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sharedSplitBindings } from "../bootstrap/wiring/shared-split.ts";
import { adoptReplacement, currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveSharedSession, sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { posToDom } from "../features/common/cell-dom.ts";
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
let serial = 0, operationSerial = 0;
const ports = {
  opening: openingStatus,
  refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
  bindings: sharedSplitBindings({ report: value => { reports.push(value); }, missingBase: () => {}, recovered: () => {} }),
  common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
  docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice", structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); }, timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
};
const KEY = id => '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">B-roll:</span>';
const cellOf = (field, rowId = "r1") => {
  const cell = document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
  assert.ok(cell); return cell;
};
function select(cell, at) {
  cell.focus();
  const point = posToDom(cell, at);
  document.getSelection().setBaseAndExtent(point.node, point.offset, point.node, point.offset);
}
function type(cell, character) {
  const range = document.getSelection().getRangeAt(0).cloneRange();
  const before = new window.InputEvent("beforeinput", { inputType: "insertText", data: character, bubbles: true, cancelable: true });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  if (!cell.dispatchEvent(before)) return false;
  range.deleteContents();
  const text = document.createTextNode(character); range.insertNode(text);
  document.getSelection().setBaseAndExtent(text, character.length, text, character.length);
  cell.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: character, bubbles: true }));
  return true;
}
async function enter(visual) {
  reports.length = 0; errors.length = 0; warnings.length = 0;
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ schema: 2, title: "Shared leave", paragraphsDecided: true, rows: [
    { id: "r1", audioText: "Pour the coffee", visualText: visual, status: "todo" }, { id: "r2", audioText: "Other", visualText: "Wide", status: "todo" }
  ] }));
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts(); assert.ok(parts);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  return { parts, peer, close: () => { destroySharedDocument(peer); assert.deepEqual(leaveSharedSession(ports), { ok: true }); } };
}
function remoteMarker(fixture) {
  const target = sharedBufferedTarget(fixture.peer, bufferedFieldKey("r1", "visualText")), painted = readSharedPaintedText(fixture.peer, target);
  assert.ok(painted);
  const op = readOperation({ kind: "text-insert", id: "bob_" + ++operationSerial, by: "Bob", target, at: { left: null, right: painted.identity(0), affinity: "before" },
    content: [{ value: "B-roll: ", marks: [] }] });
  assert.ok(op); assert.deepEqual(executeSharedOperations(fixture.peer, [op]), { ok: true });
  assert.equal(applySharedUpdate(fixture.parts.handle, encodeSharedState(fixture.peer)).ok, true);
}
function agreed(fixture) {
  assert.equal(applySharedUpdate(fixture.peer, encodeSharedState(fixture.parts.handle)).ok, true);
  const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: html => fromHtml(html) });
  try {
    assert.equal(applySharedUpdate(late, encodeSharedState(fixture.parts.handle)).ok, true);
    const read = doc => ({ visual: doc.rows[0].visualText, shots: doc.brollShots.map(shot => [shot.id, shot.name]) });
    const snapshot = doc => ({ text: doc.rows.map(row => [row.visualText, row.audioText]), shots: doc.brollShots,
      keys: doc.rows.map(row => fromHtml(row.visualText).filter(run => run.atom === "broll").map(run => run.id)) });
    assertReplicasAgree("left Split cell", [
      { order: "D1", replica: "A", output: snapshot(currentDocument()) }, { order: "D1", replica: "B", output: snapshot(projectSharedDocument(fixture.peer)) },
      { order: "late-C", replica: "C", output: snapshot(projectSharedDocument(late)) }
    ]);
    return read(currentDocument());
  } finally { destroySharedDocument(late); }
}
function counting(parts) {
  const run = parts.session.run, names = [];
  parts.session.run = command => { names.push(command.name); return run(command); };
  return { names, restore: () => { parts.session.run = run; } };
}

test("rule 196: leaving a Split visual cell keys the line another copy typed, with its shot and one undo entry", async () => {
  const f = await enter("Close up");
  try {
    remoteMarker(f);
    select(cellOf("visualText"), 3);
    cellOf("audioText", "r2").focus();
    const { visual, shots } = agreed(f), id = shots[0]?.[0];
    assert.match(id ?? "", /^bs_k\d+_\d+$/);
    assert.deepEqual({ visual, shots }, { visual: KEY(id) + " Close up", shots: [[id, "Close up"]] });
    assert.deepEqual(f.parts.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    assert.deepEqual([reports, errors, warnings], [[], [], []]);
  } finally { f.close(); }
});

test("a line typed in the cell itself is keyed when the person leaves the cell, not while typing", async () => {
  const f = await enter("Close up");
  try {
    const cell = cellOf("visualText"); select(cell, 0);
    for (const character of "B-roll: ") assert.equal(type(cell, character), true);
    assert.equal(currentDocument().rows[0].visualText, "B-roll: Close up");
    cellOf("audioText", "r2").focus();
    const { visual, shots } = agreed(f), id = shots[0]?.[0];
    assert.deepEqual({ visual, shots }, { visual: KEY(id) + " Close up", shots: [[id, "Close up"]] });
    assert.deepEqual(f.parts.undo.sizes(), { undo: 2, redo: 0, dropped: 0 });
  } finally { f.close(); }
});

test("leaving a narration cell, or a visual cell with nothing to key, runs no command", async () => {
  const f = await enter("Close up");
  try {
    const seen = counting(f.parts);
    try {
      select(cellOf("visualText"), 2); cellOf("audioText").focus();
      select(cellOf("audioText"), 2); cellOf("visualText", "r2").focus();
    } finally { seen.restore(); }
    assert.deepEqual(seen.names, []);
    assert.deepEqual(f.parts.undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
  } finally { f.close(); }
});

test("rule 198: leaving the shared session from a cell holding an unkeyed line keys nothing in it", async () => {
  const f = await enter("Close up");
  remoteMarker(f);
  select(cellOf("visualText"), 3);
  const seen = counting(f.parts);
  try { f.close(); } finally { seen.restore(); }
  assert.deepEqual(seen.names.filter(name => name === "key-broll-lines" || name === "drop-repeated-broll-keys"), []);
});

test("rule 198: a cell left while the session is being abandoned keys nothing", async () => {
  const f = await enter("Close up");
  try {
    remoteMarker(f);
    select(cellOf("visualText"), 3);
    const seen = counting(f.parts);
    try { ports.bindings.abandon(); cellOf("audioText", "r2").focus(); } finally { seen.restore(); }
    assert.deepEqual(seen.names, []);
    assert.equal(currentDocument().rows[0].visualText, "B-roll: Close up");
  } finally { f.close(); }
});
