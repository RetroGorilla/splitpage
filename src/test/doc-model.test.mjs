/* The structured document model (#85, step 1 of docs/DOCUMENT-MODEL.md §10):
 * src/js/04c-doc-model.js, pure, with nothing in the app calling it yet.
 *
 * What has to hold before any reader or writer is moved onto it:
 *   - fromHtml/toHtml round-trip: toHtml's output is a fixed point of the
 *     sanitiser, and reading it back gives the same cell;
 *   - the three readers give exactly what the HTML readers they will
 *     replace (htmlToPlainText, htmlToMarkdown, htmlToRuns) give for the
 *     same cell's HTML;
 *   - edits, steps and their inverses, and the three-way merge.
 * Every property is checked on hand-written cells covering every construct
 * the sanitiser keeps, on the demo document, and on seeded random cells.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addComment, applySteps, cellLength, commentIds, commentRange, deleteRange, fromHtml, insertBrollKey,
  insertText, invertSteps, joinCells, marksAt, mergeCells, normalizeCell, projection, removeComment,
  replaceText, retag, sameCell, setMark, sliceCell, splitCell, tagIds, toDocxRuns, toHtml, toMarkdown,
  toPlainText, touchedCells
} from "../js/04c-doc-model.js";
import { htmlToMarkdown, sanitizeHtml } from "../js/04-richtext.js";
import { htmlToPlainText, htmlToRuns } from "../js/14-export.js";

const T = (text, marks) => ({ text, marks: marks || {} });
const B = (id, text, marks) => ({ atom: "broll", id, text: text || "B-roll:", marks: marks || {} });
const tagSpan = (cat, name, inner) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${inner}</span>`;

/* Every construct the sanitiser keeps, alone and nested, plus the messy
   input it is there for. */
const FIXTURES = [
  "",
  "plain words",
  "two&nbsp; spaces and a&nbsp;no-break",
  "line one<br>line two<br>",
  "<br><br>",
  "a <strong>bold</strong> and <em>italic</em>, <u>under</u>, <s>struck</s>, <mark>lit</mark>",
  "<strong><em>both</em></strong> <em><strong>both again</strong></em>",
  "<strong>bold <em>then both</em> then bold</strong>",
  'a <a href="https://example.com/x?a=1&amp;b=2" target="_blank" rel="noopener">link</a> here',
  '<a href="mailto:me@example.com" target="_blank" rel="noopener"><strong>mail</strong> me</a>',
  "pick up the " + tagSpan("prop", "Red mug", "red mug") + " now",
  tagSpan("location", "Kitchen", "<strong>Kit</strong>chen") + " at dawn",
  tagSpan("cast", "A &amp; B", "a &amp; b"),
  'she said <span class="cmt-anchor" data-cmt="c1">something <strong>bold</strong></span> then',
  '<span class="cmt-anchor" data-cmt="c1">one <span class="cmt-anchor" data-cmt="c2">two</span></span><span class="cmt-anchor" data-cmt="c2"> three</span>',
  '<span class="cmt-anchor" data-cmt="c9">around ' + tagSpan("prop", "Lamp", "the lamp") + "</span>",
  '<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span> drone over the hills<br>second line',
  'Intro<br><span class="broll-key" data-broll-id="bs_2" contenteditable="false">b roll —</span> city',
  '<div>para one</div><div><br></div><div>para <b>three</b></div>',
  '<p style="color:red">styled <span style="font-weight:700">heavy</span> and <span style="font-style:italic;text-decoration:underline">slanted</span></p>',
  '<span style="background-color: yellow">highlighted</span> <font face="x">font</font> <script>alert(1)</script>',
  "<ul><li>one</li><li>two</li></ul>",
  "x &lt;b&gt; not a tag &amp; amp",
  "caret\u200Bspot",
  '<a href="javascript:alert(1)">bad link</a>',
  '<strong>b</strong><strong>b</strong><em></em>end',
  "tab\there"
];

