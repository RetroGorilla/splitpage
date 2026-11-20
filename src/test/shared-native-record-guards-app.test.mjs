import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { getEditorName } from "../bootstrap/wiring/preferences-owner.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { nativeEditorRecords } from "../bootstrap/wiring/shared-session.ts";
import { nativeGalleryOf } from "../adapters/collab/native/values.ts";
import { pictures } from "../bootstrap/wiring/ports/pictures.ts";
import { setBeatLength } from "../features/rows/read-time.ts";
import { setBeatFilmed } from "../bootstrap/wiring/beat-status.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { openCommentsPanel } from "../features/comments/comments.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const find = selector => document.querySelector(selector);
const visual = () => find("#rows .visual-cell");
const cell = (field, id = "r1") => find(`#rows .cell-editable[data-field="${field}"][data-id="${id}"]`);
const file = () => new window.File(["sample"], "picture.png", { type: "image/png" });
const ref = char => ({ sha256: char.repeat(64), width: 1, height: 1, mime: "image/png" });
const unsupported = "This is not available in a shared session yet.";

async function enter(t, comments = [], rows = [
  { id: "r1", status: "todo", audioText: "Hello", visualText: "Look" },
  { id: "r2", status: "shot", lengthSeconds: 42, audioText: "Second", imageRef: ref("a") }
]) {
  adoptReplacement(migrateRows({ title: "Native records", rows, comments }));
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enter({ backend: "native" }), { ok: true });
  t.after(() => { if (sharedSession()) hook.leave(); });
  return show;
}

function commentToolbar(from = 0, to = 5, target = cell("audioText")) {
  target.focus();
  setCellSelection(target, from, to);
  target.closest(".field-wrap").querySelector('[data-cmd="comment"]').click();
}

function openPanel() {
  openCommentsPanel();
  find('#comments-filter-seg [data-filter="all"]').click();
}

function transfer(type, target, files, html = "") {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
    value: { files, getData: kind => kind === "text/html" ? html : "", types: ["Files"] }
  });
  target.dispatchEvent(event);
  return event;
}

test("posting after peer beat removal keeps the comment draft available to copy", async t => {
  const show = await enter(t);
  openPanel();
  commentToolbar();
  assert.equal(find("#comment-modal").hidden, false);
  const body = find("#comment-body-editable");
  assert.equal(hook.nativePeer.removeBeat("r1").kind, "written");
  await Promise.resolve();
  body.textContent = "Unposted comment";
  find("#comment-post").click();
  assert.equal(find(".typed-unsaved-text")?.value, "Unposted comment");
  assert.equal(hook.read().app.comments.length, 0);
  assert.match(show.mock.calls.at(-1).arguments[0], /your comment was not saved/);
});

for (const reply of [false, true]) test(`peer thread removal keeps an unsaved ${reply ? "reply" : "comment"} body edit`, async t => {
  const show = await enter(t, [{ id: "thread", rowId: "r1", field: "audioText", author: getEditorName(), body: "Original",
    replies: [{ id: "reply", author: getEditorName(), body: "Original reply" }] }]);
  openPanel();
  find('[data-action="edit-comment-body"]' + (reply ? "[data-reply]" : ":not([data-reply])")).click();
  const editor = find(".comment-body-editor");
  editor.textContent = "Unposted body edit";
  editor.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(hook.nativePeer.removeComment("thread").kind, "written");
  await Promise.resolve();
  assert.equal(find(".comment-body-editor"), null);
  assert.equal(find(".typed-unsaved-text")?.value, "Unposted body edit");
  assert.match(show.mock.calls.at(-1).arguments[0], /your edit was not saved/);
});

for (const removal of ["join", "removeBeat"]) test(`stale controls refuse a beat lost to peer ${removal}`, async t => {
  const show = await enter(t);
  const cycle = find('#rows [data-action="cycle-status"][data-id="r2"]');
  const gallery = nativeEditorRecords().gallery;
  const lost = removal === "join" ? hook.nativePeer.join("r2", "r1") : hook.nativePeer.removeBeat("r2");
  assert.equal(lost.kind, "written");
  const expected = hook.read().peer.rows;
  assert.ok(cycle.isConnected);
  assert.equal(setBeatLength("r2", 19), false);
  assert.equal(setBeatLength("r2", null), false);
  cycle.click();
  setBeatFilmed("r2", false);
  const edit = t.mock.fn(() => true);
  assert.deepEqual(gallery("r2", "Gallery edited", edit), { changed: false, held: true });
  assert.equal(edit.mock.callCount(), 0);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), Array.from({ length: 5 }, () => [unsupported, "warn"]));
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
  await Promise.resolve();
  assert.deepEqual(hook.read().app.rows.map(nativeGalleryOf), expected.map(nativeGalleryOf));
  assert.deepEqual(hook.read().app.rows.map(row => [row.id, row.status, row.lengthSeconds]),
    expected.map(row => [row.id, row.status, row.lengthSeconds]));
});

test("HTML-only mixed paste refuses the caption and image together", async t => {
  const show = await enter(t);
  const readImage = t.mock.method(pictures, "internDataUrl", () => null);
  const before = hook.read();
  assert.equal(transfer("paste", cell("visualText"), [file()], "<p>Caption to paste</p>").defaultPrevented, true);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [[unsupported, "warn"]]);
  assert.equal(readImage.mock.callCount(), 0);
  assert.deepEqual(hook.read(), before);
});

test("a consumed image drop clears the Visual highlight even if the write is refused", async t => {
  await enter(t);
  const target = visual();
  transfer("dragover", target, [file()]);
  assert.equal(target.classList.contains("drag-over"), true);
  assert.equal(transfer("drop", target, [file()]).defaultPrevented, true);
  assert.equal(target.classList.contains("drag-over"), false);
});

test("an imported conflict card disables Use my version in the native editor", async t => {
  const show = await enter(t, [{ id: "conflict", rowId: "r1", field: "audioText", kind: "conflict",
    conflictField: "Narration", author: "Editor", body: "My version" }]);
  openPanel();
  const before = hook.read();
  const button = find('[data-action="restore-conflict"]');
  button.click();
  assert.equal(button.disabled, true);
  assert.deepEqual(hook.read(), before);
  assert.equal(show.mock.callCount(), 0);
});
