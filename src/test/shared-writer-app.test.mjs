import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();

const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { adoptReplacement, currentDocument, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { enterSharedSession, leaveSharedSession, sharedSessionParts } = await import("../bootstrap/wiring/shared-session.ts");
const { sharedWriterBindings } = await import("../bootstrap/wiring/shared-writer.ts");
const { createSessionCapabilities } = await import("../application/session/capabilities.ts");
const { fromHtml } = await import("../bootstrap/richtext.ts");
const { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } = await import("../adapters/collab/document.ts");
const { collabState } = await import("../adapters/collab/state.ts");
const { executeSharedOperations } = await import("../adapters/collab/execute.ts");
const { registerSharedOperationFamilies } = await import("../adapters/collab/operation-families.ts");
const { readSharedPaintedText } = await import("../adapters/collab/paint-base.ts");
const { sharedBufferedTarget } = await import("../adapters/collab/buffer.ts");
const { readOperation } = await import("../core/collab/read-operation.ts");
const { beatPos, caretAt } = await import("../core/flow/flow.ts");
const { cellSelection } = await import("../features/common/cell-selection.ts");
const { documentReader } = await import("../bootstrap/wiring/ports/document.ts");

after(closeApp);

const ALLOWED = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
const reports = [], recovered = [], missing = [], errors = [];
let ids = 0;
const ports = {
  refusal: () => null,
  commandRefused: undefined,
  settle: () => { undoOwner().flush(); },
  detach: () => {},
  bindings: sharedWriterBindings({ missingBase: rowId => { missing.push(rowId); }, recovered: rowId => { recovered.push(rowId); }, report: outcome => { reports.push(outcome); } }),
  common: ALLOWED,
  standalone: createSessionCapabilities("standalone", ALLOWED),
  migrate: raw => migrateRows(raw),
  docId: () => "d" + String(++ids).padStart(32, "0"),
  editor: () => "Ada",
  structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); },
  timers: { now: () => Date.now(), start: (run, ms) => setTimeout(run, ms), stop: handle => { clearTimeout(handle); } },
  now: () => Date.now()
};

function beat(rowId) {
  const element = document.querySelector('#writer-doc .wr-beat[data-id="' + rowId + '"]');
  assert.ok(element, "the Writer shows beat " + rowId);
  return element;
}

function typeAtEnd(rowId, character) {
  const element = beat(rowId), root = document.getElementById("writer-doc");
  return typeIn(element, root, character);
}

function typeIn(element, root, character) {
  root.focus();
  const node = element.lastChild;
  const range = document.createRange();
  range.setStart(node, node.data.length);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  root.dispatchEvent(new window.KeyboardEvent("keydown", { key: character, bubbles: true, cancelable: true }));
  const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: character });
  const target = range.cloneRange();
  Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
  if (!element.dispatchEvent(before)) return false;
  node.data += character;
  window.getSelection().setBaseAndExtent(node, node.data.length, node, node.data.length);
  element.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: character }));
  root.dispatchEvent(new window.KeyboardEvent("keyup", { key: character, bubbles: true }));
  return true;
}

function remoteAtStart(other, rowId, text) {
  remoteAt(other, rowId, text, 0);
}

function remoteAt(other, rowId, text, offset) {
  const target = sharedBufferedTarget(other, rowId), painted = readSharedPaintedText(other, target);
  assert.ok(painted);
  const operation = readOperation({ kind: "text-insert", id: "bob" + text, by: "Bob", target,
    at: { left: offset === painted.text.length ? painted.endGap : null, right: painted.identity(offset),
      affinity: offset === painted.text.length ? "after" : "before" },
    content: [{ value: text, marks: [] }] });
  assert.ok(operation);
  assert.deepEqual(executeSharedOperations(other, [operation]), { ok: true });
}

const audio = () => currentDocument()?.rows[0]?.audioText;