const seed = JSON.parse(readFileSync(new URL("../seed-state.json", import.meta.url), "utf8"));
for (const r of seed.rows) FIXTURES.push(r.visualText || "", r.audioText || "");

/* ---- seeded random cells ---- */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const WORDS = ["the", "red", "mug", "a\u00a0b", "line\nbreak", " ", "  ", "é", "x<y", "&", "\n", "\"q\"", "'s", "tab\t"];
function randomCell(r) {
  const n = Math.floor(r() * 12);
  const cell = [];
  for (let i = 0; i < n; i++) {
    if (r() < 0.07) { cell.push(B("bs" + Math.floor(r() * 3), r() < 0.5 ? "B-roll:" : "b-roll -", r() < 0.3 ? { b: true, cmt: ["c1"] } : {})); continue; }
    const m = {};
    if (r() < 0.3) m.b = true;
    if (r() < 0.2) m.i = true;
    if (r() < 0.1) m.u = true;
    if (r() < 0.1) m.s = true;
    if (r() < 0.1) m.hl = true;
    if (r() < 0.1) m.href = "https://e.x/" + Math.floor(r() * 2);
    if (r() < 0.2) m.tag = "t:prop:Item " + Math.floor(r() * 2);
    if (r() < 0.25) m.cmt = ["c" + Math.floor(r() * 3), ...(r() < 0.3 ? ["c9"] : [])];
    cell.push(T(WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.5 ? " " : ""), m));
  }
  return cell;
}
const RANDOM = [];
{ const r = rng(85); for (let i = 0; i < 400; i++) RANDOM.push(randomCell(r)); }

/* ---- reading and writing HTML ---- */

test("fromHtml reads each construct into runs and marks", () => {
  assert.deepEqual(fromHtml("a <strong>b</strong>"), [T("a "), T("b", { b: true })]);
  assert.deepEqual(fromHtml("x<br>y"), [T("x\ny")]);
  assert.deepEqual(fromHtml("pick " + tagSpan("prop", "Red mug", "red mug")),
    [T("pick "), T("red mug", { tag: "t:prop:Red mug" })]);
  assert.deepEqual(fromHtml('<span class="cmt-anchor" data-cmt="c2">x</span>'), [T("x", { cmt: ["c2"] })]);
  assert.deepEqual(fromHtml('<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span> hills'),
    [B("bs_1", "B-roll:"), T(" hills")]);
  assert.deepEqual(fromHtml('<a href="https://e.x/">l</a>'), [T("l", { href: "https://e.x/" })]);
});

test("fromHtml takes the registry's id for a tag when told how", () => {
  const ids = { "prop|Red mug": "t_1" };
  const cell = fromHtml(tagSpan("prop", "Red mug", "mug"), { tagId: (c, n) => ids[c + "|" + n] });
  assert.deepEqual(cell, [T("mug", { tag: "t_1" })]);
  assert.equal(toHtml(cell, { tagOf: (id) => (id === "t_1" ? { cat: "prop", name: "Red mug" } : null) }),
    tagSpan("prop", "Red mug", "mug"));
  /* a tag the registry cannot name is written as its text */
  assert.equal(toHtml(cell, { tagOf: () => null }), "mug");
});

test("pictures and video cards are handed over and left out (design D7)", () => {
  const sha = "a".repeat(64);
  const media = [];
  const cell = fromHtml(`see <img class="comment-img" data-blob="${sha}" data-w="4" data-h="3" data-mime="image/png"> and ` +
    '<a class="video-embed-card" href="https://youtu.be/x" target="_blank" rel="noopener"><span>▶</span></a>!',
  { onMedia: (m) => media.push(m) });
  assert.deepEqual(cell, [T("see  and !")]);
  assert.deepEqual(media, [
    { kind: "image", ref: { sha256: sha, width: 4, height: 3, mime: "image/png" } },
    { kind: "video", href: "https://youtu.be/x" }
  ]);
});

