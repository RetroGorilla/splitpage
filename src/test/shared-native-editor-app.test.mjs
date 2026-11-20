import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { adoptReplacement, currentCapabilities, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { createSharedDocument, destroySharedDocument, encodeSharedState } from "../adapters/collab/document.ts";
import { hydrateSharedDocument } from "../adapters/collab/hydrate.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { scriptCellOf, sanitizeHtml } from "../bootstrap/richtext.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { cellEditing } from "../bootstrap/wiring/editor-owners.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { handleImageFile, removeImage } from "../bootstrap/wiring/rows.ts";
import { actions } from "../bootstrap/wiring/ports/actions.ts";

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
  visual.focus();
  setCellSelection(visual, 2);
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

function nativeBytes(doc, join, change) {
  const native = openNativeSession({ kind: "document", document: doc, conversion: {
    cells: scriptCellOf, creation: doc.docId, at: "2026-11-20", by: "Writer"
  } }, { actor: "Writer", sanitize: sanitizeHtml });
  try {
    if (join !== undefined) assert.equal(native.commands.joinRow("r2", "r1", join).kind, "written");
    change?.(native.ydoc);
    return native.encodeState();
  } finally { native.close(); }
}

test("cross-format stored entry refuses in both directions and retains the four original beats", async () => {
  const doc = migrateRows({ title: "Formats", rows: ["one", "two", "three", "four"].map((audioText, index) => ({ id: "r" + index, audioText })) });
  adoptReplacement(doc);
  const old = createSharedDocument();
  try {
    hydrateSharedDocument(old, doc);
    for (const [bytes, options] of [[encodeSharedState(old), { backend: "native" }], [nativeBytes(doc), undefined]]) {
      assert.deepEqual(await hook.enterFrom(bytes, options), { ok: false, reason: "enter-failed" });
      assert.equal(sharedSession(), false);
      assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["one", "two", "three", "four"]);
    }
    const malformed = nativeBytes(doc, undefined, ydoc => {
      const segments = ydoc.getMap("segments");
      for (const name of segments.keys()) segments.delete(name);
    });
    assert.deepEqual(await hook.enterFrom(malformed, { backend: "native" }), { ok: false, reason: "enter-failed" });
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["one", "two", "three", "four"]);
  } finally { destroySharedDocument(old); }
});

for (const [glue, at, expected] of [[" ", 8, "Hello WoXrld"], [" ", 5, "HelloX World"], [" ", 6, "Hello XWorld"], ["--", 6, "Hello--World"]]) {
  test("joined narration caret with glue " + JSON.stringify(glue) + " at offset " + at, async t => {
    const doc = migrateRows({ title: "Join", rows: [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }] });
    adoptReplacement(doc);
    const show = t.mock.method(notices, "show", () => {});
    assert.deepEqual(await hook.enterFrom(nativeBytes(doc, glue), { backend: "native" }), { ok: true });
    t.after(() => { if (sharedSession()) hook.leave(); });
    const target = cell("audioText");
    target.focus();
    setCellSelection(target, at);
    assert.equal(beforeInput(target, "insertText", "X"), true);
    await Promise.resolve();
    assert.equal(text(), expected);
    assert.equal(hook.read().peer.rows[0].audioText, expected);
    assert.equal(show.mock.callCount(), glue === "--" ? 1 : 0);
  });
}

test("two keys against one paint accept only the first and restore its caret", async t => {
  const show = await enter(t), target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(beforeInput(target, "insertText", "y"), true);
  assert.equal(show.mock.callCount(), 1);
  await Promise.resolve();
  assert.equal(text(), "Hexllo");
  assert.equal(hook.read().peer.rows[0].audioText, "Hexllo");
  assert.deepEqual(cellSelection(cell("audioText")), { from: 3, to: 3 });
  cell("audioText").blur();
  assert.equal(show.mock.callCount(), 1, "an ordinary blur cannot add a warning");
});

test("coalesced peer insertion preserves both edits while the caret stays before the typed letter", async t => {
  await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
  await Promise.resolve();
  assert.equal(text(), "YHexllo");
  assert.equal(hook.read().peer.rows[0].audioText, "YHexllo");
  assert.deepEqual(cellSelection(cell("audioText")), { from: 3, to: 3 });
});

