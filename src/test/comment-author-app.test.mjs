import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollIntoView = function () {};
window.Element.prototype.scrollBy = function () {};
await bootApp();
const { adoptReplacement } = await import("../bootstrap/wiring/session-owner.ts");
const { preferences } = await import("../bootstrap/wiring/preferences-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { mountDocumentChromeFeature, stopDocumentChromeFeature } = await import("../bootstrap/wiring/document-chrome.ts");
const { mountCommentsFeature } = await import("../bootstrap/wiring/comments.ts");
const { currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { render } = await import("../features/rows/render.ts");
const { openCommentComposer } = await import("../features/comments/comments.ts");
after(() => {
  stopDocumentChromeFeature();
  closeApp();
});

const KEY = "splitpage-comment-author";
const el = (id) => document.getElementById(id);

function script(title, docId, comments = []) {
  return migrateRows({
    title: title,
    docId: "d" + docId.repeat(32),
    rows: [{ id: "r1", visualText: "Wide", audioText: "One two.", status: "todo" }],
    comments: comments
  });
}

function openScript(title, docId) {
  adoptReplacement(script(title, docId));
  render();
}

function comment(name, body) {
  openCommentComposer({ id: "c_" + body, rowId: "r1", field: "audioText", quotedText: "One" });
  el("comment-name").value = name;
  el("comment-body-editable").innerHTML = body;
  el("comment-post").click();
}

test("a name given in the comment box is the app's name: it shows on the chip and carries to the next script", () => {
  localStorage.removeItem(KEY);
  mountDocumentChromeFeature();
  const owner = mountCommentsFeature();
  owner.mountRoots();
  owner.mountControls();
  try {
    openScript("First", "a");
    assert.equal(el("identity-name").textContent, "Set your name");
    comment("Ann Lee", "Hello");
    assert.equal(localStorage.getItem(KEY), "Ann Lee");
    assert.equal(el("identity-name").textContent, "Ann Lee");
    openScript("Second", "b");
    assert.equal(el("identity-name").textContent, "Ann Lee");
    openCommentComposer({ id: "c_next", rowId: "r1", field: "audioText", quotedText: "One" });
    assert.equal(el("comment-name").value, "Ann Lee");
    assert.equal(preferences().commentAuthor(), "Ann Lee");
  } finally {
    owner.dispose();
    localStorage.removeItem(KEY);
  }
});

test("a new app name signs the next comment; the comments already written keep the name they were signed with", () => {
  localStorage.removeItem(KEY);
  mountDocumentChromeFeature();
  const owner = mountCommentsFeature();
  owner.mountRoots();
  owner.mountControls();
  const authors = () => currentDocument().comments.map((c) => c.author);
  try {
    openScript("First", "a");
    comment("Ann Lee", "One");
    preferences().setCommentAuthor("Bo Park");
    openScript("Second", "b");
    openCommentComposer({ id: "c_next", rowId: "r1", field: "audioText", quotedText: "One" });
    assert.equal(el("comment-name").value, "Bo Park");
    comment("Bo Park", "Two");
    assert.deepEqual(authors(), ["Bo Park"]);
    adoptReplacement(script("First again", "a", [{ id: "c_old", kind: "anchor", rowId: "r1", field: "audioText", anchorId: "c_old", quotedText: "One", author: "Ann Lee", body: "Old", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", resolved: false, replies: [] }]));
    comment("Bo Park", "Three");
    assert.deepEqual(authors(), ["Ann Lee", "Bo Park"]);
    assert.equal(preferences().commentAuthor(), "Bo Park");
  } finally {
    owner.dispose();
    localStorage.removeItem(KEY);
  }
});

test("posting under the name already stored does not announce it again", () => {
  localStorage.removeItem(KEY);
  mountDocumentChromeFeature();
  const owner = mountCommentsFeature();
  owner.mountRoots();
  owner.mountControls();
  const heard = [];
  const listen = (event) => { if (event.detail.key === KEY) heard.push(event.detail.value); };
  const nodeCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  document.addEventListener("splitpage:pref", listen);
  try {
    openScript("First", "a");
    comment("Ann Lee", "One");
    comment("Ann Lee", "Two");
    assert.deepEqual(heard, ["Ann Lee"]);
  } finally {
    document.removeEventListener("splitpage:pref", listen);
    globalThis.CustomEvent = nodeCustomEvent;
    owner.dispose();
    localStorage.removeItem(KEY);
  }
});
