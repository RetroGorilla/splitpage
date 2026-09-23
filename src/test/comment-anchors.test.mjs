/* A comment's anchor is its mark (#85, docs/DOCUMENT-MODEL.md §3.2).
 *
 * comment.rowId / comment.field only say where the comment's cmt mark is;
 * syncCommentAnchors (04c-doc-model.js) is the one function that keeps
 * them in step, run wherever words move between scenes: a split, a join, a
 * cut-and-paste, and every merge and load (migrateRows). joinCells' glue
 * keeps a comment one anchor when a split through its phrase is joined
 * back. The live half — Enter, Alt+Enter, Backspace, the card, Ctrl+Z — is
 * browser suite 78-split-join-model.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { commentRange, fromHtml, joinCells, splitCell, syncCommentAnchors, toHtml } from "../js/04c-doc-model.js";
import { migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";

const T = (text, marks) => ({ text, marks: marks || {} });
const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const comment = (id, rowId, field, extra) =>
  Object.assign({ id, rowId, field, anchorId: id, quotedText: "", kind: "anchor", replies: [] }, extra || {});

test("a comment points at the first cell holding its mark, in document order", () => {
  const state = {
    rows: [
      { id: "r1", visualText: "one", audioText: "plain" },
      { id: "r2", visualText: "see " + cmt("c1", "this"), audioText: "and " + cmt("c1", "that") },
      { id: "r3", visualText: "", audioText: cmt("c2", "later") + " " + cmt("c1", "again") }
    ],
    comments: [comment("c1", "r1", "audioText"), comment("c2", "r1", "audioText")]
  };
  assert.equal(syncCommentAnchors(state), 2);
  /* the visual column comes before the audio, as the panel sorts them */
  assert.deepEqual([state.comments[0].rowId, state.comments[0].field], ["r2", "visualText"]);
  assert.deepEqual([state.comments[1].rowId, state.comments[1].field], ["r3", "audioText"]);
  /* already in step: nothing to do */
  assert.equal(syncCommentAnchors(state), 0);
});

test("a comment whose mark is nowhere keeps what it had; cards and title comments are never moved", () => {
  const state = {
    rows: [{ id: "r1", visualText: "", audioText: cmt("c9", "words") }],
    comments: [
      comment("c1", "gone", "audioText"),
      comment("c9", "r0", "visualText", { kind: "conflict", anchorId: "c9" }),
      comment("c8", null, "title", { anchorId: null })
    ]
  };
  assert.equal(syncCommentAnchors(state), 0);
  assert.deepEqual(state.comments.map((c) => [c.rowId, c.field]), [["gone", "audioText"], ["r0", "visualText"], [null, "title"]]);
});

test("the anchor id falls back to the comment's own id; no comments, no rows, no work", () => {
  const state = { rows: [{ id: "r2", audioText: cmt("c3", "x") }], comments: [{ id: "c3", rowId: "r1", field: "audioText" }] };
  assert.equal(syncCommentAnchors(state), 1);
  assert.equal(state.comments[0].rowId, "r2");
  assert.equal(syncCommentAnchors({ rows: [] }), 0);
  assert.equal(syncCommentAnchors({ rows: [{ id: "r1", audioText: cmt("c1", "x") }], comments: [] }), 0);
  assert.equal(syncCommentAnchors(null), 0);
});

test("a split through a commented phrase marks both halves; the comment points at the first", () => {
  const cell = fromHtml("Alpha " + cmt("c1", "bravo charlie") + " delta");
  const [a, b] = splitCell(cell, 11);
  const state = {
    rows: [{ id: "r1", visualText: "", audioText: toHtml(a) }, { id: "r2", visualText: "", audioText: toHtml(b) }],
    comments: [comment("c1", "r1", "audioText")]
  };
  assert.equal(state.rows[0].audioText, "Alpha " + cmt("c1", "bravo"));
  assert.equal(state.rows[1].audioText, cmt("c1", " charlie") + " delta");
  assert.equal(syncCommentAnchors(state), 0);
  /* split right before the phrase: all of it goes, and the comment with it */
  const [, tail] = splitCell(cell, 6);
  state.rows[0].audioText = "Alpha ";
  state.rows[1].audioText = toHtml(tail);
  assert.equal(syncCommentAnchors(state), 1);
  assert.equal(state.comments[0].rowId, "r2");
});

test("joinCells' glue takes the comment and link both sides share, and never formatting", () => {
  const c = { cmt: ["c1"] };
  assert.deepEqual(joinCells([T("bra", c)], [T("vo", c)], " "), [T("bra vo", c)]);
  /* one anchor again after a split and a join: the whole phrase, space and all */
  const cell = fromHtml("Alpha " + cmt("c1", "bravo charlie") + " delta");
  const [a, b] = splitCell(cell, 9);
  assert.deepEqual(commentRange(joinCells(a, b, " "), "c1"), { from: 6, to: 20 });
  /* on one side only: the glue is outside it */
  assert.deepEqual(joinCells([T("a", c)], [T("b")], " "), [T("a", c), T(" b")]);
  /* two comments, one shared */
  assert.deepEqual(joinCells([T("a", { cmt: ["c1", "c2"] })], [T("b", { cmt: ["c2"] })], " "),
    [T("a", { cmt: ["c1", "c2"] }), T(" b", { cmt: ["c2"] })]);
  /* a link both sides are in; bold on both sides stays off the space */
  const l = { href: "https://example.com/" };
  assert.deepEqual(joinCells([T("a", l)], [T("b", l)], " "), [T("a b", l)]);
  assert.deepEqual(joinCells([T("a", { b: true })], [T("b", { b: true })], " "), [T("a", { b: true }), T(" "), T("b", { b: true })]);
  /* no glue asked for: nothing added */
  assert.deepEqual(joinCells([T("a", c)], [T("b", c)]), [T("ab", c)]);
});

test("migrateRows points a stale comment at its words — an old file, or a merge that moved them", () => {
  const s = migrateRows({
    schema: 2,
    rows: [{ id: "r1", visualText: "", audioText: "Alpha" }, { id: "r2", visualText: "", audioText: cmt("c1", "bravo") }],
    comments: [comment("c1", "r1", "audioText", { author: "Ann", body: "about bravo" })]
  });
  assert.equal(s.comments[0].rowId, "r2");

  /* one side split the scene, carrying the commented words into a new one;
     the other side resolved the comment, its rowId still the old scene */
  const base = migrateRows({
    schema: 2,
    rows: [{ id: "r1", visualText: "one", audioText: "Alpha " + cmt("c1", "bravo") }],
    comments: [comment("c1", "r1", "audioText", { author: "Ann", body: "about bravo", createdAt: "2026-09-01T10:00:00Z" })]
  });
  const mine = JSON.parse(JSON.stringify(base));
  mine.rows[0].audioText = "Alpha ";
  mine.rows.push({ id: "r2", visualText: "", audioText: cmt("c1", "bravo"), status: "todo" });
  mine.comments[0].rowId = "r2";
  const theirs = JSON.parse(JSON.stringify(base));
  theirs.comments[0].resolved = true;
  theirs.comments[0].updatedAt = "2026-09-02T10:00:00Z";
  const merged = mergeStates(base, mine, theirs).merged;
  const c1 = merged.comments.find((c) => c.id === "c1");
  assert.equal(merged.rows.find((r) => r.id === "r2").audioText, cmt("c1", "bravo"));
  assert.deepEqual([c1.rowId, c1.field], ["r2", "audioText"]);
});
