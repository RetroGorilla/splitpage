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
import { mountNativeSharedInput } from "../bootstrap/wiring/native-shared-input.ts";
import { setBeatLength } from "../features/rows/read-time.ts";
import { setBeatFilmed } from "../bootstrap/wiring/beat-status.ts";
import { openCommentsPanel } from "../features/comments/comments.ts";
import { addGalleryPicture, moveGallerySlot, replaceGalleryPicture } from "../core/document/gallery.ts";
import { enterSharedSession, forceLeaveSharedSession, nativeEditorRecords } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";
import { setTimeout as delay } from "node:timers/promises";
import { Doc, encodeStateAsUpdate } from "yjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const cell = field => document.querySelector('#rows .cell-editable[data-id="r1"][data-field="' + field + '"]');
const text = () => hook.read().app.rows[0].audioText;
const flushed = () => delay(55);
function cleanSession() {
  if (!sharedSession() || hook.leave().ok) return;
  forceLeaveSharedSession();
  const allowed = () => ({ allowed: true });
  adoptReplacement(migrateRows({ title: "Standby", rows: [] }),
    createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
}
function beforeInput(target, inputType, data, extra = {}) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data, ...extra });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function deleteRange(target, from, to, direction = "Backward") {
  const range = document.createRange();
  range.setStart(target.firstChild, from);
  range.setEnd(target.firstChild, to);
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContent" + direction });
  Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function bound(run) {
  return Object.assign((...args) => run(...args), { withSelection: (_before, ...args) => ({ result: run(...args), recordAfter() {} }) });
}

function compose(target, type, data) {
  const event = new window.CompositionEvent("composition" + type, { bubbles: true, cancelable: true, data });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

async function enter(t, rows = [{ id: "r1", audioText: "Hello", visualText: "Look" }]) {
  adoptReplacement(migrateRows({ schema: 2, title: "Native script", rows }));
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enter({ backend: "native" }), { ok: true });
  t.after(cleanSession);
  return show;
}

test("a caret on the old paint is refused and the editor retains the uncommitted typing", async t => {
  const show = await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
  assert.equal(text(), "Hello");
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(show.mock.callCount(), 1);
  await Promise.resolve();
  assert.equal(cell("audioText").textContent, "Hexllo");
  assert.equal(text(), "Hello");
  assert.equal(hook.read().peer.rows[0].audioText, "YHello");
  assert.deepEqual(hook.leave(), { ok: false, reason: "native-selection-stale" });
});

test("out-of-scope input stays refused on the native path", async t => {
  const show = await enter(t), target = cell("audioText"), visual = cell("visualText"), title = document.getElementById("doc-title");
  const before = hook.read();
  target.focus();
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
  assert.equal(show.mock.callCount(), 5);
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

function nativeBytes(doc, join, change, command = () => {}) {
  const native = openNativeSession({ kind: "document", document: doc, conversion: {
    cells: scriptCellOf, creation: doc.docId, at: "2026-11-20", by: "Writer"
  } }, { actor: "Writer", sanitize: sanitizeHtml });
  try {
    if (join !== undefined) assert.equal(native.commands.joinRow("r2", "r1", join).kind, "written");
    command(native);
    change?.(native.ydoc);
    return native.encodeState();
  } finally { native.close(); }
}

for (const [members, offset, beat, at, expected] of [
  [["", "World"], 0, "r2", 0, "XWorld"],
  [["Hello", ""], 5, "r1", 5, "HelloX"],
  [["Hello", "", "World"], 6, "r3", 0, "Hello XWorld"]
]) test("typing skips empty joined narration members " + JSON.stringify(members), async t => {
  const doc = migrateRows({ title: "Join", rows: members.map((audioText, i) => ({ id: "r" + (i + 1), audioText })) });
  const join = session => {
    for (let i = 2; i <= members.length; i++) assert.equal(session.commands.joinRow("r" + i, "r" + (i - 1), " ").kind, "written");
  };
  const bytes = nativeBytes(doc, undefined, undefined, join);
  const expectedBytes = nativeBytes(doc, undefined, undefined, session => {
    join(session);
    const anchor = session.commands.anchorText({ beat, cell: "narration" }, at);
    assert.equal(anchor.kind, "anchored");
    assert.equal(session.commands.typeText(anchor.range, "X", {}).kind, "written");
  });
  const oracle = openNativeSession({ kind: "state", state: expectedBytes }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(oracle.close);
  assert.equal(oracle.document().rows[0].audioText, expected);
  adoptReplacement(doc);
  assert.deepEqual(await hook.enterFrom(bytes, { backend: "native" }), { ok: true });
  t.after(() => { if (sharedSession()) hook.leave(); });
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, offset);
  assert.equal(beforeInput(target, "insertText", "X"), true);
  await flushed();
  assert.equal(text(), expected);
  assert.equal(hook.read().peer.rows[0].audioText, expected);
});

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

for (const [field, breakField] of [
  ["version", ydoc => ydoc.getMap("meta").set("format", 999)],
  ["title", ydoc => ydoc.getMap("meta").delete("title")],
  ["births", ydoc => ydoc.getMap("births").clear()],
  ["document ID", ydoc => ydoc.getMap("meta").delete("docId")]
]) test("native stored entry requires " + field, async () => {
  const doc = migrateRows({ title: "Native script", rows: [{ id: "r1", audioText: "Hello" }] });
  adoptReplacement(doc);
  const broken = nativeBytes(doc, undefined, breakField);
  assert.deepEqual(await hook.enterFrom(broken, { backend: "native" }), { ok: false, reason: "enter-failed" });
  assert.equal(sharedSession(), false);
  assert.equal(text(), "Hello");
});

for (const [glue, at, expected] of [[" ", 8, "Hello WoXrld"], [" ", 5, "HelloX World"], [" ", 6, "Hello XWorld"], ["--", 6, "Hello--World"]]) {
  test("joined narration caret with glue " + JSON.stringify(glue) + " at offset " + at, async t => {
    const doc = migrateRows({ title: "Join", rows: [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }] });
    adoptReplacement(doc);
    const show = t.mock.method(notices, "show", () => {});
    assert.deepEqual(await hook.enterFrom(nativeBytes(doc, glue), { backend: "native" }), { ok: true });
    t.after(cleanSession);
    const target = cell("audioText");
    target.focus();
    setCellSelection(target, at);
    assert.equal(beforeInput(target, "insertText", "X"), true);
    await flushed();
    assert.equal(text(), expected);
    assert.equal(hook.read().peer.rows[0].audioText, expected);
    assert.equal(show.mock.callCount(), glue === "--" ? 1 : 0);
  });
}

test("200 keys buffer against one paint without losing any keys or the caret", async t => {
  const show = await enter(t), target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  const keys = "0123456789".repeat(20);
  for (const key of keys) assert.equal(beforeInput(target, "insertText", key), true);
  const expected = "He" + keys + "llo";
  assert.equal(text(), "Hello");
  assert.equal(target.textContent, expected);
  await flushed();
  assert.equal(text(), expected);
  assert.equal(hook.read().peer.rows[0].audioText, expected);
  assert.deepEqual(cellSelection(cell("audioText")), { from: 202, to: 202 });
  cell("audioText").blur();
  assert.equal(show.mock.callCount(), 0, "an ordinary blur cannot add a warning");
});

test("a peer insertion during typing keeps both edits and the caret follows the typed letters", async t => {
  await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
  await Promise.resolve();
  assert.equal(target.textContent, "Hexllo");
  assert.equal(beforeInput(target, "insertText", "z"), true);
  await flushed();
  assert.equal(text(), "YHexzllo");
  assert.equal(hook.read().peer.rows[0].audioText, "YHexzllo");
  assert.deepEqual(cellSelection(cell("audioText")), { from: 5, to: 5 });
});

for (const [name, from, to, expected, caret, next] of [
  ["around the caret", 1, 4, "Hxzo", 3, "Hxz!o"],
  ["all text", 0, 5, "xz", 2, "xz!"],
  ["before the caret", 0, 2, "xzllo", 2, "xz!llo"],
  ["after the caret", 2, 4, "Hexzo", 4, "Hexz!o"]
]) test("the inserted caret survives a peer deleting " + name, async t => {
  await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(hook.nativePeer.delete("r1", from, to).kind, "written");
  await Promise.resolve();
  assert.equal(beforeInput(target, "insertText", "z"), true);
  await flushed();
  assert.equal(text(), expected);
  assert.equal(hook.read().peer.rows[0].audioText, expected);
  assert.deepEqual(cellSelection(cell("audioText")), { from: caret, to: caret });
  assert.equal(beforeInput(cell("audioText"), "insertText", "!"), true);
  await flushed();
  assert.equal(text(), next);
  assert.equal(hook.read().peer.rows[0].audioText, next);
});

for (const [from, to, direction, expected] of [[1, 3, "Backward", "PHllo"], [2, 4, "Forward", "PHelo"], [3, 4, "Forward", "PHexlo"]]) {
  test("held " + direction + " deletion rebases both ends " + from + "–" + to, async t => {
    const show = await enter(t), target = cell("audioText");
    target.focus();
    setCellSelection(target, 2);
    assert.equal(beforeInput(target, "insertText", "x"), true);
    assert.equal(hook.nativePeer.type("r1", 0, "P").kind, "written");
    await Promise.resolve();
    assert.equal(deleteRange(target, from, to, direction), true);
    await flushed();
    assert.equal(text(), expected);
    assert.equal(hook.read().peer.rows[0].audioText, expected);
    assert.equal(cell("audioText").textContent, expected);
    assert.equal(show.mock.callCount(), 0);
  });
}

for (const [glue, from, to, expected] of [
  ["", 3, 5, "HelXWorld"], ["", 5, 7, "HelloXrld"], [" ", 3, 5, "HelX World"], [" ", 6, 8, "Hello Xrld"]
]) test("a joined narration selection may touch its own seam " + JSON.stringify([glue, from, to]), async t => {
  const doc = migrateRows({ title: "Join", rows: [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }] });
  adoptReplacement(doc);
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enterFrom(nativeBytes(doc, glue), { backend: "native" }), { ok: true });
  t.after(cleanSession);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, from, to);
  assert.equal(beforeInput(target, "insertText", "X"), true);
  await flushed();
  assert.equal(text(), expected);
  assert.equal(hook.read().peer.rows[0].audioText, expected);
  assert.deepEqual(cellSelection(cell("audioText")), { from: from + 1, to: from + 1 });
  assert.equal(show.mock.callCount(), 0);
});

