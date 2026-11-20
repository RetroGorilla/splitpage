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
import { mountNativeSharedInput } from "../bootstrap/wiring/native-shared-input.ts";
import { enterSharedSession, forceLeaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";
import { setTimeout as delay } from "node:timers/promises";

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

function deleteRange(target, from, to) {
  const range = document.createRange();
  range.setStart(target.firstChild, from);
  range.setEnd(target.firstChild, to);
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" });
  Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function compose(target, type, data) {
  const event = new window.CompositionEvent("composition" + type, { bubbles: true, cancelable: true, data });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

async function enter(t, rows = [{ id: "r1", audioText: "Hello", visualText: "Look" }]) {
  adoptReplacement(migrateRows({ title: "Native script", rows }));
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

test("typing then deleting the buffered letter is unchanged and publishes no edit", async t => {
  const show = await enter(t);
  const seen = t.mock.fn();
  t.after(onSessionChange(seen));
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.equal(deleteRange(target, 2, 3), true);
  await flushed();
  assert.equal(text(), "Hello");
  assert.equal(hook.read().peer.rows[0].audioText, "Hello");
  assert.equal(target.textContent, "Hello");
  assert.deepEqual(cellSelection(target), { from: 2, to: 2 });
  assert.equal(seen.mock.callCount(), 0);
  assert.equal(show.mock.callCount(), 0);
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
    assert.equal(target.dispatchEvent(event), true);
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
      commands: { ...native.commands, anchorText: anchor, typeText: write } },
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

for (const reason of ["text", "full", "future-refusal"]) test("a commit refusal keeps the text and stops on " + reason, t => {
  const doc = migrateRows({ title: "Native script", rows: [{ id: "r1", audioText: "Hello" }] });
  adoptReplacement(doc);
  const native = openNativeSession({ kind: "state", state: nativeBytes(doc) }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(native.close);
  const refuse = t.mock.fn(), publish = t.mock.fn();
  const write = t.mock.fn(() => ({ kind: "recovery", reason, runs: [] }));
  const input = mountNativeSharedInput({
    native: { ...native, commands: { ...native.commands, typeText: write } },
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

async function openDirect(t) {
  const fixture = entrySwitchFixture(), refused = t.mock.fn();
  const ports = { ...fixture.ports, commandRefused: refused };
  let native;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  t.after(cleanSession);
  const target = document.querySelector('#rows .cell-editable[data-id="R1"][data-field="audioText"]');
  target.focus();
  setCellSelection(target, 8);
  return { native, refused, errors: fixture.errors, target };
}

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
