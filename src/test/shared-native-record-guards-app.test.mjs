import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { getEditorName } from "../bootstrap/wiring/preferences-owner.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { enterSharedSession, leaveRunningSharedSession, nativeEditorRecords } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";
import { nativeGalleryOf } from "../adapters/collab/native/values.ts";
import { pictures } from "../bootstrap/wiring/ports/pictures.ts";
import { setBeatLength } from "../features/rows/read-time.ts";
import { setBeatFilmed } from "../bootstrap/wiring/beat-status.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { openCommentsPanel } from "../features/comments/comments.ts";
import { blobStore, createMemoryBackend, setBackend } from "../adapters/storage/02c-blobs.ts";
import { createHeldFetch, createHeldImageDecode } from "./_m4-matrix.mjs";
import { rowSlots } from "../core/document/gallery.ts";
import { closeAnnotator, openAnnotator } from "../features/gallery/annotate.ts";
import { closeGalleryOverlay, openGalleryOverlay } from "../features/gallery/overlay.ts";

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
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngBytes = new Uint8Array(Buffer.from(png.split(",")[1], "base64"));
const originalPicture = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const settle = () => new Promise(resolve => setImmediate(resolve));

async function until(predicate) {
  for (let tick = 0; tick < 40 && !predicate(); tick++) await settle();
  assert.ok(predicate(), "the expected editor update occurred");
}

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

function bufferNarration(text) {
  const target = cell("audioText");
  target.focus();
  setCellSelection(target, 2);
  assert.equal(target.dispatchEvent(new window.InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: "insertText", data: text
  })), false);
  assert.equal(target.textContent, "He" + text + "llo");
  assert.equal(hook.read().app.rows[0].audioText, "Hello");
  assert.equal(hook.read().peer.rows[0].audioText, "Hello");
}

for (const action of ["duration change", "comment post"]) test(`a ${action} lands while narration is buffered`, async t => {
  const show = await enter(t);
  if (action === "comment post") {
    openPanel();
    commentToolbar(0, 4, cell("visualText"));
    find("#comment-body-editable").textContent = "Check the shot";
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  bufferNarration("x");
  if (action === "duration change") assert.equal(setBeatLength("r1", 83), true);
  else find("#comment-post").click();

  const record = action === "duration change"
    ? copy => copy.rows[0].lengthSeconds
    : copy => copy.comments.map(({ body }) => body);
  const expected = action === "duration change" ? 83 : ["Check the shot"];
  await Promise.resolve();
  const pending = hook.read();
  assert.deepEqual(record(pending.peer), expected);
  assert.equal(pending.peer.rows[0].audioText, "Hello");
  assert.equal(pending.app.rows[0].audioText, "Hello");

  t.mock.timers.tick(32);
  await Promise.resolve();
  for (const copy of [hook.read().app, hook.read().peer]) {
    assert.equal(copy.rows[0].audioText, "Hexllo");
    assert.deepEqual(record(copy), expected);
  }
  assert.equal(cell("audioText").textContent, "Hexllo");
  if (action === "duration change") assert.equal(find('.row-read[data-id="r1"]').textContent, "1:23");
  else assert.equal(find(".comment-body").textContent, "Check the shot");
  assert.equal(show.mock.callCount(), 0);
});

test("leaving with buffered narration and a pending picture store keeps the narration only", async t => {
  const show = await enter(t);
  fakeImageDecoder(t);
  const waiting = Promise.withResolvers(), stored = Promise.withResolvers();
  t.after(() => stored.resolve([]));
  t.mock.method(pictures, "isDurable", () => true);
  t.mock.method(pictures, "persist", () => { waiting.resolve(); return stored.promise; });
  const adding = nativeEditorRecords().addPictures("r1", [file()]);
  await waiting.promise;
  bufferNarration("z");
  assert.deepEqual(hook.leave(), { ok: true });
  assert.equal(hook.read().app.rows[0].audioText, "Hezllo");
  assert.equal(cell("audioText").textContent, "Hezllo");
  assert.deepEqual(rowSlots(hook.read().app.rows[0]), []);

  assert.deepEqual(await hook.enter({ backend: "native" }), { ok: true });
  stored.resolve([]);
  await adding;
  for (const copy of [hook.read().app, hook.read().peer]) {
    assert.equal(copy.rows[0].audioText, "Hezllo");
    assert.deepEqual(rowSlots(copy.rows[0]), []);
  }
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [
    ["The picture finished loading after the script changed, so it was not added.", "warn"]
  ]);
});

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

function fakeImageDecoder(t) {
  const ImageBefore = globalThis.Image;
  globalThis.Image = class {
    width = 1;
    height = 1;
    set src(value) { if (value) queueMicrotask(() => this.onload()); }
  };
  t.after(() => { globalThis.Image = ImageBefore; });
  t.mock.method(window.HTMLCanvasElement.prototype, "getContext", () => ({ drawImage() {} }));
  t.mock.method(window.HTMLCanvasElement.prototype, "toDataURL", () => png);
}