test("typing replaces a selection and keeps the caret after the replacement", async t => {
  await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 1, 3);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  await flushed();
  assert.equal(text(), "Hxlo");
  assert.deepEqual(cellSelection(cell("audioText")), { from: 2, to: 2 });
});

test("native narration replacement cannot edit a protected production tag", async t => {
  const tagged = 'A <span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">Mug</span> B';
  const show = await enter(t, [{ id: "r1", audioText: tagged }]);
  const target = cell("audioText"), before = text();
  assert.ok(target.querySelector('.tag-anchor[contenteditable="false"]'), target.innerHTML);
  target.focus();
  setCellSelection(target, 1, 6);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(compose(target, "start", ""), true);
  await flushed();
  assert.equal(target.textContent, "A Mug B");
  assert.equal(text(), before);
  assert.equal(hook.read().peer.rows[0].audioText, before);
  assert.equal(show.mock.callCount(), 2);
});

test("a selection across joined members stays visible as a refused edit", async t => {
  const doc = migrateRows({ title: "Join", rows: [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }] });
  adoptReplacement(doc);
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enterFrom(nativeBytes(doc, " "), { backend: "native" }), { ok: true });
  t.after(cleanSession);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 4, 7);
  assert.equal(beforeInput(target, "insertText", "X"), true);
  await flushed();
  assert.equal(target.textContent, "HellXorld");
  assert.equal(text(), "Hello World");
  assert.equal(hook.read().peer.rows[0].audioText, "Hello World");
  assert.equal(show.mock.callCount(), 1);
  assert.deepEqual(hook.leave(), { ok: false, reason: "native-selection-stale" });
});

test("typing then deleting the buffered letter is unchanged and publishes no edit", async t => {
  const show = await enter(t);
  const seen = t.mock.fn();
  t.after(onSessionChange(seen));
  const target = cell("audioText");
  const original = target.firstChild;
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(deleteRange(target, 2, 3), true);
  await flushed();
  assert.equal(text(), "Hello");
  assert.equal(hook.read().peer.rows[0].audioText, "Hello");
  assert.equal(target.textContent, "Hello");
  assert.notEqual(target.firstChild, original);
  assert.deepEqual(cellSelection(target), { from: 2, to: 2 });
  assert.equal(seen.mock.callCount(), 0);
  assert.equal(show.mock.callCount(), 0);
});

for (const cleared of [false, true]) test("blur ends an open composition before the next beat accepts input in the same turn, cleared=" + cleared, async t => {
  await enter(t, [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }]);
  const first = cell("audioText"), second = document.querySelector('#rows .cell-editable[data-id="r2"][data-field="audioText"]');
  first.focus();
  setCellSelection(first, 2);
  assert.equal(compose(first, "start", ""), false);
  assert.equal(compose(second, "end", "Q"), false);
  assert.equal(text(), "Hello");
  assert.equal(compose(first, "update", "K"), false);
  first.firstChild.insertData(2, "K");
  first.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
  if (cleared) {
    first.firstChild.deleteData(2, 1);
    first.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "deleteCompositionText", isComposing: true }));
  }
  second.focus();
  setCellSelection(second, 2);
  assert.equal(beforeInput(second, "insertText", "Z"), true);
  await flushed();
  const expected = [cleared ? "Hello" : "HeKllo", "WoZrld"];
  for (const copy of [hook.read().app, hook.read().peer]) assert.deepEqual(copy.rows.map(row => row.audioText), expected);
  assert.equal(document.activeElement, second);
  assert.deepEqual(cellSelection(second), { from: 3, to: 3 });
  assert.deepEqual(hook.leave(), { ok: true });
});

