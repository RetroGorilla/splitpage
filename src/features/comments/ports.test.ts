import { deriveDocumentNumbering } from "../../core/document/numbering.ts";
import "../../test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import type { CommentStatePorts } from "./ports.ts";
import { startComments, captureCommentComposer, openCommentComposer, postComment, postReply, toggleReplyComposer, renderComments, armDeleteComment, closeCommentComposer } from "./comments.ts";
import { migrateRows } from "../../core/migrate.ts";
import { fakeMigration } from "../../../tests/core/migrate-ports.ts";

test("tagging help listeners stop on disposal and install once on remount", () => {
  const fake = fixture();
  const card = document.createElement("div");
  card.id = "tagging-help";
  const dismiss = document.createElement("button");
  dismiss.id = "tagging-help-dismiss";
  card.append(dismiss);
  document.body.append(card);
  const owner = startComments(fake.ports);
  dismiss.click();
  assert.equal(card.hidden, true);
  owner.dispose();
  card.hidden = false;
  dismiss.click();
  assert.equal(card.hidden, false);
  const next = startComments(fake.ports);
  dismiss.click();
  assert.equal(card.hidden, true);
  next.dispose();
});

test("Comments disposes its preference subscription", () => {
  const fake = fixture();
  let active = 0;
  const owner = startComments({ ...fake.ports, changes: { onChange: () => { active++; return () => { active--; }; } } });
  assert.equal(active, 1);
  owner.dispose();
  owner.dispose();
  assert.equal(active, 0);
});

function fixture() {
  document.body.innerHTML = '<div id="comment-modal" hidden><div id="comment-modal-quote"></div><input id="comment-name"><div id="comment-body-editable"></div></div><div id="comments-panel" hidden></div>';
  const calls: string[] = [];
  const clock = { nowIso: () => "2026-10-23T12:00:00.000Z" };
  const ports: CommentStatePorts = {
    sort: { current: () => "position", choose: (value) => value === "recent" ? "recent" : "position" },
    document: { numbering: () => deriveDocumentNumbering({ rows: [] }), current: () => null, read: (select) => select(null) },
    edits: { edit: () => { calls.push("edit"); return true; }, run: () => { throw new Error("a standalone caller ran a shared command"); },
      stamps: { clock, editor: { name: () => "Ada" } } },
    notices: { show: () => { calls.push("notice"); return { isConnected: false, dismiss: () => {}, removeEventListener: () => {} }; } },
    preferences: {
      clock: () => "24", commentAuthor: () => "Ada", rememberCommentAuthor: () => {},
      commentsSort: () => "position", setCommentsSort: () => {},
      commentFilter: () => ({ mode: "open", assignee: "" }), setCommentFilter: () => {},
      taggingHelpShown: () => {}, taggingHelpDismissed: () => {}
    },
    changes: { onChange: () => () => {} },
    sidePanels: { open: () => {}, close: () => {} },
    text: {
      inertBody: (html) => { const body = document.createElement("div"); body.innerHTML = String(html); return body; },
      sanitizeHtml: (html) => String(html)
    },
    ids: { id: (prefix) => prefix + "_new" },
    clock,
    saves: { dueNow: () => { calls.push("dueNow"); } },
    selection: { dropLink: () => {} },
    deletion: { armedId: () => null, arm: () => {}, disarm: () => {} },
    ownership: {
      capture: () => ({ epoch: 1, docId: "d1", destination: null, destinationGeneration: 1, generation: 1 }),
      stillOwns: () => true
    },
    history: { keep: () => {} },
    personColors: { personColor: () => "#000000" },
    shots: { reveal: () => {} },
    pictures: { imgHtml: () => "" },
    clearDraftUndo: () => {},
    shared: { ports: () => null, refused: () => { throw new Error("a standalone caller reported a shared refusal"); } }
  };
  return { ports, calls };
}