test("toHtml writes the sanitiser's own markup: a fixed point of sanitizeHtml", () => {
  for (const html of FIXTURES) {
    const out = toHtml(fromHtml(html));
    assert.equal(sanitizeHtml(out), out, JSON.stringify(html));
  }
  for (const cell of RANDOM) {
    const out = toHtml(cell);
    assert.equal(sanitizeHtml(out), out, JSON.stringify(cell));
  }
});

test("round trip: fromHtml(toHtml(c)) is normalizeCell(c)", () => {
  for (const html of FIXTURES) {
    const cell = fromHtml(html);
    assert.deepEqual(fromHtml(toHtml(cell)), cell, JSON.stringify(html));
  }
  for (const cell of RANDOM) {
    assert.deepEqual(fromHtml(toHtml(cell)), normalizeCell(cell), JSON.stringify(cell));
  }
});

test("a cell keeps the words the stored HTML shows", () => {
  for (const html of FIXTURES) {
    const clean = sanitizeHtml(html);
    /* a line feed inside a text node shows as a space (white-space: normal),
       and a zero-width space is a caret spot, never content */
    const shown = htmlToPlainText(clean.replace(/\n/g, " ").replace(/\u200B/g, ""));
    assert.equal(toPlainText(fromHtml(html)), shown, JSON.stringify(html));
  }
});

test("the three readers agree with the HTML readers they replace", () => {
  const cells = FIXTURES.map((h) => fromHtml(h)).concat(RANDOM);
  for (const cell of cells) {
    const html = toHtml(cell);
    assert.equal(toPlainText(cell), htmlToPlainText(html), html);
    assert.equal(toMarkdown(cell), htmlToMarkdown(html), html);
    assert.deepEqual(toDocxRuns(cell), htmlToRuns(html), html);
  }
});

/* ---- canonical form ---- */

test("normalizeCell: one canonical form", () => {
  assert.deepEqual(normalizeCell([T("a", { b: true }), T("b", { b: true }), T(""), T("c")]),
    [T("ab", { b: true }), T("c")]);
  assert.deepEqual(normalizeCell([T("x", { cmt: ["c2", "c1", "c2"], b: false, href: "javascript:x" })]),
    [T("x", { cmt: ["c1", "c2"] })]);
  assert.deepEqual(normalizeCell([T("a\r\nb\u0007\u200B\uFFFC")]), [T("a\nb")]);
  assert.deepEqual(normalizeCell([B("bs1", "not a marker")]), [T("not a marker")]);
  assert.deepEqual(normalizeCell([T("x", { tag: "t1", cmt: ["c1"] })], { hasTag: () => false, hasComment: () => false }), [T("x")]);
  for (const cell of RANDOM) assert.deepEqual(normalizeCell(normalizeCell(cell)), normalizeCell(cell));
  assert.ok(sameCell([T("a"), T("b")], [T("ab")]));
});

test("a comment or link covers all of a tag or none of it", () => {
  const cell = normalizeCell([T("re", { tag: "t:prop:Mug", cmt: ["c1"] }), T("d mug", { tag: "t:prop:Mug", href: "https://e.x/" })]);
  assert.deepEqual(cell, [T("red mug", { href: "https://e.x/", tag: "t:prop:Mug", cmt: ["c1"] })]);
  /* so toHtml never splits one tag into two spans */
  const html = toHtml([T("ab", { tag: "t:prop:X", cmt: ["c1"] }), T("cd", { tag: "t:prop:X" }), T("ef", { cmt: ["c1"] })]);
  assert.equal((html.match(/tag-anchor/g) || []).length, 1, html);
});

test("elements nest in one fixed order, and stay open across runs that share them", () => {
  assert.equal(toHtml([T("a", { b: true, cmt: ["c1"] }), T("b", { cmt: ["c1"] })]),
    '<span class="cmt-anchor" data-cmt="c1"><strong>a</strong>b</span>');
  assert.equal(toHtml(fromHtml("<em><strong>x</strong></em>")), "<strong><em>x</em></strong>");
  assert.equal(toHtml([T("a\u00a0 <b>&")]), "a&nbsp; &lt;b&gt;&amp;");
});