test("in the real app, a shared Writer types through the buffers, shows another writer's text, and Ctrl+Z takes back only its own typing", async () => {
  adoptReplacement(migrateRows({ title: "Shared Writer", rows: [{ id: "r1", audioText: "Hello", visualText: "", status: "todo" }] }));
  undoOwner().flush();
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts();
  assert.ok(parts);
  const other = createSharedDocument();
  try {
    registerSharedOperationFamilies(other, { cells: html => fromHtml(html) });
    assert.equal(applySharedUpdate(other, encodeSharedState(parts.handle)).ok, true);
    writerControls().openWriter();
    assert.equal(beat("r1").textContent, "Hello");
    assert.equal(typeAtEnd("r1", "x"), true);
    assert.deepEqual([audio(), beat("r1").textContent, reports], ["Hellox", "Hellox", []]);
    remoteAtStart(other, "r1", "Y");
    assert.equal(applySharedUpdate(parts.handle, encodeSharedState(other)).ok, true);
    assert.deepEqual([audio(), beat("r1").textContent], ["YHellox", "YHellox"]);
    writerControls().writerFlowControl()?.place(caretAt(beatPos("r1", 0)));
    beat("r1").dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual([audio(), beat("r1").textContent, parts.undo.sizes()], ["YHello", "YHello", { undo: 0, redo: 1, dropped: 0 }]);
    assert.deepEqual(writerControls().writerFlowControl()?.selection(), caretAt(beatPos("r1", 6)));
    assert.equal(applySharedUpdate(other, encodeSharedState(parts.handle)).ok, true);
    assert.equal(readSharedPaintedText(other, sharedBufferedTarget(other, "r1"))?.text, "YHello");
    assert.deepEqual(leaveSharedSession(ports), { ok: true });
    assert.deepEqual([sharedSession(), audio(), errors, reports], [false, "YHello", [], []]);
  } finally { destroySharedDocument(other); }
});

for (const [side, merged, caret] of [["lower", "abYx", 3], ["higher", "abxY", 2]]) test(`shared Writer undo puts the caret where the undone typing was, as standalone does, with remote text in the same gap from a ${side} client`, async () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ rows: [{ id: "r1", audioText: "ab", visualText: "", status: "todo" }] }));
  undoOwner().flush();
  assert.deepEqual(await enterSharedSession(ports), { ok: true });
  const parts = sharedSessionParts(), other = createSharedDocument();
  try {
    collabState(other).doc.clientID = collabState(parts.handle).doc.clientID + (side === "lower" ? -1 : 1);
    registerSharedOperationFamilies(other, { cells: html => fromHtml(html) });
    assert.equal(applySharedUpdate(other, encodeSharedState(parts.handle)).ok, true);
    writerControls().openWriter();
    assert.equal(typeAtEnd("r1", "x"), true);
    remoteAt(other, "r1", "Y", 2);
    assert.equal(applySharedUpdate(parts.handle, encodeSharedState(other)).ok, true);
    assert.equal(audio(), merged);
    beat("r1").dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(audio(), "abY");
    assert.deepEqual(writerControls().writerFlowControl().selection(), caretAt(beatPos("r1", caret)));
  } finally {
    destroySharedDocument(other);
    assert.deepEqual(leaveSharedSession(ports), { ok: true });
  }
});

test("shared Writer visual typing undo reopens the visual box and restores its caret", async () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ rows: [{ id: "r1", audioText: "Hello", visualText: "ab", status: "todo" }] }));
  undoOwner().flush();
  assert.deepEqual(await enterSharedSession(ports), { ok: true });
  try {
    writerControls().openWriter();
    writerControls().writerFlowControl().openVisual("r1");
    const cell = document.querySelector(".wr-flow-visual-text");
    assert.equal(typeIn(cell, cell, "x"), true);
    assert.equal(cell.textContent, "abx");
    cell.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    const box = document.querySelector(".wr-flow-visual-box");
    assert.equal(currentDocument().rows[0].visualText, "ab");
    assert.equal(box.hidden, false);
    assert.equal(document.activeElement, cell);
    assert.deepEqual(cellSelection(cell), { from: 2, to: 2 });
  } finally { assert.deepEqual(leaveSharedSession(ports), { ok: true }); }
});