async function enterWithNative(t, rows) {
  const fixture = entrySwitchFixture();
  if (rows) adoptReplacement(migrateRows({ title: "Gallery", rows }));
  let native;
  assert.deepEqual(await enterSharedSession(fixture.ports, (doc, failed) => {
    const opened = openNativeEditor(fixture.ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  return { fixture, native };
}

async function assertRecoveredPicture(fixture, failure) {
  assert.equal(sharedSession(), false);
  assert.deepEqual(fixture.errors, [failure]);
  const recovered = JSON.stringify(currentDocument());
  const sha = JSON.parse(recovered).rows[0].imageRef.sha256;
  assert.equal(pictures.isDurable(sha), true);
  blobStore.forgetMemory();
  assert.equal(pictures.has(sha), false);
  adoptReplacement(migrateRows(JSON.parse(recovered)));
  assert.equal(currentDocument().rows[0].imageRef.sha256, sha);
  assert.deepEqual(await pictures.ensureBytes([sha], { strict: true }), []);
  assert.deepEqual(pictures.bytesFor(sha), pngBytes);
}

test("a picture reference recovered from a failed close reloads its bytes from storage", async t => {
  const { fixture, native } = await enterWithNative(t);
  fakeImageDecoder(t);
  setBackend({ ...createMemoryBackend(), persistent: true });
  t.after(() => setBackend(null));
  const failure = new Error("Interrupted gallery cleanup");
  native.ydoc.once("afterTransactionCleanup", () => { throw failure; });
  await nativeEditorRecords().addPictures("R1", [file()]);
  await assertRecoveredPicture(fixture, failure);
});

function galleryAction(t, route) {
  const decoder = createHeldImageDecode({ dataUrl: png });
  t.after(decoder.install());
  const row = { id: "r1", audioText: "Hello", visualText: "Look" };
  if (route === "annotation") {
    row.imageRef = pictures.internDataUrl(originalPicture);
    assert.ok(row.imageRef);
    t.mock.method(URL, "createObjectURL", () => "blob:gallery-annotation");
    t.after(closeAnnotator);
    return { row, act: async () => {
      assert.equal(openAnnotator("r1", 0), true);
      const img = find("#annotate-img");
      await until(() => typeof img.onload === "function");
      img.onload();
      assert.equal(window.__annotateTest.state().ready, true);
      const frame = find("#annotate-frame");
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new window.MouseEvent(type, { bubbles: true, button: 0 });
        Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "pen" } });
        frame.dispatchEvent(event);
      }
      assert.equal(window.__annotateTest.state().marks.length, 1);
      find("#annotate-done").click();
    } };
  }
  row.imageLinks = [{ href: "https://youtu.be/dQw4w9WgXcQ", poster: true }];
  const held = createHeldFetch({ answer: () => ({ bytes: pngBytes, headers: { "content-type": "image/png" } }) });
  window.__videoTest.setFetch(held.fetch);
  t.after(() => { window.__videoTest.setFetch(null); closeGalleryOverlay(); });
  return { row, act: () => {
    openGalleryOverlay("r1", 0);
    find('[data-gact="retry-thumb"]').click();
  } };
}

for (const route of ["annotation", "thumbnail"]) {
  for (const backend of ["failed", "memory-only"]) test(`native ${route} leaves no reference with a ${backend} store`, async t => {
    const { row, act } = galleryAction(t, route);
    const show = await enter(t, [], [row]);
    setBackend(createMemoryBackend());
    t.after(() => setBackend(null));
    const persist = backend === "failed" ? t.mock.method(pictures, "persist", async shas => shas) : t.mock.method(pictures, "persist");
    const before = hook.read();
    await act();
    await until(() => show.mock.calls.some(call => /Could not (save the annotated picture|get this video)/.test(call.arguments[0])));
    assert.equal(persist.mock.callCount(), 1);
    assert.deepEqual(hook.read(), before);
    assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
  });

  test(`native ${route} recovered after failed cleanup reloads from durable storage`, async t => {
    const { row, act } = galleryAction(t, route);
    const { fixture, native } = await enterWithNative(t, [row]);
    const backend = createMemoryBackend();
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    setBackend({ ...backend, persistent: true, put: async (...args) => {
      pending.resolve();
      await release.promise;
      return backend.put(...args);
    } });
    t.after(() => { release.resolve(); setBackend(null); });
    await act();
    await pending.promise;
    await settle();
    const slot = rowSlots(currentDocument().rows[0])[0];
    assert.equal(slot.ref?.sha256, row.imageRef?.sha256);
    assert.equal(slot.annotation, null);
    const failure = new Error("Interrupted gallery cleanup");
    native.ydoc.once("afterTransactionCleanup", () => { throw failure; });
    release.resolve();
    await until(() => !sharedSession());
    await assertRecoveredPicture(fixture, failure);
  });
}