test("posting requests an immediate save", () => {
  const fake = fixture();
  const owner = startComments(fake.ports);
  try {
    openCommentComposer({ id: "c_new", rowId: "r1", field: "audioText", quotedText: "Words" });
    const body = document.getElementById("comment-body-editable");
    assert.ok(body);
    body.innerHTML = "A comment";
    postComment();
    assert.deepEqual(fake.calls, ["edit", "dueNow"]);
    assert.equal(document.getElementById("comment-modal")?.hidden, true);
    assert.equal(body.innerHTML, "");
  } finally {
    owner.dispose();
  }
});

test("standalone reply removes composer state before synchronous repaint and sends immediately after the edit, as on main", () => {
  const fake = fixture();
  const doc = { ...migrateRows({}, fakeMigration().ports), comments: [{ id: "C1", rowId: "r1", field: "audioText", anchorId: "C1", author: "Ann", body: "First", replies: [] }] };
  const panel = document.getElementById("comments-panel") as HTMLElement;
  panel.hidden = false;
  panel.innerHTML = '<div id="comments-list"></div>';
  const calls: unknown[] = [];
  const owner = startComments({ ...fake.ports,
    document: { ...fake.ports.document, current: () => doc },
    edits: { ...fake.ports.edits, edit: () => {
      renderComments();
      calls.push(["edit repaint", document.querySelector(".reply-composer") !== null]);
      return true;
    } },
    saves: { dueNow: () => { calls.push(["send", document.querySelector(".reply-composer") !== null]); } }
  });
  try {
    toggleReplyComposer("C1");
    const body = document.querySelector(".reply-composer .cell-editable") as HTMLElement;
    body.innerHTML = "Reply";
    postReply("C1");
    assert.deepEqual(calls, [["edit repaint", false], ["send", false]]);
  } finally { owner.dispose(); }
});

test("standalone comment cancellation hides the modal before editing the anchor, as on main", () => {
  const fake = fixture();
  const calls: unknown[] = [];
  const owner = startComments({ ...fake.ports, edits: { ...fake.ports.edits, edit: () => {
    calls.push(["edit", document.getElementById("comment-modal")?.hidden]); return true;
  } } });
  try {
    openCommentComposer({ id: "C1", rowId: "r1", field: "audioText", quotedText: "Words" });
    closeCommentComposer(true);
    assert.deepEqual(calls, [["edit", true]]);
  } finally { owner.dispose(); }
});

test("standalone deletion removes reply state before synchronous repaint, as on main", () => {
  const fake = fixture();
  const doc = { ...migrateRows({}, fakeMigration().ports), comments: [{ id: "C1", rowId: "r1", field: "audioText", anchorId: "C1", author: "Ann", body: "First", replies: [] }] };
  const panel = document.getElementById("comments-panel") as HTMLElement;
  panel.hidden = false; panel.innerHTML = '<div id="comments-list"></div>';
  const calls: unknown[] = [];
  const owner = startComments({ ...fake.ports,
    document: { ...fake.ports.document, current: () => doc },
    deletion: { ...fake.ports.deletion, armedId: () => "C1" },
    edits: { ...fake.ports.edits, edit: () => { renderComments(); calls.push(document.querySelector(".reply-composer") !== null); return true; } }
  });
  try {
    toggleReplyComposer("C1");
    armDeleteComment(document.createElement("button"), "C1");
    assert.deepEqual(calls, [false]);
  } finally { owner.dispose(); }
});

test("disposing cancels composer focus, then remounts once", async () => {
  const fake = fixture();
  const owner = startComments(fake.ports);
  openCommentComposer({ id: "c_new", rowId: "r1", field: "audioText", quotedText: "Words" });
  const resolveComposer = captureCommentComposer();
  owner.dispose();
  owner.dispose();
  assert.equal(resolveComposer(), null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(document.getElementById("comment-modal")?.hidden, true);
  assert.notEqual(document.activeElement?.id, "comment-body-editable");
  const next = startComments(fake.ports);
  next.dispose();
});