test("an already open Writer enters shared mode, keeps its caret, types, receives remote text, undoes and leaves", async () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Open Writer", rows: [{ id: "r1", audioText: "Hello", visualText: "", status: "todo" }] }));
  undoOwner().flush();
  writerControls().openWriter();
  writerControls().writerFlowControl().place(caretAt(beatPos("r1", 3)));
  assert.deepEqual(await enterSharedSession(ports), { ok: true });
  assert.equal(document.getElementById("writer").hidden, false);
  assert.equal(beat("r1").textContent, "Hello");
  assert.deepEqual(writerControls().writerFlowControl().selection(), caretAt(beatPos("r1", 3)));
  const parts = sharedSessionParts(), other = createSharedDocument();
  try {
    registerSharedOperationFamilies(other, { cells: html => fromHtml(html) });
    assert.equal(applySharedUpdate(other, encodeSharedState(parts.handle)).ok, true);
    assert.equal(typeAtEnd("r1", "x"), true);
    remoteAtStart(other, "r1", "Y");
    assert.equal(applySharedUpdate(parts.handle, encodeSharedState(other)).ok, true);
    assert.deepEqual([audio(), beat("r1").textContent], ["YHellox", "YHellox"]);
    beat("r1").dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual([audio(), beat("r1").textContent], ["YHello", "YHello"]);
    assert.deepEqual(writerControls().writerFlowControl().selection(), caretAt(beatPos("r1", 6)));
    assert.deepEqual(leaveSharedSession(ports), { ok: true });
    assert.equal(document.getElementById("writer").hidden, false);
    assert.deepEqual([sharedSession(), audio(), errors, reports], [false, "YHello", [], []]);
  } finally { destroySharedDocument(other); }
});

test("failed entry before hydration restores the open standalone Writer and permits another entry", async () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ rows: [{ id: "r1", audioText: "Hello", visualText: "", status: "todo" }] }));
  undoOwner().flush();
  writerControls().openWriter();
  writerControls().writerFlowControl().place(caretAt(beatPos("r1", 3)));
  const fault = new Error("binding entry failed"), faults = [];
  const failedPorts = { ...ports, report: error => { faults.push(error); }, bindings: { ...ports.bindings,
    enter: parts => { ports.bindings.enter(parts); throw fault; } } };
  assert.deepEqual(await enterSharedSession(failedPorts), { ok: false, reason: "enter-failed" });
  assert.deepEqual(faults, [fault]);
  assert.equal(sharedSession(), false);
  assert.equal(document.getElementById("writer").hidden, false);
  assert.equal(beat("r1").textContent, "Hello");
  assert.deepEqual(writerControls().writerFlowControl().selection(), caretAt(beatPos("r1", 3)));
  assert.deepEqual(await enterSharedSession(ports), { ok: true });
  assert.deepEqual(leaveSharedSession(ports), { ok: true });
  assert.deepEqual([errors, reports], [[], []]);
});

for (const registration of ["onReplaced", "onChange"]) {
  test(`failed ${registration} registration releases reopen listeners and cannot restore a stale caret on retry`, async () => {
    writerControls().closeWriter();
    adoptReplacement(migrateRows({ rows: [{ id: "r1", audioText: "Hello", visualText: "", status: "todo" }] }));
    undoOwner().flush();
    writerControls().openWriter();
    writerControls().writerFlowControl().place(caretAt(beatPos("r1", 3)));
    const original = { onChange: documentReader.onChange, onReplaced: documentReader.onReplaced };
    const listeners = { onChange: 0, onReplaced: 0 }, faults = [], releases = [], fault = new Error("registration failed");
    const switched = { ...ports, report: error => { faults.push(error); } };
    let fail = registration, abandoned = null;
    for (const name of ["onChange", "onReplaced"]) {
      documentReader[name] = listener => {
        if (fail === name) { fail = null; throw fault; }
        if (name === "onChange" && !abandoned) abandoned = listener;
        const off = original[name]((...args) => {
          if (abandoned !== listener) abandoned?.(...args);
          listener(...args);
        });
        listeners[name]++;
        let active = true;
        const release = () => { if (active) { active = false; listeners[name]--; off(); } };
        releases.push(release);
        return release;
      };
    }
    try {
      assert.deepEqual(await enterSharedSession(switched), { ok: false, reason: "enter-failed" });
      assert.deepEqual(faults, [fault]);
      assert.deepEqual({ ...listeners }, { onChange: 0, onReplaced: 0 });
      writerControls().writerFlowControl().place(caretAt(beatPos("r1", 1)));
      assert.deepEqual(await enterSharedSession(switched), { ok: true });
      assert.deepEqual(writerControls().writerFlowControl().selection(), caretAt(beatPos("r1", 1)));
      abandoned?.();
      assert.deepEqual(writerControls().writerFlowControl().selection(), caretAt(beatPos("r1", 1)));
      assert.deepEqual({ ...listeners }, { onChange: 0, onReplaced: 0 });
      assert.deepEqual(leaveSharedSession(switched), { ok: true });
      assert.deepEqual({ ...listeners }, { onChange: 0, onReplaced: 0 });
    } finally {
      if (sharedSession()) leaveSharedSession(switched);
      releases.forEach(release => { release(); });
      Object.assign(documentReader, original);
    }
  });
}