/* ---- positions and edits ---- */

test("positions: an atom is one character", () => {
  const cell = [T("ab"), B("bs1"), T(" cd")];
  assert.equal(projection(cell), "ab\uFFFC cd");
  assert.equal(cellLength(cell), 6);
  assert.deepEqual(sliceCell(cell, 1, 4), [T("b"), B("bs1"), T(" ")]);
});

test("insertText carries formatting on, never a tag, comment or link", () => {
  const cell = [T("bold", { b: true, cmt: ["c1"], href: "https://e.x/" }), T(" tag", { tag: "t:prop:X" })];
  assert.deepEqual(insertText(cell, 4, "er"), [T("bold", { b: true, href: "https://e.x/", cmt: ["c1"] }), T("er", { b: true }), T(" tag", { tag: "t:prop:X" })]);
  assert.deepEqual(insertText(cell, 8, "!"), [cell[0], cell[1], T("!")]);
  assert.deepEqual(insertText([T("x")], 99, "y"), [T("xy")]);
  assert.deepEqual(insertText([T("x")], 0, "a\u200Bb", { i: true }), [T("ab", { i: true }), T("x")]);
  assert.deepEqual(marksAt(cell, 0), { b: true, href: "https://e.x/", cmt: ["c1"] });
});

test("deleteRange, replaceText, setMark", () => {
  const cell = [T("one two three")];
  assert.deepEqual(deleteRange(cell, 3, 7), [T("one three")]);
  assert.deepEqual(deleteRange(cell, 7, 3), [T("one three")]);
  const inComment = [T("say "), T("two words", { cmt: ["c1"] })];
  assert.deepEqual(replaceText(inComment, 4, 7, "three"), [T("say "), T("three words", { cmt: ["c1"] })]);
  assert.deepEqual(setMark(cell, 4, 7, "b", true), [T("one "), T("two", { b: true }), T(" three")]);
  assert.deepEqual(setMark(setMark(cell, 4, 7, "b", true), 0, 13, "b", false), cell);
  assert.deepEqual(setMark([T("a"), B("bs1")], 0, 2, "tag", "t:prop:X"), [T("a", { tag: "t:prop:X" }), B("bs1")]);
});

test("comments: add, find, remove", () => {
  let cell = addComment([T("one two three")], 4, 7, "c5");
  assert.deepEqual(cell, [T("one "), T("two", { cmt: ["c5"] }), T(" three")]);
  cell = addComment(cell, 0, 13, "c1");
  assert.deepEqual(commentIds(cell), ["c1", "c5"]);
  assert.deepEqual(commentRange(cell, "c5"), { from: 4, to: 7 });
  assert.equal(commentRange(cell, "nope"), null);
  assert.deepEqual(removeComment(removeComment(cell, "c1"), "c5"), [T("one two three")]);
});

test("split and join are inverses; retag renames or removes a tag everywhere", () => {
  const cell = [T("ab", { b: true, cmt: ["c1"] }), B("bs1"), T("cd")];
  for (let p = 0; p <= cellLength(cell); p++) {
    const [a, b] = splitCell(cell, p);
    assert.deepEqual(joinCells(a, b), normalizeCell(cell), "at " + p);
  }
  assert.deepEqual(joinCells([T("a")], [T("b")], "\n"), [T("a\nb")]);
  const tagged = [T("x", { tag: "t_a" }), T(" "), T("y", { tag: "t_b" })];
  assert.deepEqual(tagIds(tagged), ["t_a", "t_b"]);
  assert.deepEqual(retag(tagged, "t_a", "t_b"), [T("x", { tag: "t_b" }), T(" "), T("y", { tag: "t_b" })]);
  assert.deepEqual(retag(tagged, "t_a", null), [T("x "), T("y", { tag: "t_b" })]);
});

test("insertBrollKey puts the key in as one atom", () => {
  const cell = insertBrollKey([T("intro\n drone")], 6, "bs_7", "B-roll:");
  assert.deepEqual(cell, [T("intro\n"), B("bs_7"), T(" drone")]);
  assert.equal(toHtml(cell), 'intro<br><span class="broll-key" data-broll-id="bs_7" contenteditable="false">B-roll:</span> drone');
});

