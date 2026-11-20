import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { adoptReplacement, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const cell = field => document.querySelector('#rows .cell-editable[data-id="r1"][data-field="' + field + '"]');
const text = () => hook.read().app.rows[0].audioText;
function beforeInput(target, inputType, data, extra = {}) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data, ...extra });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

async function enter(t) {
  adoptReplacement(migrateRows({ title: "Native script", rows: [{ id: "r1", audioText: "Hello", visualText: "Look" }] }));
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enter({ backend: "native" }), { ok: true });
  t.after(() => { if (sharedSession()) hook.leave(); });
  return show;
}

test("a caret on the old paint is refused while a peer update is waiting to publish", async t => {
  const show = await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
  assert.equal(text(), "Hello");
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(show.mock.callCount(), 1);
  await Promise.resolve();
  assert.equal(cell("audioText").textContent, "YHello");
  assert.equal(text(), "YHello");
  assert.equal(hook.read().peer.rows[0].audioText, "YHello");
});

test("only plain narration insertText at a caret reaches the native text command", async t => {
  const show = await enter(t), target = cell("audioText"), visual = cell("visualText"), title = document.getElementById("doc-title");
  const before = hook.read();
  target.focus();
  setCellSelection(target, 1, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x", { isComposing: true }), true);
  assert.equal(beforeInput(target, "insertFromPaste", "x"), true);
  assert.equal(beforeInput(target, "deleteContentBackward", null), true);
  assert.equal(beforeInput(visual, "insertText", "x"), true);
  assert.equal(beforeInput(title, "insertText", "x"), true);
  await Promise.resolve();
  assert.deepEqual(hook.read(), before);
  assert.equal(show.mock.callCount(), 6);
  for (const call of show.mock.calls) assert.deepEqual(call.arguments, ["This is not available in a shared session yet.", "warn"]);
});

test("leave captures native text even if the changed event has not run", async t => {
  await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(text(), "Hello");
  assert.deepEqual(hook.leave(), { ok: true });
  assert.equal(text(), "Hexllo");
  await Promise.resolve();
  assert.equal(hook.read().peer, null);
  assert.equal(cell("audioText").textContent, "Hexllo");
});

test("entry admission stops insertText while the first native snapshot is being delivered", async t => {
  let attempted = false;
  const release = onSessionChange(change => {
    if (!sharedSession() || change.kind !== "adopt") return;
    const target = cell("audioText");
    target.focus();
    setCellSelection(target, 2);
    attempted = beforeInput(target, "insertText", "x");
  });
  t.after(release);
  const show = await enter(t);
  assert.equal(attempted, true);
  assert.equal(text(), "Hello");
  assert.equal(show.mock.callCount(), 1);
});

test("a cell without the painted row signature cannot supply a native caret", async t => {
  const show = await enter(t), replacement = cell("audioText").closest(".row").cloneNode(true);
  cell("audioText").closest(".row").replaceWith(replacement);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  await Promise.resolve();
  assert.equal(text(), "Hello");
  assert.equal(show.mock.callCount(), 1);
});
