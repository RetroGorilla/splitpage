import "./_dom.mjs";
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
    assert.deepEqual(cell, [T("pick up "), T("the lamp", { cmt: ["c1"], tag: "t:prop:Lamp" }), T(" now")], classes);
    assert.equal(toHtml(cell), canonical, classes);
    assert.deepEqual(fromHtml(toHtml(cell)), cell, classes);
    assert.deepEqual(commentRange(cell, "c1"), { from: 8, to: 16 }, classes);
  }
  assert.deepEqual(fromHtml('<span class="stage-dir cmt-anchor" data-cmt="c2">aside</span>'),
    [T("aside", { cmt: ["c2"], dir: true })]);
  assert.deepEqual(fromHtml('a <span class="cmt-anchor tag-anchor" data-cmt="c3" data-tag-cat="nope" data-tag-name="">b</span>'),
    [T("a "), T("b", { cmt: ["c3"] })], "a tag the sanitiser refuses still leaves the comment");
  const state = {
    rows: [{ id: "r2", visualText: "", audioText: `<span class="cmt-anchor tag-anchor" data-cmt="c1" data-tag-cat="prop" data-tag-name="Lamp">lamp</span>` }],
    comments: [comment("c1", "r1", "audioText")]
  };
  assert.equal(syncCommentAnchors(state), 1);
  assert.equal(state.comments[0].rowId, "r2");
});

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const FUZZ_WORDS = ["the", "red mug", " ", "a b", "é", "x&lt;y", "&amp;", "&quot;q&quot;", "lamp "];
const FUZZ_CATS = ["prop", "location", "cast", "vfx", "sound", "gear"];
const FUZZ_NAMES = ["Lamp", "Red mug", "A &amp; B", "  spaced  "];
const FUZZ_FORMATS = ["", "", "strong", "em", "u", "s", "mark"];

function fuzzWords(r) {
  let out = "";
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) out += pick(r, FUZZ_WORDS);
  return out;
}
function fuzzFormat(r, inner) {
  const f = pick(r, FUZZ_FORMATS);
  return f ? `<${f}>${inner}</${f}>` : inner;
}
function fuzzSegment(r) {
  const roll = r();
  if (roll < 0.1) return { combined: "<br>", nested: "<br>" };
  if (roll < 0.45) { const t = fuzzFormat(r, fuzzWords(r)); return { combined: t, nested: t }; }
  const id = "c" + (1 + Math.floor(r() * 3));
  const cat = pick(r, FUZZ_CATS);
  const name = pick(r, FUZZ_NAMES);
  const classes = pick(r, ["cmt-anchor tag-anchor", "tag-anchor cmt-anchor", "x-paste tag-anchor cmt-anchor"]);
  const inner = fuzzFormat(r, fuzzWords(r));
  const tagAttrs = `data-tag-cat="${cat}" data-tag-name="${name}"`;
  return {
    combined: `<span class="${classes}" data-cmt="${id}" ${tagAttrs}>${inner}</span>`,
    nested: `<span class="cmt-anchor" data-cmt="${id}"><span class="tag-anchor" ${tagAttrs} contenteditable="false">${inner}</span></span>`
  };
}
function fuzzCell(r) {
  let combined = "", nested = "";
  const n = 1 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const s = fuzzSegment(r);
    combined += s.combined;
    nested += s.nested;
  }
  if (r() < 0.25) {
    combined = cmt("c9", combined);
    nested = cmt("c9", nested);
  }
  return { combined, nested };
}

test("seeded fuzz: comment-and-tag spans read as the nested spans toHtml writes, and round-trip (#280)", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { combined, nested } = fuzzCell(rng(seed));
    const msg = `seed ${seed}: ${combined}`;
    const cell = fromHtml(combined);
    assert.deepEqual(cell, fromHtml(nested), msg);
    assert.deepEqual(fromHtml(toHtml(cell)), cell, msg);
    assert.equal(sanitizeHtml(sanitizeHtml(combined)), sanitizeHtml(combined), msg);
    for (const id of new Set([...combined.matchAll(/data-cmt="(c\d)"/g)].map((m) => m[1]))) {
      assert.ok(commentRange(cell, id), `${msg} lost comment ${id}`);
    }
  }
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