test("IME admission refuses a held editor and composition blocks non-IME input", async t => {
  const { native, binding, target, refused } = await openDirect(t);
  const release = binding.hold("composition-held");
  t.after(release);
  assert.equal(compose(target, "start", ""), true);
  release();
  assert.equal(compose(target, "start", ""), false);
  assert.equal(beforeInput(target, "insertParagraph", null), true);
  assert.equal(compose(target, "end", ""), false);
  assert.equal(native.narrationHtml("R1"), "Captured words");
  assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["composition-held"], ["native-input-unavailable"]]);
});

test("an unexpected browser input does not reset a buffered draft", async t => {
  const show = await enter(t), target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  target.firstChild.insertData(3, "?");
  target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "?" }));
  await flushed();
  assert.equal(target.textContent, "Hex?llo");
  assert.equal(text(), "Hello");
  assert.equal(show.mock.callCount(), 1);
  assert.deepEqual(hook.leave(), { ok: false, reason: "native-input-pending" });
});

test("narration input refuses target ranges outside the cell or without an editor selection", async t => {
  const show = await enter(t), target = cell("audioText"), other = cell("visualText");
  target.focus();
  setCellSelection(target, 2);
  const range = document.createRange();
  range.setStart(other.firstChild, 0);
  range.setEnd(other.firstChild, 1);
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentForward" });
  Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  assert.equal(target.dispatchEvent(event), false);
  window.getSelection().removeAllRanges();
  assert.equal(deleteRange(target, 1, 2), true);
  await flushed();
  assert.equal(text(), "Hello");
  assert.equal(target.textContent, "Hello");
  assert.equal(show.mock.callCount(), 2);
});

test("composition can begin at the end of a buffered key without repainting the cell", async t => {
  await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(compose(target, "start", ""), false);
  target.firstChild.insertData(3, "e");
  target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: "e" }));
  assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
  await flushed();
  assert.equal(cell("audioText"), target);
  assert.equal(target.textContent, "Hexello");
  assert.equal(hook.read().peer.rows[0].audioText, "YHello");
  assert.equal(compose(target, "end", "\u00e9"), false);
  await Promise.resolve();
  assert.equal(text(), "YHex\u00e9llo");
  assert.equal(hook.read().peer.rows[0].audioText, "YHex\u00e9llo");
  assert.deepEqual(cellSelection(cell("audioText")), { from: 5, to: 5 });
});

for (const committed of [true, false]) test("composition shields the DOM and " + (committed ? "commits once" : "cancels without writing"), async t => {
  const show = await enter(t), target = cell("audioText");
  target.focus();
  setCellSelection(target, 1, 3);
  for (const key of ["Enter", "Backspace", "Escape", "ArrowLeft"]) {
    const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, keyCode: 229 });
    assert.equal(target.dispatchEvent(event), true);
  }
  assert.equal(beforeInput(target, "insertParagraph", null), true);
  assert.equal(show.mock.callCount(), 1);
  assert.equal(compose(target, "start", ""), false);
  for (const key of ["Enter", "Backspace", "Escape", "ArrowLeft"]) for (const signal of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...signal });
    assert.equal(target.dispatchEvent(event), key !== "Enter");
  }
  assert.equal(beforeInput(target, "insertCompositionText", "e", { isComposing: true }), false);
  target.firstChild.replaceData(1, 2, "e");
  target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: "e" }));
  assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
  await flushed();
  assert.equal(target.textContent, "Helo");
  assert.equal(text(), "Hello");
  assert.equal(hook.read().peer.rows[0].audioText, "YHello");
  assert.deepEqual(hook.leave(), { ok: false, reason: "native-input-pending" });
  const seen = t.mock.fn();
  t.after(onSessionChange(seen));
  assert.equal(compose(target, "end", committed ? "\u00e9" : ""), false);
  await Promise.resolve();
  const expected = committed ? "YH\u00e9lo" : "YHello";
  assert.equal(text(), expected);
  assert.equal(hook.read().peer.rows[0].audioText, expected);
  assert.equal(cell("audioText").textContent, expected);
  if (committed) assert.deepEqual(cellSelection(cell("audioText")), { from: 3, to: 3 });
  assert.equal(seen.mock.callCount(), 1);
  assert.equal(show.mock.callCount(), 1);
});

test("publication restores the native caret when the former cell has been detached", async t => {
  await enter(t);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  target.closest(".row").remove();
  await flushed();
  assert.equal(document.activeElement, cell("audioText"));
  assert.deepEqual(cellSelection(cell("audioText")), { from: 3, to: 3 });
});

for (const selector of ["#doc-title", '#rows .cell-editable[data-id="r2"][data-field="audioText"]']) {
  test("publication preserves focus moved to " + selector, async t => {
    await enter(t, [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }]);
    const target = cell("audioText"), next = document.querySelector(selector);
    target.focus();
    setCellSelection(target, 2);
    assert.equal(beforeInput(target, "insertText", "x"), true);
    next.focus();
    await flushed();
    assert.equal(text(), "Hexllo");
    assert.equal(document.activeElement, next);
  });
}

