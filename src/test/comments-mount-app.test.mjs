import { deleteConfirmation } from "../legacy/production-editing-bridge.ts";
import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { createHeldImageDecode } from "./_m4-matrix.mjs";

window.Element.prototype.scrollIntoView = function () {};
window.Element.prototype.scrollBy = function () {};
await bootApp();
const { commentSortMode } = await import("../application/comment-sort.ts");
const { mountCommentsFeature } = await import("../bootstrap/wiring/comments.ts");
const { documentTransitions } = await import("../legacy/transition-bridge.ts");
const { render } = await import("../js/05-render.js");
const { documentLocation } = await import("../legacy/location-bridge.ts");
const { openCommentComposer, openCommentsPanel, closeCommentComposer } = await import("../js/10-comments.js");
after(closeApp);

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const rootEvents = ["click", "mousedown", "input", "focusout", "paste", "keydown", "focusin", "beforeinput", "compositionstart", "compositionend", "dragstart", "dragend", "drop"];
const targets = {
  document: ["input", "compositionend"],
  "comment-modal": [...rootEvents, "click"], "comments-panel": [...rootEvents, "change"],
  "btn-comments": ["click"], "comments-panel-close": ["click"], "comments-sort": ["change"],
  "comment-close": ["click"], "comment-cancel": ["click"], "comment-post": ["click"], "comment-image-input": ["change"]
};

