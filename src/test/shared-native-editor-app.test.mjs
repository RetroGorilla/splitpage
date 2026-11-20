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
import { removeImage } from "../bootstrap/wiring/rows.ts";
import { mountNativeSharedInput } from "../bootstrap/wiring/native-shared-input.ts";
import { setBeatLength } from "../features/rows/read-time.ts";
import { setBeatFilmed } from "../bootstrap/wiring/beat-status.ts";
import { openCommentsPanel } from "../features/comments/comments.ts";
import { addGalleryPicture, moveGallerySlot, replaceGalleryPicture } from "../core/document/gallery.ts";
import { nativeEditorRecords } from "../bootstrap/wiring/shared-session.ts";

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

async function enter(t, rows = [{ id: "r1", audioText: "Hello", visualText: "Look" }]) {
  adoptReplacement(migrateRows({ title: "Native script", rows }));
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
  await Promise.resolve();
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

for (const selector of ["#doc-title", '#rows .cell-editable[data-id="r2"][data-field="audioText"]']) {
  test("publication preserves focus moved to " + selector, async t => {
    await enter(t, [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }]);
    const target = cell("audioText"), next = document.querySelector(selector);
    target.focus();
    setCellSelection(target, 2);
    assert.equal(beforeInput(target, "insertText", "x"), true);
    next.focus();
    await Promise.resolve();
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
  t.after(mountNativeSharedInput({
    native: { ...native, narrationCaret: guard === "missing caret target" ? () => null : native.narrationCaret,
      commands: { ...native.commands, anchorText: anchor, typeText: write } },
    editAttribution: () => ({ by: "Writer", at: "now" }), report,
    session: { admit: () => guard === "admission failure" ? { kind: "failed", error } : null, refuse, subscribe: () => () => {} }
  }));
  const target = cell("audioText");
  target.focus();
  if (guard === "absent selection") window.getSelection().removeAllRanges(); else setCellSelection(target, 2);
  assert.equal(beforeInput(target, "insertText", "x"), true);
  assert.deepEqual(refuse.mock.calls.map(call => call.arguments), [[expected]]);
  assert.deepEqual(report.mock.calls.map(call => call.arguments), guard === "admission failure" ? [[error]] : []);
  assert.equal(anchor.mock.callCount(), ["anchor refusal", "write recovery"].includes(guard) ? 1 : 0);
  assert.equal(write.mock.callCount(), guard === "write recovery" ? 1 : 0);
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