test("random edits keep lengths and never leave a cell out of canonical form", () => {
  const r = rng(7);
  for (const cell of RANDOM.slice(0, 150)) {
    const n = cellLength(cell);
    const p = Math.floor(r() * (n + 1)), q = Math.floor(r() * (n + 1));
    const lo = Math.min(p, q), hi = Math.max(p, q);
    const ins = insertText(cell, p, "zz");
    assert.equal(cellLength(ins), n + 2);
    const del = deleteRange(cell, p, q);
    assert.equal(cellLength(del), n - (hi - lo));
    assert.equal(projection(del), projection(cell).slice(0, lo) + projection(cell).slice(hi));
    for (const out of [ins, del, setMark(cell, p, q, "i", true), addComment(cell, p, q, "cx")]) {
      assert.deepEqual(normalizeCell(out), out);
      assert.deepEqual(fromHtml(toHtml(out)), out);
    }
  }
});

/* ---- steps ---- */

const doc = () => ({
  title: "T",
  rows: [
    { id: "r1", status: "todo", visualText: "v1", audioText: "a1" },
    { id: "r2", status: "todo", visualText: "v2", audioText: "a2" },
    { id: "r3", status: "todo", visualText: "v3", audioText: "a3" }
  ]
});

test("steps apply without touching the state they were given, and invert exactly", () => {
  const before = doc();
  const frozen = JSON.stringify(before);
  const steps = [
    { op: "rowField", rowId: "r1", key: "audioText", before: "a1", after: "A1" },
    { op: "rowField", rowId: "r2", key: "status", before: "todo", after: "shot" },
    { op: "docField", key: "title", before: "T", after: "New" },
    { op: "insertRow", index: 1, row: { id: "r9", status: "todo", visualText: "", audioText: "" } },
    { op: "moveRow", from: 3, to: 0 },
    { op: "deleteRow", index: 2, row: { id: "r9", status: "todo", visualText: "", audioText: "" } }
  ];
  const after = applySteps(before, steps);
  assert.equal(JSON.stringify(before), frozen);
  assert.deepEqual(after.rows.map((x) => x.id), ["r3", "r1", "r2"]);
  assert.equal(after.rows[1].audioText, "A1");
  assert.equal(after.rows[2].status, "shot");
  assert.equal(after.title, "New");
  assert.deepEqual(applySteps(after, invertSteps(steps)), before);
  assert.deepEqual(touchedCells(steps), ["r1\u0000audioText", "r9\u0000visualText", "r9\u0000audioText"]);
});

test("a step that no longer applies is refused whole", () => {
  const state = doc();
  state.rows[0].audioText = "someone else's";
  assert.throws(() => applySteps(state, [{ op: "rowField", rowId: "r1", key: "audioText", before: "a1", after: "x" }]),
    (e) => e.code === "STEP_REFUSED");
  assert.throws(() => applySteps(doc(), [{ op: "rowField", rowId: "gone", key: "audioText", before: "a1", after: "x" }]),
    (e) => e.code === "STEP_REFUSED");
  assert.throws(() => applySteps(doc(), [{ op: "deleteRow", index: 0, row: { id: "r1" } }]), (e) => e.code === "STEP_REFUSED");
  assert.throws(() => applySteps(doc(), [{ op: "insertRow", index: 0, row: { id: "r2" } }]), (e) => e.code === "STEP_REFUSED");
});

/* ---- three-way merge ---- */

const merged = (o, a, b) => mergeCells(o, a, b);

test("merge: one side changed, or both the same way, takes it", () => {
  for (const cell of RANDOM.slice(0, 60)) {
    const other = insertText(cell, 0, "new ");
    assert.deepEqual(merged(cell, cell, other), { cell: other, conflict: false, markConflicts: 0 });
    assert.deepEqual(merged(cell, other, cell), { cell: other, conflict: false, markConflicts: 0 });
    assert.deepEqual(merged(cell, other, other), { cell: other, conflict: false, markConflicts: 0 });
  }
});