for (const [guard, expected] of [
  ["admission failure", "native-input-unavailable"], ["absent selection", "native-selection-stale"],
  ["missing caret target", "native-selection-stale"],
  ["anchor refusal", "range"], ["write recovery", "busy"]
]) test("native input reports " + guard, t => {
  const doc = migrateRows({ title: "Native script", rows: [{ id: "r1", audioText: "Hello" }] });
  adoptReplacement(doc);
  const native = openNativeSession({ kind: "state", state: nativeBytes(doc) }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(native.close);
  const error = new Error("admission failed"), refuse = t.mock.fn(), report = t.mock.fn();
  const anchor = t.mock.fn(guard === "anchor refusal" ? () => ({ kind: "refused", reason: "range" }) : native.commands.anchorText);
  const write = t.mock.fn(() => ({ kind: "recovery", reason: "busy", runs: [] }));
  const input = mountNativeSharedInput({
    native: { ...native, narrationCaret: guard === "missing caret target" ? () => null : native.narrationCaret,
      commands: { ...native.commands, anchorText: anchor, typeText: bound(write) } },
    editAttribution: () => ({ by: "Writer", at: "now" }), report,
    session: { admit: () => guard === "admission failure" ? { kind: "failed", error } : null, refuse, subscribe: () => () => {} }
  });
  t.after(input.dispose);
  const target = cell("audioText");
  t.after(() => { target.textContent = "Hello"; });
  target.focus();
  if (guard === "absent selection") window.getSelection().removeAllRanges(); else setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  input.finish();
  assert.deepEqual(refuse.mock.calls.map(call => call.arguments), [[expected]]);
  assert.deepEqual(report.mock.calls.map(call => call.arguments), guard === "admission failure" ? [[error]] : []);
  assert.equal(anchor.mock.callCount(), ["anchor refusal", "write recovery"].includes(guard) ? 1 : 0);
  assert.equal(write.mock.callCount(), guard === "write recovery" ? 1 : 0);
});

for (const reason of ["text", "future-refusal"]) test("a commit refusal keeps the text and stops on " + reason, t => {
  const doc = migrateRows({ title: "Native script", rows: [{ id: "r1", audioText: "Hello" }] });
  adoptReplacement(doc);
  const native = openNativeSession({ kind: "state", state: nativeBytes(doc) }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(native.close);
  const refuse = t.mock.fn(), publish = t.mock.fn();
  const write = t.mock.fn(() => ({ kind: "recovery", reason, runs: [] }));
  const input = mountNativeSharedInput({
    native: { ...native, commands: { ...native.commands, typeText: bound(write) } },
    editAttribution: () => ({ by: "Writer", at: "now" }), report: assert.fail, publish,
    session: { admit: () => null, refuse, subscribe: () => () => {} }
  });
  t.after(input.dispose);
  const target = cell("audioText");
  t.after(() => { target.textContent = "Hello"; });
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(input.finish(), reason);
  assert.equal(target.textContent, "Hexllo");
  assert.equal(beforeInput(target, "insertText", "z"), true);
  assert.equal(target.textContent, "Hexllo");
  assert.equal(native.narrationHtml("r1"), "Hello");
  assert.deepEqual(refuse.mock.calls.map(call => call.arguments), [[reason], [reason]]);
  assert.equal(publish.mock.callCount(), 0);
  assert.equal(write.mock.callCount(), 1);
});

for (const trigger of ["caret", "mixed deletion"]) test("an unresolved " + trigger + " leaves the editor on the last usable paint", t => {
  const doc = migrateRows({ title: "Native script", rows: [{ id: "r1", audioText: "Hello" }] });
  adoptReplacement(doc);
  const native = openNativeSession({ kind: "state", state: nativeBytes(doc) }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(native.close);
  const target = cell("audioText"), refuse = t.mock.fn();
  t.after(() => { target.textContent = "Hello"; });
  let onPaint;
  const input = mountNativeSharedInput({
    native: { ...native, narrationOffset: () => null }, report: assert.fail, editAttribution: () => ({ by: "Writer", at: "now" }),
    publish: () => { target.textContent = "PHexllo"; setCellSelection(target, 1); onPaint(); },
    session: { admit: () => null, refuse, subscribe: run => { onPaint = run; return () => {}; } }
  });
  t.after(input.dispose);
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  if (trigger === "caret") {
    assert.equal(input.finish(), null);
    assert.deepEqual(cellSelection(target), { from: 1, to: 1 });
    assert.equal(refuse.mock.callCount(), 0);
  } else {
    assert.equal(deleteRange(target, 1, 3), true);
    assert.equal(target.textContent, "Hllo");
    assert.equal(input.finish(), "native-selection-stale");
    assert.deepEqual(refuse.mock.calls.map(call => call.arguments), [["native-selection-stale"]]);
  }
  assert.equal(native.narrationHtml("r1"), "Hexllo");
});

async function openDirect(t) {
  const fixture = entrySwitchFixture(), refused = t.mock.fn();
  const ports = { ...fixture.ports, commandRefused: refused };
  let native, backend, binding;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    backend = opened.backend;
    return { ...opened.backend, bind: session => { binding = session; opened.backend.bind(session); } };
  }), { ok: true });
  t.after(cleanSession);
  const target = document.querySelector('#rows .cell-editable[data-id="R1"][data-field="audioText"]');
  target.focus();
  setCellSelection(target, 8);
  return { native, backend, binding, refused, errors: fixture.errors, target };
}

test("a buffered write publishes once even when the native changed event follows", async t => {
  const { backend, target } = await openDirect(t);
  const before = backend.replica.revision();
  assert.equal(beforeInput(target, "insertText", "!"), true);
  await flushed();
  assert.equal(text(), "Captured! words");
  assert.equal(backend.replica.revision(), before + 1);
});

for (const trigger of ["pagehide", "hidden", "blur", "pointer", "navigation", "space", "space first"]) {
  test("the native draft flushes on " + trigger + " without waiting for the batch timer", async t => {
    const { native, target } = await openDirect(t);
    if (trigger === "space first") {
      assert.equal(beforeInput(target, "insertText", " "), true);
      assert.equal(native.narrationHtml("R1"), "Captured  words");
      return;
    }
    assert.equal(beforeInput(target, "insertText", "x"), true);
    assert.equal(native.narrationHtml("R1"), "Captured words");
    if (trigger === "pagehide") window.dispatchEvent(new window.Event("pagehide"));
    if (trigger === "hidden") {
      let hidden = false;
      t.mock.getter(document, "visibilityState", () => hidden ? "hidden" : "visible");
      document.dispatchEvent(new window.Event("visibilitychange"));
      assert.equal(native.narrationHtml("R1"), "Captured words");
      hidden = true;
      document.dispatchEvent(new window.Event("visibilitychange"));
    }
    if (trigger === "blur") { target.blur(); await Promise.resolve(); }
    if (trigger === "pointer") target.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    if (trigger === "navigation") target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    if (trigger === "space") assert.equal(beforeInput(target, "insertText", " "), true);
    const expected = trigger === "space" ? "Capturedx  words" : "Capturedx words";
    assert.equal(native.narrationHtml("R1"), expected);
    assert.equal(text(), expected);
  });
}

test("the character cap commits a long same-turn burst before its timer", async t => {
  const { native, target } = await openDirect(t);
  const keys = "x".repeat(2000);
  for (const key of keys) assert.equal(beforeInput(target, "insertText", key), true);
  assert.equal(native.narrationHtml("R1"), "Captured" + keys.slice(0, 1792) + " words");
  assert.equal(target.textContent, "Captured" + keys + " words");
  await flushed();
  assert.equal(text(), "Captured" + keys + " words");
  assert.deepEqual(cellSelection(target), { from: 2008, to: 2008 });
});

test("the unload guard blocks a refused native flush and keeps its draft", async t => {
  const { native, refused, target } = await openDirect(t);
  assert.equal(beforeInput(target, "insertText", "!"), true);
  const release = native.holdIngress();
  t.after(release);
  const leaving = new window.Event("beforeunload", { cancelable: true });
  assert.equal(window.dispatchEvent(leaving), false);
  assert.equal(leaving.defaultPrevented, true);
  assert.equal(target.textContent, "Captured! words");
  assert.equal(native.narrationHtml("R1"), "Captured words");
  assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["busy"]]);
});

