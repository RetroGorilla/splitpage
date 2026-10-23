import "../../test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import type { CommentStatePorts } from "./ports.ts";
import { __init, captureCommentComposer, openCommentComposer, postComment } from "./comments.js";

test("tagging help listeners stop on disposal and install once on remount", () => {
  const fake = fixture(false);
  const card = document.createElement("div");
  card.id = "tagging-help";
  const dismiss = document.createElement("button");
  dismiss.id = "tagging-help-dismiss";
  card.append(dismiss);
  document.body.append(card);
  const owner = __init(fake.ports);
  dismiss.click();
  assert.equal(card.hidden, true);
  owner.dispose();
  card.hidden = false;
  dismiss.click();
  assert.equal(card.hidden, false);
  const next = __init(fake.ports);
  dismiss.click();
  assert.equal(card.hidden, true);
  next.dispose();
});

function fixture(reviewing: boolean) {
  document.body.innerHTML = '<div id="comment-modal" hidden><div id="comment-modal-quote"></div><input id="comment-name"><div id="comment-body-editable"></div></div><div id="comments-panel" hidden></div>';
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const clock = { nowIso: () => "2026-10-23T12:00:00.000Z" };
  const ports: CommentStatePorts = {
    sort: { current: () => "position", choose: (value) => value === "recent" ? "recent" : "position" },
    document: { current: () => null, read: (select) => select(null) },
    edits: { edit: () => { calls.push("edit"); return true; }, stamps: { clock, editor: { name: () => "Ada" } } },
    notices: { show: () => { calls.push("notice"); return { isConnected: false, dismiss: () => {}, removeEventListener: () => {} }; } },
    preferences: {
      clock: () => "24", commentAuthor: () => "Ada", rememberCommentAuthor: () => {},
      commentsSort: () => "position", setCommentsSort: () => {},
      commentFilter: () => ({ mode: "open", assignee: "" }), setCommentFilter: () => {},
      taggingHelpShown: () => {}, taggingHelpDismissed: () => {}
    },
    review: { reviewing: () => reviewing, refuseInReview: () => false },
    sidePanels: { open: () => {}, close: () => {} },
    text: {
      inertBody: (html) => { const body = document.createElement("div"); body.innerHTML = String(html); return body; },
      sanitizeHtml: (html) => String(html)
    },
    ids: { id: (prefix) => prefix + "_new" },
    clock,
    saves: { resume: () => { calls.push("resume"); }, dueNow: () => { calls.push("dueNow"); } },
    selection: { dropLink: () => {} },
    deletion: { armedId: () => null, arm: () => {}, disarm: () => {} },
    ownership: {
      capture: () => ({ epoch: 1, docId: "d1", destination: null, destinationGeneration: 1, generation: 1, connection: null, revision: null }),
      stillOwns: () => true
    },
    history: { keep: () => {} },
    presence: { personColor: () => "#000000" },
    shots: { reveal: () => {} },
    pictures: { imgHtml: () => "" },
    clearDraftUndo: () => {},
    onThreadsSent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
  return { ports, calls, listeners };
}

for (const reviewing of [false, true]) {
  test("posting requests an immediate save" + (reviewing ? " after resuming review autosave" : ""), () => {
    const fake = fixture(reviewing);
    const owner = __init(fake.ports);
    try {
      openCommentComposer({ id: "c_new", rowId: "r1", field: "audioText", quotedText: "Words" });
      const body = document.getElementById("comment-body-editable");
      assert.ok(body);
      body.innerHTML = "A comment";
      postComment();
      assert.deepEqual(fake.calls, reviewing ? ["edit", "resume", "dueNow"] : ["edit", "dueNow"]);
      assert.equal(document.getElementById("comment-modal")?.hidden, true);
      assert.equal(body.innerHTML, "");
    } finally {
      owner.dispose();
    }
    assert.equal(fake.listeners.size, 0);
  });
}

test("disposing cancels composer focus and releases the refresh callback, then remounts once", async () => {
  const fake = fixture(false);
  const owner = __init(fake.ports);
  openCommentComposer({ id: "c_new", rowId: "r1", field: "audioText", quotedText: "Words" });
  const resolveComposer = captureCommentComposer();
  owner.dispose();
  owner.dispose();
  assert.equal(resolveComposer(), null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.listeners.size, 0);
  assert.equal(document.getElementById("comment-modal")?.hidden, true);
  assert.notEqual(document.activeElement?.id, "comment-body-editable");
  const next = __init(fake.ports);
  assert.equal(fake.listeners.size, 1);
  next.dispose();
  assert.equal(fake.listeners.size, 0);
});