test("merge: edits to different words both land", () => {
  const o = [T("the quick brown fox jumps")];
  const mine = replaceText(o, 4, 9, "slow");               // quick -> slow
  const theirs = replaceText(o, 20, 25, "sleeps");         // jumps -> sleeps
  assert.deepEqual(merged(o, mine, theirs), { cell: [T("the slow brown fox sleeps")], conflict: false, markConflicts: 0 });
});

test("merge: a tag added on one side and a word fixed on the other is not a conflict (#85)", () => {
  const o = [T("pick up the red mug and go")];
  const mine = setMark(o, 12, 19, "tag", "t_mug");        // tag "red mug"
  const theirs = replaceText(o, 24, 26, "leave");          // go -> leave
  const r = merged(o, mine, theirs);
  assert.equal(r.conflict, false);
  assert.deepEqual(r.cell, [T("pick up the "), T("red mug", { tag: "t_mug" }), T(" and leave")]);
});

test("merge: formatting and comments merge per character", () => {
  const o = [T("one two three")];
  const mine = setMark(o, 0, 3, "b", true);
  const theirs = addComment(o, 8, 13, "c1");
  const r = merged(o, mine, theirs);
  assert.deepEqual(r.cell, [T("one", { b: true }), T(" two "), T("three", { cmt: ["c1"] })]);
  assert.equal(r.conflict, false);
  /* both linked the same word to different places: theirs, reported */
  const l1 = setMark(o, 4, 7, "href", "https://a.x/"), l2 = setMark(o, 4, 7, "href", "https://b.x/");
  const rl = merged(o, l1, l2);
  assert.deepEqual(rl.cell, l2);
  assert.equal(rl.markConflicts, 3);
  assert.equal(rl.conflict, false);
});

test("merge: the same words changed differently is a conflict, and theirs stays live", () => {
  const o = [T("meet at noon today")];
  const mine = replaceText(o, 8, 12, "one");
  const theirs = replaceText(o, 8, 12, "two");
  const r = merged(o, mine, theirs);
  assert.equal(r.conflict, true);
  assert.deepEqual(r.cell, theirs);
});

test("merge: atoms are tokens of their own", () => {
  const o = [T("a "), B("bs1"), T(" drone")];
  const mine = insertText(o, 0, "x");
  const theirs = deleteRange(o, 2, 3);
  const r = merged(o, mine, theirs);
  assert.equal(r.conflict, false);
  assert.deepEqual(r.cell, [T("xa  drone")]);
});

test("merge: random edits to words two or more apart always both land", () => {
  const r = rng(3);
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
  for (let n = 0; n < 200; n++) {
    const len = 6 + Math.floor(r() * 5);
    const w = Array.from({ length: len }, () => words[Math.floor(r() * words.length)]);
    const i = Math.floor(r() * (len - 2));
    const j = i + 2 + Math.floor(r() * (len - i - 2));
    const o = [T(w.join(" "))];
    const mw = w.slice(); mw[i] = "MINE";
    const tw = w.slice(); tw[j] = "THEIRS";
    const both = w.slice(); both[i] = "MINE"; both[j] = "THEIRS";
    const res = merged(o, [T(mw.join(" "))], [T(tw.join(" "))]);
    assert.equal(res.conflict, false, w.join(" ") + " @" + i + "," + j);
    assert.deepEqual(res.cell, [T(both.join(" "))]);
  }
});

test("merge: a rewrite too big to diff on both sides is one conflict, not a hang", () => {
  const big = (w) => [T(Array.from({ length: 2500 }, (_, k) => w + k).join(" "))];
  const t0 = Date.now();
  const res = merged(big("o"), big("m"), big("t"));
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(res.conflict, true);
  assert.deepEqual(res.cell, big("t"));
  assert.equal(merged(big("o"), big("m"), big("m")).conflict, false);
});