test("requested close announces the retained draft before its timer runs", async t => {
  const { native, refused, target } = await openDirect(t);
  assert.equal(beforeInput(target, "insertText", "!"), true);
  native.close();
  await Promise.resolve();
  assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"]]);
  assert.equal(target.textContent, "Captured! words");
});

for (const reason of ["busy", "closed"]) test("the adapter returns " + reason + " and the buffered text stays visible", async t => {
  const { native, refused, target } = await openDirect(t);
  assert.equal(beforeInput(target, "insertText", "!", {}), true);
  const release = reason === "busy" ? native.holdIngress() : () => {};
  t.after(release);
  if (reason === "closed") native.close();
  assert.deepEqual(hook.leave(), { ok: false, reason });
  assert.equal(target.textContent, "Captured! words");
  assert.equal(text(), "Captured words");
  assert.deepEqual(refused.mock.calls.map(call => call.arguments), [[reason]]);
});

test("a hold that begins after the editor accepts a key prevents the buffered write", async t => {
  const { native, binding, refused, target } = await openDirect(t);
  assert.equal(beforeInput(target, "insertText", "!"), true);
  const release = binding.hold("held-before-flush");
  t.after(release);
  assert.deepEqual(hook.leave(), { ok: false, reason: "held-before-flush" });
  assert.equal(target.textContent, "Captured! words");
  assert.equal(native.narrationHtml("R1"), "Captured words");
  assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["held-before-flush"]]);
});

test("the size event leaves the session active and its full refusal keeps the buffered text", async t => {
  const { native, refused, target } = await openDirect(t), peer = new Doc();
  t.after(() => peer.destroy());
  const events = t.mock.fn();
  t.after(native.subscribe(events));
  assert.equal(beforeInput(target, "insertText", "!"), true);
  peer.getMap("sizeFixture").set("payload", "x".repeat(native.sizeLimits.limit));
  assert.equal(applyNativePeerUpdate(native, encodeStateAsUpdate(peer)), true);
  await Promise.resolve();
  assert.equal(sharedSession(), true);
  assert.equal(native.size, "full");
  assert.deepEqual(events.mock.calls.map(call => call.arguments[0].kind), ["changed", "size"]);
  assert.deepEqual(hook.leave(), { ok: false, reason: "full" });
  assert.equal(target.textContent, "Captured! words");
  assert.equal(native.narrationHtml("R1"), "Captured words");
  assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["full"]]);
});

test("failed close reopens from terminal bytes and settles a queued keystroke into the copy", async t => {
  const show = t.mock.method(notices, "show", () => {});
  const { native, target } = await openDirect(t);
  assert.equal(beforeInput(target, "insertText", "!"), true);
  const anchor = native.commands.anchorText({ beat: "R1", cell: "narration" }, 0);
  native.ydoc.once("afterTransactionCleanup", () => { throw new Error("interrupted cleanup"); });
  assert.throws(() => native.commands.typeText(anchor.range, "Peer: ", {}), /interrupted cleanup/);
  await Promise.resolve();
  assert.equal(sharedSession(), false);
  assert.equal(text(), "Peer: Captured! words");
  assert.match(String(show.mock.calls[0]?.arguments[0]), /kept in a standalone copy/);
});

test("failed close during the buffered write reports an uncertain result without replaying it", async t => {
  const show = t.mock.method(notices, "show", () => {});
  const { native, target, errors } = await openDirect(t);
  assert.equal(beforeInput(target, "insertText", "!"), true);
  native.ydoc.once("afterTransactionCleanup", () => { throw new Error("interrupted cleanup"); });
  assert.deepEqual(hook.leave(), { ok: false, reason: "native-input-pending" });
  await Promise.resolve();
  assert.equal(sharedSession(), true);
  assert.equal(target.textContent, "Captured! words");
  assert.equal(errors[0]?.message, "interrupted cleanup");
  assert.match(String(show.mock.calls[0]?.arguments[0]), /Unsent writing is still in the editor/);
});

for (const scenario of ["open composition", "removed beat"]) test("failed close bytes retain an editor draft for " + scenario, async t => {
  const show = t.mock.method(notices, "show", () => {});
  const { native, target } = await openDirect(t);
  const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, 0);
  if (scenario === "open composition") {
    assert.equal(compose(target, "start", ""), false);
    target.firstChild.insertData(8, "e");
  } else assert.equal(beforeInput(target, "insertText", "!"), true);
  native.ydoc.once("afterTransactionCleanup", () => { throw new Error("interrupted cleanup"); });
  if (scenario === "open composition") assert.throws(() => native.commands.typeText(at.range, "P", {}), /interrupted cleanup/);
  else assert.throws(() => native.commands.removeRows(["R1"]), /interrupted cleanup/);
  await Promise.resolve();
  assert.equal(sharedSession(), true);
  assert.equal(target.textContent, scenario === "open composition" ? "Capturede words" : "Captured! words");
  assert.match(String(show.mock.calls[0]?.arguments[0]), /Unsent writing is still in the editor/);
});

test("a browser-applied title edit restores the title and a toolbar click stops before pending formatting", async t => {
  const show = await enter(t);
  const title = document.getElementById("doc-title");
  title.value = "browser changed this";
  title.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  assert.equal(title.value, "Native script");
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  const bold = target.closest(".audio-cell").querySelector('button[data-cmd="bold"]');
  assert.equal(bold.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })), false);
  assert.equal(show.mock.callCount(), 2);
});

test("leaving Writer narration and visual boxes skips standalone field sync", async t => {
  await enter(t);
  const control = writerControls(), sync = t.mock.method(cellEditing(), "sync", () => {});
  control.openWriter();
  t.after(control.closeWriter);
  const root = document.getElementById("writer-doc");
  root.focus();
  control.writerFlowControl().caret("r1", 2);
  document.dispatchEvent(new window.Event("selectionchange"));
  document.getElementById("writer-title").focus();
  assert.equal(sync.mock.callCount(), 0);
  control.writerFlowControl().openVisual("r1");
  document.querySelector(".wr-flow-visual-close").click();
  assert.equal(sync.mock.callCount(), 0);
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

for (const [name, peerEnd, to, direction, expected] of [
  ["Backspace", 3, 4, "Backward", "Helo"],
  ["Delete", 3, 4, "Forward", "Helo"],
  ["replacement", 3, 4, null, "HeQlo"],
  ["Backspace across both deleted letters", 4, 5, "Backward", "Heo"],
  ["Backspace across one of two deleted letters", 4, 4, "Backward", "Heo"]
]) test("a deleted end still includes pending text in " + name, async t => {
  const show = await enter(t), target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(hook.nativePeer.delete("r1", 2, peerEnd).kind, "written");
  await Promise.resolve();
  assert.equal(target.textContent, "Hexllo");
  if (direction) assert.equal(deleteRange(target, 2, to, direction), true);
  else {
    setCellSelection(target, 2, to);
    assert.equal(beforeInput(target, "insertText", "Q"), true);
  }
  await flushed();
  assert.equal(text(), expected);
  assert.equal(hook.read().peer.rows[0].audioText, expected);
  assert.equal(cell("audioText").textContent, expected);
  assert.equal(show.mock.callCount(), 0);
});

test("the timer leaves a selection made after a pending key alone", async t => {
  const { target } = await openDirect(t);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "a", ctrlKey: true }));
  setCellSelection(target, 0, 15);
  await flushed();
  assert.equal(text(), "Capturedx words");
  assert.deepEqual(cellSelection(target), { from: 0, to: 15 });
});