for (const backend of ["failed", "memory-only"]) test(`a ${backend} picture store leaves no reference`, async t => {
  const show = await enter(t);
  fakeImageDecoder(t);
  const persist = t.mock.method(pictures, "persist", async shas => backend === "failed" ? shas : []);
  t.mock.method(pictures, "isDurable", () => backend === "failed");
  const before = hook.read();
  await nativeEditorRecords().addPictures("r1", [file()]);
  assert.equal(persist.mock.callCount(), 1);
  assert.match(show.mock.calls.at(-1).arguments[0], /Could not store the picture/);
  assert.deepEqual(hook.read(), before);
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});

test("an asynchronous picture replacement refuses a slot changed by a peer while storing bytes", async t => {
  const show = await enter(t, [], [{ id: "r1", visualText: "Look", imageRef: ref("a") }]);
  fakeImageDecoder(t);
  const waiting = Promise.withResolvers(), stored = Promise.withResolvers();
  t.mock.method(pictures, "isDurable", () => true);
  t.mock.method(pictures, "persist", () => { waiting.resolve(); return stored.promise; });
  const write = nativeEditorRecords().addPictures("r1", [file()], 0);
  await waiting.promise;
  assert.equal(hook.nativePeer.field({ kind: "gallery", id: "r1" }, { imageRef: ref("b") }).kind, "written");
  stored.resolve([]);
  await write;
  assert.match(show.mock.calls.at(-1).arguments[0], /finished loading after the script changed/);
  assert.equal(hook.read().app.rows[0].imageRef.sha256, ref("b").sha256);
  assert.equal(hook.read().peer.rows[0].imageRef.sha256, ref("b").sha256);
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});

test("two pastes of the same picture before publication add it once without a refusal notice", async t => {
  const show = await enter(t);
  fakeImageDecoder(t);
  const stored = Promise.withResolvers();
  t.mock.method(pictures, "isDurable", () => true);
  const persist = t.mock.method(pictures, "persist", () => stored.promise);
  const target = cell("visualText"), picture = file();
  for (let repeat = 0; repeat < 2; repeat++) assert.equal(transfer("paste", target, [picture]).defaultPrevented, true);
  await until(() => persist.mock.callCount() === 2);
  stored.resolve([]);
  await settle();
  for (const copy of Object.values(hook.read())) {
    assert.deepEqual(rowSlots(copy.rows[0]).map(slot => slot.name), ["picture.png"]);
  }
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [["Picture added to beat A.1", "ok"]]);
  assert.equal(hook.nativePeer.step("undo").kind, "written");
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});

test("posting after peer beat removal keeps the comment draft available to copy", async t => {
  const show = await enter(t);
  const cancel = t.mock.method(nativeEditorRecords().comments, "cancel");
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
  assert.equal(cancel.mock.callCount(), 1);
  assert.match(show.mock.calls.at(-1).arguments[0], /your comment was not saved/);
});

test("peer thread removal produces no draft or notice for an untouched body editor", async t => {
  const show = await enter(t, [{ id: "thread", rowId: "r1", field: "audioText", author: getEditorName(), body: "Original" }]);
  openPanel();
  find('[data-action="edit-comment-body"]').click();
  assert.equal(find(".comment-body-editor").textContent, "Original");
  assert.equal(hook.nativePeer.removeComment("thread").kind, "written");
  await Promise.resolve();
  assert.equal(find(".comment-body-editor"), null);
  assert.equal(find(".typed-unsaved-text"), null);
  assert.equal(show.mock.callCount(), 0);
});

test("saving an unchanged comment body adds no update or notice", async t => {
  const show = await enter(t, [{ id: "thread", rowId: "r1", field: "audioText", author: getEditorName(), body: "Original" }]);
  openPanel();
  const before = hook.read();
  find('[data-action="edit-comment-body"]').click();
  find('[data-action="save-comment-body"]').click();
  await Promise.resolve();
  assert.deepEqual(hook.read(), before);
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
  assert.equal(show.mock.callCount(), 0);
});

