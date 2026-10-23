import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { appActions } = await import("../legacy/app-actions.ts");
const { currentDocument } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { closeAnnotator } = await import("../js/05w-annotate.js");
const { closeCommentComposer } = await import("../js/10-comments.js");
const { closeTagComposer } = await import("../js/07-production-tags.js");
const { rowSlots, videoLinkKey } = await import("../core/document/gallery.ts");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const OPENERS = ["go-to-scene", "annotate-picture", "open-picture-link", "comment-on-selection", "tag-selection"];
const el = (id) => document.getElementById(id);

function open() {
  loadTestDocument(migrateRows({
    title: "Openers",
    docId: "d" + "e".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One two.", status: "todo", visualImage: PNG, imageLinks: [{ href: "https://example.com/clip" }] },
      { id: "r2", visualText: "Close", audioText: "Three four.", status: "todo" }
    ]
  }));
  flushEdits();
}

function noCanvas() {
  const real = window.HTMLCanvasElement.prototype.getContext;
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 0 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  window.HTMLCanvasElement.prototype.getContext = () => ctx;
  const realUrl = URL.createObjectURL;
  URL.createObjectURL = () => "blob:open-actions-test";
  return () => { window.HTMLCanvasElement.prototype.getContext = real; URL.createObjectURL = realUrl; };
}

test("the openers are registered actions that no menu lists", () => {
  for (const id of OPENERS) {
    const view = appActions.view(id);
    assert.ok(view, id + " is registered");
    assert.equal(view.visible, false, id + " stays out of the menus");
    assert.equal(view.enabled, true);
  }
});

test("running go-to-scene focuses that scene's words", () => {
  open();
  assert.equal(appActions.invoke("go-to-scene", "button", "r2").kind, "ran");
  assert.equal(document.activeElement, document.querySelector('#rows .row[data-id="r2"] .audio-cell .cell-editable'));
});

test("running comment-on-selection opens the comment composer on that quote", () => {
  open();
  try {
    assert.equal(appActions.invoke("comment-on-selection", "button", { id: "c1", rowId: "r1", field: "audioText", quotedText: "One" }).kind, "ran");
    assert.equal(el("comment-modal").hidden, false);
    assert.match(el("comment-modal-quote").textContent, /One/);
  } finally {
    closeCommentComposer();
  }
});

test("running tag-selection opens the tag composer on that quote", () => {
  open();
  try {
    assert.equal(appActions.invoke("tag-selection", "button", { rowId: "r1", field: "audioText", quotedText: "Three", occurrenceIndex: 0 }).kind, "ran");
    assert.equal(el("tag-modal").hidden, false);
    assert.equal(el("tag-quote").textContent, "Three");
  } finally {
    closeTagComposer();
  }
});

test("running annotate-picture opens the annotator on that picture", () => {
  open();
  const restore = noCanvas();
  try {
    assert.equal(appActions.invoke("annotate-picture", "button", { rowId: "r1", slot: 0 }).kind, "ran");
    assert.equal(el("annotate-modal").hidden, false);
    assert.equal(window.__annotateTest.state().at, 0);
  } finally {
    closeAnnotator();
    restore();
  }
});

test("running open-picture-link opens that link in a new window", (t) => {
  open();
  const opened = [];
  t.mock.method(window, "open", (href) => { opened.push(href); return null; });
  const link = rowSlots(currentDocument().rows[0])[0].links[0];
  assert.equal(appActions.invoke("open-picture-link", "button", { rowId: "r1", slot: 0, key: videoLinkKey(link) }).kind, "ran");
  assert.deepEqual(opened, ["https://example.com/clip"]);
});

test("an opener run without what to open fails and opens nothing", (t) => {
  open();
  const queued = [];
  t.mock.method(globalThis, "queueMicrotask", (job) => { queued.push(job); });
  assert.equal(appActions.invoke("tag-selection", "button").kind, "failed");
  assert.equal(appActions.invoke("annotate-picture", "button", { rowId: "r1" }).kind, "failed");
  assert.equal(el("tag-modal").hidden, true);
  assert.equal(el("annotate-modal").hidden, true);
  assert.equal(queued.length, 2, "both failures are reported");
});