test("a deletion can cross the caret of an empty draft after a peer edit", async t => {
  const show = await enter(t), target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(deleteRange(target, 2, 3), true);
  assert.equal(hook.nativePeer.type("r1", 0, "P").kind, "written");
  assert.equal(deleteRange(target, 2, 3, "Forward"), true);
  await flushed();
  assert.equal(text(), "PHelo");
  assert.equal(hook.read().peer.rows[0].audioText, "PHelo");
  assert.equal(show.mock.callCount(), 0);
});

test("a second cell whose paint changed during flush keeps the new key on its old preview", async t => {
  const show = await enter(t, [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }]);
  const first = cell("audioText"), selectSecond = () => document.querySelector('#rows .cell-editable[data-id="r2"][data-field="audioText"]');
  first.focus();
  setCellSelection(first, 2);
  assert.equal(beforeInput(first, "insertText", "x"), true);
  assert.equal(hook.nativePeer.type("r2", 0, "P").kind, "written");
  const second = selectSecond();
  setCellSelection(second, 2);
  assert.equal(beforeInput(second, "insertText", "Z"), true);
  await flushed();
  assert.equal(selectSecond().textContent, "WoZrld");
  for (const copy of [hook.read().app, hook.read().peer]) assert.deepEqual(copy.rows.map(row => row.audioText), ["Hexllo", "PWorld"]);
  assert.equal(show.mock.callCount(), 1);
  assert.deepEqual(hook.leave(), { ok: false, reason: "native-selection-stale" });
});

function inputProbe(t, options = {}) {
  const doc = migrateRows({ title: "Native script", rows: [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }] });
  adoptReplacement(doc);
  const native = openNativeSession({ kind: "state", state: nativeBytes(doc) }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(native.close);
  const target = cell("audioText"), refuse = t.mock.fn(), order = [];
  const resolve = t.mock.fn(options.resolve ?? native.narrationOffset);
  const write = t.mock.fn(options.write ?? native.commands.typeText);
  let paint;
  const input = mountNativeSharedInput({
    native: {
      ...native, narrationOffset: resolve,
      trackNarrationPaint: beat => {
        const tracked = native.trackNarrationPaint(beat);
        return { ...tracked, dispose: () => { order.push("dispose"); tracked.dispose(); } };
      },
      commands: { ...native.commands, typeText: bound((...args) => { order.push("write"); return write(...args); }) }
    },
    report: assert.fail, editAttribution: () => ({ by: "Writer", at: "now" }),
    publish: () => { options.publish?.(); paint(); },
    session: { admit: () => null, refuse, subscribe: run => { paint = run; return () => {}; } }
  });
  t.after(() => { if (!options.manualDispose) input.dispose(); target.textContent = "Hello"; });
  target.focus();
  setCellSelection(target, 2);
  return { input, native, target, refuse, resolve, write, order };
}

test("an inverted rebased range stops with the deletion preview visible", t => {
  const { input, native, target, refuse } = inputProbe(t, { resolve: (_beat, _point, assoc) => assoc === -1 ? 1 : 4 });
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(deleteRange(target, 4, 5, "Forward"), true);
  assert.equal(target.textContent, "Hexlo");
  assert.equal(input.finish(), "native-selection-stale");
  assert.equal(native.narrationHtml("r1"), "Hexllo");
  assert.deepEqual(refuse.mock.calls.map(call => call.arguments), [["native-selection-stale"]]);
});

for (const beat of ["r1", "r2"]) test("a cell removed during flush refuses the next edit in " + beat, t => {
  const query = () => document.querySelector('#rows .cell-editable[data-id="' + beat + '"][data-field="audioText"]');
  const { target, native, refuse } = inputProbe(t, { publish: () => query().closest(".row").remove() });
  assert.equal(beforeInput(target, "insertText", "x"), true);
  if (beat === "r1") assert.equal(deleteRange(target, 3, 4), true);
  else {
    const second = query();
    setCellSelection(second, 2);
    assert.equal(beforeInput(second, "insertText", "Z"), true);
  }
  assert.equal(query(), null);
  assert.equal(native.narrationHtml("r1"), "Hexllo");
  assert.equal(native.narrationHtml("r2"), "World");
  assert.deepEqual(refuse.mock.calls.map(call => call.arguments), [["native-selection-stale"]]);
});

test("a written result without a caret leaves selection and avoids resolving a position", t => {
  const { input, target, resolve } = inputProbe(t, { write: () => ({ kind: "written" }) });
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(input.finish(), null);
  assert.equal(resolve.mock.callCount(), 0);
  assert.deepEqual(cellSelection(target), { from: 3, to: 3 });
});

test("a finish releases the paint tracker before the write", t => {
  const { input, target, order } = inputProbe(t);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(input.finish(), null);
  assert.deepEqual(order, ["dispose", "write"]);
});

test("stopping a draft releases the paint tracker and clears its scheduled flush", t => {
  const { input, target, order } = inputProbe(t);
  const schedule = t.mock.method(globalThis, "setTimeout"), cancel = t.mock.method(globalThis, "clearTimeout");
  assert.equal(beforeInput(target, "insertText", "x"), true);
  const timer = schedule.mock.calls.find(call => call.arguments[1] === 32)?.result;
  assert.ok(timer);
  input.stop();
  assert.deepEqual(order, ["dispose"]);
  assert.ok(cancel.mock.calls.some(call => call.arguments[0] === timer));
});

test("disposing a native binding removes its lifetime listeners and pending work", t => {
  const addWindow = t.mock.method(window, "addEventListener"), removeWindow = t.mock.method(window, "removeEventListener");
  const addDocument = t.mock.method(document, "addEventListener"), removeDocument = t.mock.method(document, "removeEventListener");
  const { input, target, order } = inputProbe(t, { manualDispose: true });
  const schedule = t.mock.method(globalThis, "setTimeout"), cancel = t.mock.method(globalThis, "clearTimeout");
  assert.equal(beforeInput(target, "insertText", "x"), true);
  const timer = schedule.mock.calls.find(call => call.arguments[1] === 32)?.result;
  assert.ok(timer);
  input.dispose();
  assert.deepEqual(order, ["dispose"]);
  assert.ok(cancel.mock.calls.some(call => call.arguments[0] === timer));
  for (const [name, add, remove] of [
    ["beforeunload", addWindow, removeWindow], ["pagehide", addWindow, removeWindow], ["visibilitychange", addDocument, removeDocument]
  ]) {
    const listener = add.mock.calls.find(call => call.arguments[0] === name)?.arguments[1];
    assert.ok(listener);
    assert.ok(remove.mock.calls.some(call => call.arguments[0] === name && call.arguments[1] === listener), name);
  }
});