test("publication restores the native caret when the former cell has been detached", async t => {
  await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  target.closest(".row").remove();
  await Promise.resolve();
  assert.equal(document.activeElement, cell("audioText"));
  assert.deepEqual(cellSelection(cell("audioText")), { from: 3, to: 3 });
});

test("native input honors edit permission", async t => {
  adoptReplacement(migrateRows({ title: "Locked", rows: [{ id: "r1", audioText: "Hello" }] }),
    createSessionCapabilities("standalone", { edit: () => ({ allowed: false, reason: "locked" }), comment: () => ({ allowed: true }) }));
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enter({ backend: "native" }), { ok: true });
  t.after(() => {
    if (sharedSession()) hook.leave();
    adoptReplacement(migrateRows({ title: "Unlocked", rows: [{ id: "r1", audioText: "Hello" }] }),
      createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) }));
  });
  const locked = cell("audioText");
  locked.setAttribute("contenteditable", "true");
  locked.focus();
  setCellSelection(locked, 2);
  assert.equal(currentCapabilities().edit().allowed, false);
  assert.equal(beforeInput(locked, "insertText", "x"), true);
  await Promise.resolve();
  assert.equal(text(), "Hello");
  assert.equal(show.mock.callCount(), 1);
});

test("native input refuses invalid target ranges, empty data and uncancelable intent", async t => {
  const show = await enter(t), target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  const range = document.createRange();
  range.setStart(target.firstChild, 1);
  range.setEnd(target.firstChild, 3);
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "x" });
  Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  assert.equal(target.dispatchEvent(event), false);
  assert.equal(beforeInput(target, "insertText", ""), true);
  assert.equal(beforeInput(target, "insertText", "x", { cancelable: false }), false);
  await Promise.resolve();
  assert.equal(text(), "Hello");
  assert.equal(show.mock.callCount(), 3);
});

test("Writer opening and rejected native DOM input restore narration and visual models", async t => {
  const show = await enter(t), control = writerControls();
  const before = hook.read();
  control.openWriter();
  t.after(control.closeWriter);
  assert.ok(control.writerFlowControl());
  const root = document.getElementById("writer-doc"), narration = root.querySelector('[data-id="r1"]');
  control.writerFlowControl().openVisual("r1");
  const visual = document.querySelector(".wr-flow-visual-text");
  for (const [surface, leaf, expected] of [[root, narration, "Hello"], [visual, visual, "Look"]]) {
    const warned = show.mock.callCount();
    leaf.textContent = "browser changed this";
    surface.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: "x", bubbles: true }));
    assert.equal(leaf.textContent, expected);
    assert.equal(show.mock.callCount(), warned + 1);
  }
  assert.deepEqual(hook.read(), before);
});

test("Split reconciles browser input, refuses visual background drop, and restores the original listeners on leave", async t => {
  const show = await enter(t), target = cell("visualText");
  target.textContent = "browser changed this";
  target.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  assert.equal(target.textContent, "Look");
  const drop = new window.Event("drop", { bubbles: true, cancelable: true });
  assert.equal(target.closest(".visual-cell").dispatchEvent(drop), false);
  assert.equal(show.mock.callCount(), 2);
  assert.deepEqual(hook.leave(), { ok: true });
  assert.equal(beforeInput(cell("audioText"), "insertText", "x"), false);
});

test("gallery add, remove, reorder and annotation refuse before writing", async t => {
  const show = await enter(t), before = hook.read();
  handleImageFile("r1", new window.File(["picture"], "picture.png", { type: "image/png" }));
  removeImage("r1", 0);
  actions.invoke("annotate-picture", "button", { rowId: "r1", slot: 0 });
  const change = t.mock.fn(() => { throw new Error("gallery plan ran"); });
  for (const route of ["Reorder pictures", "Annotate picture"]) {
    assert.deepEqual(cellEditing().editGallery("r1", route, change), { changed: false, held: true });
  }
  assert.equal(change.mock.callCount(), 0);
  assert.equal(show.mock.callCount(), 5);
  assert.deepEqual(hook.read(), before);
});
