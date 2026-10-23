import "../../test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createComments } from "./comments.js";

test("author preferences stay behind the injected preference port", () => {
  let author = "  Ada  ";
  const comments = createComments({
    operations: {}, history: {},
    preferences: () => ({
      commentAuthor: () => author,
      rememberCommentAuthor: (name: string) => { author = name; }
    })
  });
  assert.equal(comments.getSavedAuthorName(), "Ada");
  comments.saveAuthorName("  Grace  ");
  assert.equal(author, "Grace");
  assert.equal(comments.getSavedAuthorName(), "Grace");
});

test("composer callbacks retain document and composer ownership through the transitions port", () => {
  document.body.innerHTML = '<div id="comment-modal"><div id="comment-body-editable"></div></div>';
  let owned = true;
  const operation = { connection: "first" };
  const comments = createComments({
    operations: { capture: () => operation, stillOwns: () => owned }, history: {}
  });
  const resolve = comments.captureCommentComposer();
  assert.equal(resolve(), document.getElementById("comment-body-editable"));
  owned = false;
  assert.equal(resolve(), null);
  owned = true;
  const body = document.getElementById("comment-body-editable");
  assert.ok(body);
  body.replaceWith(body.cloneNode(true));
  assert.equal(resolve(), null);
});

test("closing the composer uses the selection port and invalidates outstanding callbacks", () => {
  document.body.innerHTML = '<div id="comment-modal"><div id="comment-body-editable">Draft</div></div>';
  const calls: string[] = [];
  const comments = createComments({
    operations: { capture: () => ({ connection: null }), stillOwns: () => true }, history: {},
    selection: { dropLink: () => { calls.push("drop-link"); } },
    resetDraftHistory: () => { calls.push("reset-history"); }
  });
  const resolve = comments.captureCommentComposer();
  comments.closeCommentComposer(false);
  assert.deepEqual(calls, ["drop-link", "reset-history"]);
  assert.equal(resolve(), null);
  assert.equal(document.getElementById("comment-body-editable")?.innerHTML, "");
  assert.equal(document.getElementById("comment-modal")?.hidden, true);
});