test("shared redraws keep a body edit and only Save submits it", async t => {
  const thread = (id, body) => ({ id, rowId: "r1", field: "audioText", author: getEditorName(), body });
  await enter(t, [thread("thread", "Original"), thread("first", "First"), thread("second", "Second")]);
  openPanel();
  const writes = nativeEditorRecords().comments, save = writes.body;
  let holding = true;
  const write = t.mock.method(writes, "body", (...args) => holding ? { changed: false, held: true } : save(...args));
  const body = () => find('[data-id="thread"] .comment-body-editor');
  const button = action => find('[data-id="thread"] [data-action="' + action + '"]');
  button("edit-comment-body").click();
  const typed = body();
  typed.textContent = "Keep my edit";
  typed.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(typed.hasAttribute("data-unsaved"), true);

  const redraw = async id => {
    const before = body();
    assert.equal(hook.nativePeer.removeComment(id).kind, "written");
    await Promise.resolve();
    assert.notEqual(body(), before);
    assert.equal(body().textContent, "Keep my edit");
    assert.equal(body().hasAttribute("data-unsaved"), true);
    for (const copy of [hook.read().app, hook.read().peer]) {
      assert.equal(copy.comments.find(comment => comment.id === "thread").body, "Original");
    }
  };
  await redraw("first");
  assert.equal(write.mock.callCount(), 0);
  button("save-comment-body").click();
  assert.deepEqual(write.mock.calls.map(call => call.arguments), [["thread", undefined, "Keep my edit"]]);
  holding = false;
  await redraw("second");
  assert.equal(write.mock.callCount(), 1);

  button("save-comment-body").click();
  await Promise.resolve();
  assert.deepEqual(write.mock.calls.map(call => call.arguments), [
    ["thread", undefined, "Keep my edit"], ["thread", undefined, "Keep my edit"]
  ]);
  assert.equal(body(), null);
  assert.equal(find('[data-id="thread"] .comment-body').textContent, "Keep my edit");
  for (const copy of [hook.read().app, hook.read().peer]) {
    assert.equal(copy.comments.find(comment => comment.id === "thread").body, "Keep my edit");
  }
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
  assert.deepEqual(show.mock.calls.map(call => call.arguments), Array.from({ length: 5 }, () => ["That beat no longer exists.", "warn"]));
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
  const show = await enter(t);
  fakeImageDecoder(t);
  const refused = Promise.withResolvers();
  show.mock.mockImplementation(message => { if (message === "Could not store the picture, so it was not added.") refused.resolve(); });
  t.mock.method(pictures, "persist", async shas => shas);
  const target = visual();
  const before = hook.read();
  transfer("dragover", target, [file()]);
  assert.equal(target.classList.contains("drag-over"), true);
  assert.equal(transfer("drop", target, [file()]).defaultPrevented, true);
  assert.equal(target.classList.contains("drag-over"), false);
  await refused.promise;
  assert.deepEqual(hook.read(), before);
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

test("the gallery skips a planner that declines its draft change", async t => {
  const show = await enter(t);
  const before = hook.read();
  assert.deepEqual(nativeEditorRecords().gallery("r1", "Gallery edited", row => {
    row.imageRef = ref("a");
    return false;
  }), { changed: false, held: false });
  await Promise.resolve();
  assert.deepEqual(hook.read(), before);
  assert.equal(show.mock.callCount(), 0);
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});

for (const guard of ["empty", "unpainted", "stale"]) test(`comment capture rejects a selection that is ${guard}`, async t => {
  const show = await enter(t);
  if (guard === "unpainted") {
    const row = cell("audioText").closest(".row");
    row.replaceWith(row.cloneNode(true));
  }
  if (guard === "stale") assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
  commentToolbar(0, guard === "empty" ? 0 : 5);
  assert.equal(find("#comment-modal").hidden, true);
  const message = { empty: "Select some text inside one cell, then add a comment.",
    unpainted: "Could not anchor a comment to that selection.", stale: unsupported }[guard];
  assert.deepEqual(show.mock.calls.map(call => call.arguments[0]), [message]);
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});

test("cancelling an anchor makes its captured selection unusable for a later post", async t => {
  await enter(t);
  const records = nativeEditorRecords();
  assert.equal(records.anchor("pending", "r1", "audioText", 0, 5, "Hello"), true);
  records.comments.cancel("pending");
  const outcome = records.comments.add({ id: "pending", rowId: "r1", field: "audioText", body: "Do not post",
    quotedText: "Hello", createdAt: new Date(0).toISOString() });
  assert.deepEqual(outcome, { changed: false, held: true });
  await Promise.resolve();
  assert.equal(hook.read().app.comments.length, 0);
  assert.equal(hook.read().peer.comments.length, 0);
});

test("saving an empty body edit keeps the editor open and leaves the saved body alone", async t => {
  const show = await enter(t, [{ id: "thread", rowId: "r1", field: "audioText", author: getEditorName(), body: "Original" }]);
  openPanel();
  find('[data-action="edit-comment-body"]').click();
  find(".comment-body-editor").textContent = " ";
  find('[data-action="save-comment-body"]').click();
  await Promise.resolve();
  assert.equal(find(".comment-body-editor").textContent, " ");
  assert.equal(hook.read().app.comments[0].body, "Original");
  assert.equal(hook.read().peer.comments[0].body, "Original");
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [["Write a comment before posting.", "warn"]]);
});