test("deleting buffered letters counts toward the synchronous cap", t => {
  const { target, write, native } = inputProbe(t);
  for (let i = 0; i < 128; i++) {
    assert.equal(beforeInput(target, "insertText", "x"), true);
    assert.equal(deleteRange(target, 2, 3), true);
  }
  assert.equal(write.mock.callCount(), 1);
  assert.equal(write.mock.calls[0].arguments[1], "");
  assert.equal(native.narrationHtml("r1"), "Hello");
});

test("a draft beginning with a 256-unit selection flushes immediately", async t => {
  const initial = "a".repeat(256) + "b";
  await enter(t, [{ id: "r1", audioText: initial }]);
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 0, 256);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(text(), "xb");
  await Promise.resolve();
  assert.equal(hook.read().peer.rows[0].audioText, "xb");
});

test("focusout alone settles composition and the next composition starts with an empty candidate", async t => {
  await enter(t);
  let target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(compose(target, "start", ""), false);
  assert.equal(compose(target, "update", "K"), false);
  target.blur();
  await Promise.resolve();
  assert.equal(text(), "HeKllo");
  target = cell("audioText");
  target.focus();
  setCellSelection(target, 3);
  assert.equal(compose(target, "start", ""), false);
  target.blur();
  await Promise.resolve();
  assert.equal(text(), "HeKllo");
  await Promise.resolve();
  assert.equal(hook.read().peer.rows[0].audioText, "HeKllo");
});

test("failed composition recovery stops before blur can touch the editor", async t => {
  const { native, target, refused } = await openDirect(t);
  assert.equal(compose(target, "start", ""), false);
  assert.equal(compose(target, "update", "e"), false);
  const preview = target.firstChild;
  preview.insertData(8, "e");
  const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, 0);
  native.ydoc.once("afterTransactionCleanup", () => { throw new Error("interrupted cleanup"); });
  assert.throws(() => native.commands.typeText(at.range, "P", {}), /interrupted cleanup/);
  await Promise.resolve();
  assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"]]);
  target.blur();
  await Promise.resolve();
  assert.equal(target.firstChild, preview);
  assert.equal(target.textContent, "Capturede words");
  assert.equal(sharedSession(), true);
});

test("failed close cannot replay a draft after unexpected browser input", async t => {
  const show = t.mock.method(notices, "show", () => {});
  const { native, target } = await openDirect(t);
  assert.equal(beforeInput(target, "insertText", "!"), true);
  target.firstChild.insertData(9, "?");
  target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "?" }));
  const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, 0);
  native.ydoc.once("afterTransactionCleanup", () => { throw new Error("interrupted cleanup"); });
  assert.throws(() => native.commands.typeText(at.range, "P", {}), /interrupted cleanup/);
  await Promise.resolve();
  assert.equal(target.textContent, "Captured!? words");
  assert.equal(sharedSession(), true);
  assert.match(String(show.mock.calls[0]?.arguments[0]), /Unsent writing is still in the editor/);
});

async function step(perform, project, see, expected) {
  const before = project(hook.read().app);
  perform();
  await Promise.resolve();
  const after = () => {
    const { app, peer } = hook.read();
    assert.deepEqual(project(app), expected);
    assert.deepEqual(project(peer), expected);
    assert.equal(see(), true);
  };
  after();
  assert.equal(hook.nativePeer.step("undo").kind, "written");
  await Promise.resolve();
  assert.deepEqual(project(hook.read().app), before);
  assert.deepEqual(project(hook.read().peer), before);
  assert.equal(hook.nativePeer.step("redo").kind, "written");
  await Promise.resolve();
  after();
}

test("status and duration controls publish and undo one action at a time", async t => {
  await enter(t);
  const status = doc => doc.rows[0].status;
  const statusButton = () => document.querySelector('#rows [data-action="cycle-status"][data-id="r1"]');
  await step(() => statusButton().click(), status, () => /ready/i.test(statusButton().title), "ready");
  await step(() => setBeatFilmed("r1", true), status, () => /shot|filmed/i.test(statusButton().title), "shot");
  await step(() => setBeatFilmed("r1", false), status, () => /to do/i.test(statusButton().title), "todo");
  const duration = doc => doc.rows[0].lengthSeconds;
  const read = () => document.querySelector('#rows .row-read[data-id="r1"]');
  await step(() => assert.equal(setBeatLength("r1", 83), true), duration, () => read().classList.contains("is-set"), 83);
  await step(() => assert.equal(setBeatLength("r1", null), true), duration, () => !read().classList.contains("is-set"), undefined);
});

test("simultaneous field edits preserve different keys and converge on one value for the same key", async t => {
  await enter(t);
  const row = () => hook.read();
  const status = { kind: "beat", id: "r1", field: "status" };
  hook.nativePeer.hold();
  setBeatLength("r1", 64);
  await Promise.resolve();
  assert.equal(hook.nativePeer.field(status, "shot").kind, "written");
  hook.nativePeer.deliver();
  await Promise.resolve();
  for (const copy of [row().app, row().peer]) {
    assert.equal(copy.rows[0].lengthSeconds, 64);
    assert.equal(copy.rows[0].status, "shot");
  }
  hook.nativePeer.hold();
  setBeatFilmed("r1", false);
  await Promise.resolve();
  assert.equal(hook.nativePeer.field(status, "ready").kind, "written");
  hook.nativePeer.deliver();
  await Promise.resolve();
  assert.ok(["todo", "ready"].includes(row().app.rows[0].status));
  assert.equal(row().app.rows[0].status, row().peer.rows[0].status);
});

test("gallery add, remove, reorder and annotation refuse to write to a missing beat", async t => {
  const show = await enter(t), before = hook.read();
  handleImageFile("gone", new window.File(["picture"], "picture.png", { type: "image/png" }));
  removeImage("gone", 0);
  const change = t.mock.fn(() => { throw new Error("gallery plan ran"); });
  for (const route of ["Reorder pictures", "Annotate picture"]) {
    assert.deepEqual(cellEditing().editGallery("gone", route, change), { changed: false, held: true });
  }
  assert.equal(change.mock.callCount(), 0);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), Array.from({ length: 4 }, () => ["That beat no longer exists.", "warn"]));
  assert.deepEqual(hook.read(), before);
});

