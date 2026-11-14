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
const { executeSharedOperations } = await import("../adapters/collab/execute.ts");
const { registerSharedOperationFamilies } = await import("../adapters/collab/operation-families.ts");
const { readSharedPaintedText } = await import("../adapters/collab/paint-base.ts");
const { sharedBufferedTarget } = await import("../adapters/collab/buffer.ts");
const { readOperation } = await import("../core/collab/read-operation.ts");
const { beatPos, caretAt } = await import("../core/flow/flow.ts");

after(closeApp);

const ALLOWED = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
const reports = [], recovered = [], missing = [], errors = [];
let ids = 0;
const ports = {
  refusal: () => null,
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
  const target = sharedBufferedTarget(other, rowId), painted = readSharedPaintedText(other, target);
  assert.ok(painted);
  const operation = readOperation({ kind: "text-insert", id: "bob" + text, by: "Bob", target, at: { left: null, right: painted.identity(0), affinity: "before" },
    content: [{ value: text, marks: [] }] });
  assert.ok(operation);
  assert.deepEqual(executeSharedOperations(other, [operation]), { ok: true });
}

const audio = () => currentDocument()?.rows[0]?.audioText;

test("in the real app, a shared Writer types through the buffers, shows another writer's text, and Ctrl+Z takes back only its own typing", async () => {
  adoptReplacement(migrateRows({ title: "Shared Writer", rows: [{ id: "r1", audioText: "Hello", visualText: "", status: "todo" }] }));
  undoOwner().flush();
  assert.deepEqual(await enterSharedSession(ports), { ok: true });
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