function open() {
  documentTransitions().open({
    from: { raw: {
      schema: 2, docId: "d" + "c".repeat(32), title: "Comments lifetime",
      rows: [{ id: "r1", status: "todo", visualText: "Scene", audioText: "One" }],
      comments: [{ id: "c_one", kind: "anchor", rowId: "r1", field: "audioText", anchorId: "c_one", quotedText: "One", author: "Ada", body: "Existing comment", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", resolved: false, replies: [] }]
    } },
    reason: "comments-lifetime"
  });
  render();
}

function composer() {
  openCommentComposer({ id: "c_new", rowId: "r1", field: "audioText", quotedText: "One" });
}

function mount() {
  const owner = mountCommentsFeature();
  owner.mountRoots();
  owner.mountControls();
  return owner;
}

function fire(target, type, props = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

test("comments app: every document, root and control registration is removed and installed once on remount", () => {
  mountCommentsFeature().dispose();
  const order = [];
  const records = Object.entries(targets).map(([id, expected]) => {
    const target = id === "document" ? document : document.getElementById(id);
    const added = [];
    const active = [];
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    const phase = (options) => typeof options === "boolean" ? options : !!options?.capture;
    target.addEventListener = function (type, fn, options) {
      assert.equal(phase(options), false, id + ":" + type);
      added.push(type); active.push({ type, fn, capture: phase(options) }); order.push(id + ":" + type);
      if (id === "comments-sort") assert.equal(this.value, commentSortMode());
      return add.call(this, type, fn, options);
    };
    target.removeEventListener = function (type, fn, options) {
      const index = active.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === phase(options));
      assert.ok(index >= 0, id + ":" + type);
      active.splice(index, 1);
      return remove.call(this, type, fn, options);
    };
    return { id, target, expected, added, active, add, remove };
  });
  let owner;
  try {
    owner = mount();
    assert.deepEqual(order, [
      "document:input", "document:compositionend",
      ...rootEvents.map((type) => "comment-modal:" + type), ...rootEvents.map((type) => "comments-panel:" + type),
      "btn-comments:click", "comments-panel-close:click", "comments-panel:change", "comments-sort:change",
      "comment-close:click", "comment-cancel:click", "comment-post:click", "comment-modal:click", "comment-image-input:change"
    ]);
    assert.equal(order.length, 37);
    for (const r of records) assert.deepEqual(r.added, r.expected, r.id);
    owner.dispose(); owner.dispose();
    for (const r of records) assert.equal(r.active.length, 0, r.id);
    owner = mount();
    for (const r of records) {
      assert.deepEqual(r.added, [...r.expected, ...r.expected], r.id);
      assert.equal(r.active.length, r.expected.length, r.id);
    }
    owner.dispose();
    for (const r of records) assert.equal(r.active.length, 0, r.id);
  } finally {
    owner?.dispose();
    for (const r of records) { r.target.addEventListener = r.add; r.target.removeEventListener = r.remove; }
  }
});

for (const scenario of ["dispose and reopen", "same-ID document replacement", "stale completion after remount", "composer reopened", "same-ID body replacement", "token change while held", "normal completion"]) {
  test("comments app: held image completion, " + scenario, { timeout: 20000 }, async () => {
    open();
    const owner = mount();
    composer();
    const decode = createHeldImageDecode({ dataUrl: PNG });
    const restoreDecode = decode.install(window);
    decode.holdDecode();
    let replacement;
    try {
      const input = document.getElementById("comment-image-input");
      Object.defineProperty(input, "files", { configurable: true, value: [new window.File(["image"], "picture.png", { type: "image/png" })] });
      fire(input, "change");
      assert.equal(input.value, "");
      await decode.arrivedAtDecode();
      assert.equal(decode.gates.parked("image.decode").length, 1);
      if (scenario === "dispose and reopen") {
        owner.dispose();
        open();
        composer();
      } else if (scenario === "same-ID document replacement") {
        const before = S.state;
        open();
        assert.notEqual(S.state, before);
        assert.equal(S.state.docId, before.docId);
        composer();
      } else if (scenario === "stale completion after remount") {
        owner.dispose();
        replacement = mount();
        composer();
      } else if (scenario === "composer reopened") {
        closeCommentComposer(false);
        composer();
      } else if (scenario === "token change while held") {
        documentLocation().updateConnection({ token: "refreshed-" + Math.random() });
      } else if (scenario === "same-ID body replacement") {
        const body = document.getElementById("comment-body-editable");
        body.replaceWith(body.cloneNode(true));
      }
      const body = document.getElementById("comment-body-editable");
      body.innerHTML = "Replacement draft";
      const before = JSON.stringify(S.state);
      const modal = document.getElementById("comment-modal").innerHTML;
      const toast = document.getElementById("toast-host").innerHTML;
      decode.releaseDecode();
      await new Promise(setImmediate);
      assert.equal(decode.gates.parked("image.decode").length, 0);
      assert.equal(JSON.stringify(S.state), before);
      if (scenario === "normal completion" || scenario === "token change while held") {
        assert.equal(body.querySelectorAll("img").length, 1);
        assert.match(body.textContent, /Replacement draft/);
      } else {
        assert.equal(body.innerHTML, "Replacement draft");
        assert.equal(document.getElementById("comment-modal").innerHTML, modal);
        assert.equal(document.getElementById("toast-host").innerHTML, toast);
      }
    } finally {
      decode.gates.releaseAll("image.decode");
      await new Promise(setImmediate);
      restoreDecode();
      owner.dispose(); replacement?.dispose();
    }
  });
}

test("comments app: remount posts and replies once and dispose clears menus, drafts and armed deletion", () => {
  open();
  let owner = mount();
  openCommentsPanel();
  fire(document.querySelector('[data-action="toggle-reply"][data-id="c_one"]'), "click");
  const reply = document.querySelector('.reply-composer[data-for="c_one"] .cell-editable');
  reply.textContent = "Reply once";
  document.querySelector('.reply-composer[data-for="c_one"] .reply-name-input').value = "Ada";
  fire(document.querySelector('[data-action="reply-post"][data-id="c_one"]'), "click");
  assert.equal(S.state.comments[0].replies.length, 1);
  fire(document.querySelector('[data-action="comment-menu"][data-id="c_one"]'), "click");
  fire(document.querySelector('[data-action="delete-comment"][data-id="c_one"]'), "click");
  assert.equal(deleteConfirmation().armedId("comment"), "c_one");
  owner.dispose();
  assert.equal(deleteConfirmation().armedId("comment"), null);
  assert.equal(document.querySelector(".comment-menu"), null);
  owner = mount();
  try {
    openCommentsPanel();
    assert.equal(document.querySelector(".reply-composer"), null);
    composer();
    document.getElementById("comment-body-editable").textContent = "Post once";
    document.getElementById("comment-name").value = "Ada";
    fire(document.getElementById("comment-post"), "click");
    assert.equal(S.state.comments.filter((comment) => comment.body === "Post once").length, 1);
    const name = document.getElementById("comment-name");
    name.value = "A".repeat(100);
    fire(name, "input", { isComposing: true });
    assert.equal(name.value.length, 100);
    fire(name, "compositionend");
    assert.ok(name.value.length < 100);
  } finally { owner.dispose(); }
});