test("gallery edits replace one value and publish to the screen and peer", async t => {
  await enter(t);
  const refs = ["a", "b", "c"].map(letter => ({ sha256: letter.repeat(64), width: 1, height: 1, mime: "image/png" }));
  const gallery = doc => [doc.rows[0].imageRef, ...(doc.rows[0].moreImages ?? []).map(item => item.imageRef)].filter(Boolean).map(ref => ref.sha256);
  const count = n => () => document.querySelectorAll('#rows .row[data-id="r1"] .scene-gallery-tile').length === n;
  const edit = change => () => assert.deepEqual(cellEditing().editGallery("r1", "Gallery edited", change), { changed: true, held: false });
  await step(edit(row => { addGalleryPicture(row, refs[0], "First"); return true; }), gallery, count(1), ["a".repeat(64)]);
  await step(edit(row => { addGalleryPicture(row, refs[1], "Second"); return true; }), gallery, count(2), ["a".repeat(64), "b".repeat(64)]);
  await step(edit(row => replaceGalleryPicture(row, 1, refs[2], "Third")), gallery, count(2), ["a".repeat(64), "c".repeat(64)]);
  await step(edit(row => moveGallerySlot(row, 1, 0)), gallery, count(2), ["c".repeat(64), "a".repeat(64)]);
  await step(() => removeImage("r1", 0), gallery, count(1), ["a".repeat(64)]);
});

test("gallery actions refuse a stale slot before calling its edit", async t => {
  const ref = sha => ({ sha256: sha.repeat(64), width: 1, height: 1, mime: "image/png" });
  const show = await enter(t, [{ id: "r1", audioText: "Hello", imageRef: ref("a") }]);
  assert.equal(hook.nativePeer.field({ kind: "gallery", id: "r1" }, { imageRef: ref("b") }).kind, "written");
  const edit = t.mock.fn(() => true);
  assert.deepEqual(cellEditing().editGallery("r1", "Remove cover", edit), { changed: false, held: true });
  assert.equal(edit.mock.callCount(), 0);
  assert.equal(show.mock.callCount(), 1);
  await Promise.resolve();
  assert.equal(hook.read().app.rows[0].imageRef.sha256, "b".repeat(64));
});

test("removing a picture from a joined projection refuses where the child still owns it", async t => {
  const ref = sha => ({ sha256: sha.repeat(64), width: 1, height: 1, mime: "image/png" });
  const doc = migrateRows({ title: "Joined pictures", rows: [
    { id: "r1", audioText: "One", imageRef: ref("a") }, { id: "r2", audioText: "Two", imageRef: ref("b") }
  ] });
  adoptReplacement(doc);
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enterFrom(nativeBytes(doc, " "), { backend: "native" }), { ok: true });
  t.after(() => { if (sharedSession()) hook.leave(); });
  const before = hook.read();
  assert.equal(before.app.rows[0].moreImages[0].imageRef.sha256, "b".repeat(64));
  removeImage("r1", 1);
  await Promise.resolve();
  assert.deepEqual(hook.read(), before);
  assert.equal(show.mock.callCount(), 1);
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});

test("a comment and its anchor, a reply, each body edit, resolve, reopen and remove each undo as one action", async t => {
  await enter(t);
  openCommentsPanel();
  const select = selector => document.querySelector(selector);
  select('#comments-filter-seg [data-filter="all"]').click();
  const target = cell("audioText"), toolbar = target.closest(".field-wrap");
  target.focus();
  setCellSelection(target, 0, 5);
  toolbar.querySelector('[data-cmd="comment"]').click();
  assert.equal(select("#comment-modal").hidden, false);
  select("#comment-body-editable").textContent = "A first comment";
  const project = doc => ({
    comments: doc.comments.map(item => [item.body, item.resolved, item.replies.map(reply => reply.body)]),
    anchors: /cmt-anchor/.test(doc.rows[0].audioText)
  });
  const expected = (body, resolved, replies, anchors = true) => ({ comments: body ? [[body, resolved, replies]] : [], anchors });
  await step(() => select("#comment-post").click(), project, () =>
    select(".comment-body")?.textContent === "A first comment" && cell("audioText").querySelector(".cmt-anchor") !== null,
  expected("A first comment", false, []));
  select('[data-action="toggle-reply"]').click();
  select(".reply-composer .cell-editable").textContent = "A reply";
  await step(() => select(".reply-post").click(), project, () => select(".reply-body")?.textContent === "A reply",
    expected("A first comment", false, ["A reply"]));
  const editBody = (selector, body) => () => {
    select(selector).click();
    select(".comment-body-editor").textContent = body;
    select('[data-action="save-comment-body"]').click();
  };
  await step(editBody('[data-action="edit-comment-body"]:not([data-reply])', "Edited comment"), project,
    () => select(".comment-body")?.textContent === "Edited comment", expected("Edited comment", false, ["A reply"]));
  await step(editBody('[data-action="edit-comment-body"][data-reply]', "Edited reply"), project,
    () => select(".reply-body")?.textContent === "Edited reply", expected("Edited comment", false, ["Edited reply"]));
  const toggle = () => select('[data-action="toggle-resolve"]').click();
  await step(toggle, project, () => select(".comment-resolved-note") !== null, expected("Edited comment", true, ["Edited reply"]));
  await step(toggle, project, () => select(".comment-resolved-note") === null, expected("Edited comment", false, ["Edited reply"]));
  await step(() => {
    select('[data-action="comment-menu"]').click();
    select('[data-action="delete-comment"]').click();
    select('[data-action="delete-comment"]').click();
  }, project, () => select(".comment-card") === null, expected(null, false, []));
});

test("cancel discards a provisional selection and a non-author cannot edit a comment body", async t => {
  const doc = migrateRows({ title: "Existing thread", rows: [{ id: "r1", audioText: "Hello" }],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", author: "Another editor", body: "Original", replies: [] }] });
  adoptReplacement(doc);
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enter({ backend: "native" }), { ok: true });
  t.after(() => { if (sharedSession()) hook.leave(); });
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 0, 5);
  target.closest(".field-wrap").querySelector('[data-cmd="comment"]').click();
  assert.equal(document.getElementById("comment-modal").hidden, false);
  document.getElementById("comment-cancel").click();
  assert.equal(document.getElementById("comment-modal").hidden, true);
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
  assert.equal(text(), "Hello");
  openCommentsPanel();
  assert.equal(document.querySelector('[data-action="edit-comment-body"]'), null);
  const comments = nativeEditorRecords().comments;
  assert.deepEqual(comments.body("c1", undefined, "Attempt"), { changed: false, held: true });
  assert.equal(hook.read().app.comments[0].body, "Original");
  assert.equal(show.mock.callCount(), 1);
  assert.equal(comments.resolve("c1", true).changed, true);
  await Promise.resolve();
  assert.equal(hook.read().peer.comments[0].resolved, true);
  assert.equal(comments.remove("c1").changed, true);
  await Promise.resolve();
  assert.equal(hook.read().peer.comments.length, 0);
});
