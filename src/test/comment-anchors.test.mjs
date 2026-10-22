import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { commentRange, fromHtml, joinCells, splitCell, syncCommentAnchors, toHtml } from "../js/04c-doc-model.js";
import { sanitizeHtml } from "../js/04-richtext.js";
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
  assert.deepEqual([state.comments[0].rowId, state.comments[0].field], ["r2", "visualText"]);
  assert.deepEqual([state.comments[1].rowId, state.comments[1].field], ["r3", "audioText"]);
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
  const [, tail] = splitCell(cell, 6);
  state.rows[0].audioText = "Alpha ";
  state.rows[1].audioText = toHtml(tail);
  assert.equal(syncCommentAnchors(state), 1);
  assert.equal(state.comments[0].rowId, "r2");
});

test("joinCells' glue takes the comment and link both sides share, and never formatting", () => {
  const c = { cmt: ["c1"] };
  assert.deepEqual(joinCells([T("bra", c)], [T("vo", c)], " "), [T("bra vo", c)]);
  const cell = fromHtml("Alpha " + cmt("c1", "bravo charlie") + " delta");
  const [a, b] = splitCell(cell, 9);
  assert.deepEqual(commentRange(joinCells(a, b, " "), "c1"), { from: 6, to: 20 });
  assert.deepEqual(joinCells([T("a", c)], [T("b")], " "), [T("a", c), T(" b")]);
  assert.deepEqual(joinCells([T("a", { cmt: ["c1", "c2"] })], [T("b", { cmt: ["c2"] })], " "),
    [T("a", { cmt: ["c1", "c2"] }), T(" b", { cmt: ["c2"] })]);
  const l = { href: "https://example.com/" };
  assert.deepEqual(joinCells([T("a", l)], [T("b", l)], " "), [T("a b", l)]);
  assert.deepEqual(joinCells([T("a", { b: true })], [T("b", { b: true })], " "), [T("a", { b: true }), T(" "), T("b", { b: true })]);
  assert.deepEqual(joinCells([T("a", c)], [T("b", c)]), [T("ab", c)]);
});

test("a span that is both a comment anchor and a tag keeps both marks (#280)", () => {
  const tagged = (inner) =>
    `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp" contenteditable="false">${inner}</span>`;
  const canonical = "pick up " + cmt("c1", tagged("the lamp")) + " now";
  for (const classes of ["cmt-anchor tag-anchor", "tag-anchor cmt-anchor"]) {
    const html = `pick up <span class="${classes}" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp">the lamp</span> now`;
    assert.equal(sanitizeHtml(html), canonical, classes);
    const cell = fromHtml(html);
    assert.deepEqual(cell, [T("pick up "), T("the lamp", { tag: "t:prop:Lamp", cmt: ["c1"] }), T(" now")], classes);
    assert.equal(toHtml(cell), canonical, classes);
    assert.deepEqual(fromHtml(toHtml(cell)), cell, classes);
    assert.deepEqual(commentRange(cell, "c1"), { from: 8, to: 16 }, classes);
  }
  const brollCell = fromHtml('<span class="broll-key cmt-anchor" data-cmt="c2" data-broll-id="k1">B-roll:</span> x');
  assert.ok(commentRange(brollCell, "c2"), "a comment on a b-roll key is found");
  const state = {
    rows: [{ id: "r2", visualText: "", audioText: `<span class="cmt-anchor tag-anchor" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp">lamp</span>` }],
    comments: [comment("c1", "r1", "audioText")]
  };
  assert.equal(syncCommentAnchors(state), 1);
  assert.equal(state.comments[0].rowId, "r2");
});

test("migrateRows points a stale comment at its words — an old file, or a merge that moved them", () => {
  const s = migrateRows({
    schema: 2,
    rows: [{ id: "r1", visualText: "", audioText: "Alpha" }, { id: "r2", visualText: "", audioText: cmt("c1", "bravo") }],
    comments: [comment("c1", "r1", "audioText", { author: "Ann", body: "about bravo" })]
  });
  assert.equal(s.comments[0].rowId, "r2");

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
