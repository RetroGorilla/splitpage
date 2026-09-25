/* Find & replace on the document model (#85 step 3, 09-find-replace.js).
 *
 * Find searches a cell's projection — its text as the model reads it — so
 * a match may run across formatting and comments, but never touches a
 * tagged word or a b-roll key. Replace is the model's replaceText(), the
 * cell written back as toHtml(). The match is shown by mapping its offsets
 * onto the cell's DOM, so that mapping is checked against the model on
 * every stored-shaped cell.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cellOf, projection } from "../js/04c-doc-model.js";
import { inertBody, sanitizeHtml } from "../js/04-richtext.js";
import { countInTags, domProjection, domRangeFor, findInCell, findInRows, noMatchLabel, replaceInHtml } from "../js/09-find-replace.js";
import { STORED, rng, tagSpan } from "./_stored-cells.mjs";

const find = (html, needle, matchCase) => findInCell(cellOf(html), needle, !!matchCase);
const replace = (html, needle, text, nth, matchCase) => replaceInHtml(html, needle, text, nth === undefined ? -1 : nth, !!matchCase);
const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const BROLL = '<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span>';

test("find: a match may run across formatting", () => {
  assert.deepEqual(find("bo<strong>ld</strong> move", "bold"), [{ from: 0, to: 4 }]);
  assert.deepEqual(find("<em>wid</em><strong>get</strong>", "widget"), [{ from: 0, to: 6 }]);
  assert.deepEqual(find('<a href="https://e.x/">click</a> here', "click here"), [{ from: 0, to: 10 }]);
});

test("find: a match may run into, out of and inside a comment", () => {
  const html = "say " + cmt("c1", "hello <strong>there</strong>") + " world";
  assert.deepEqual(find(html, "say hello"), [{ from: 0, to: 9 }]);
  assert.deepEqual(find(html, "there world"), [{ from: 10, to: 21 }]);
  assert.deepEqual(find(html, "hello"), [{ from: 4, to: 9 }]);
});

test("find: never inside a tag, never across one or across a b-roll key", () => {
  const html = "the " + tagSpan("prop", "Gaffer tape", "gaffer tape") + " today";
  assert.deepEqual(find(html, "gaffer"), []);
  assert.deepEqual(find(html, "the gaffer"), []);
  assert.deepEqual(find(html, "tape today"), []);
  assert.deepEqual(find(html, "today"), [{ from: 16, to: 21 }]);
  assert.equal(countInTags(cellOf(html), "gaffer", false), 1);
  assert.equal(countInTags(cellOf(html), "the", false), 0);
  /* the key's own word is not text a search can reach */
  assert.deepEqual(find("x" + BROLL + " drone", "roll"), []);
  assert.deepEqual(find("roll" + BROLL + "roll", "roll"), [{ from: 0, to: 4 }, { from: 5, to: 9 }]);
  /* two tags side by side are two pieces */
  const two = tagSpan("prop", "Ab", "ab") + tagSpan("prop", "Cd", "cd");
  assert.equal(countInTags(cellOf(two), "bc", false), 0);
});

test("find count: occurrences only inside tags are counted, never matched", () => {
  const rows = [
    { id: "r1", visualText: "the " + tagSpan("prop", "Gaffer tape", "gaffer tape"), audioText: "no gaffer here? " + tagSpan("prop", "Gaffer", "Gaffer") },
    { id: "r2", visualText: tagSpan("location", "Gaffer shed", "gaffer shed"), audioText: "" },
  ];
  /* one free "gaffer" in r1's audio, three inside tags */
  const all = findInRows(rows, "gaffer", false);
  assert.deepEqual(all.matches, [{ rowId: "r1", field: "audioText", nth: 0 }]);
  assert.equal(all.inTags, 3);
  /* only inside tags: nothing to select or replace, but the count says why */
  const tagged = findInRows(rows, "shed", false);
  assert.deepEqual(tagged.matches, []);
  assert.equal(tagged.inTags, 1);
  assert.equal(noMatchLabel(tagged.inTags), "No matches · 1 in a tag");
  assert.equal(noMatchLabel(findInRows(rows, "tape", false).inTags), "No matches · 1 in a tag");
  /* case sensitivity reaches the in-tag count too */
  assert.equal(findInRows(rows, "Gaffer", true).inTags, 1);
  assert.equal(noMatchLabel(2), "No matches · 2 in tags");
  assert.equal(noMatchLabel(0), "No matches");
  assert.deepEqual(findInRows(rows, "zzz", false), { matches: [], inTags: 0 });
  assert.deepEqual(findInRows(rows, "", false), { matches: [], inTags: 0 });
  /* and replace still leaves every tagged one alone */
  assert.equal(replace(rows[1].visualText, "shed", "barn").changed, 0);
});

test("find: case sensitivity, and characters whose lowercase is longer", () => {
  assert.equal(find("Mug mug MUG", "mug").length, 3);
  assert.deepEqual(find("Mug mug MUG", "mug", true), [{ from: 4, to: 7 }]);
  assert.deepEqual(find("İx mug", "mug"), [{ from: 3, to: 6 }]);
});

test("replace keeps the marks of the first replaced character", () => {
  assert.equal(replace("<strong>bold</strong> text", "bold", "heavy").html, "<strong>heavy</strong> text");
  assert.equal(replace("bo<strong>ld</strong> move", "bold", "brave").html, "brave move");
  assert.equal(replace("<strong>bo</strong>ld move", "bold", "brave").html, "<strong>brave</strong> move");
  const inComment = replace("say " + cmt("c1", "two words") + ".", "two", "three").html;
  assert.equal(inComment, "say " + cmt("c1", "three words") + ".");
  /* the replaced words are gone from the comment when the match only
     started outside it — the card then says the text changed */
  assert.equal(replace("say " + cmt("c1", "hi") + ".", "say hi", "hello").html, "hello.");
});

test("replace never touches a tag, and writes the stored markup", () => {
  const tag = tagSpan("prop", "Red mug", "red mug");
  const res = replace("a mug and " + tag + ", mug", "mug", "cup");
  assert.equal(res.changed, 2);
  assert.equal(res.html, "a cup and " + tag + ", cup");
  assert.equal(sanitizeHtml(res.html), res.html);
});

test("replace: the nth match only, or every one", () => {
  assert.deepEqual(replace("a a a", "a", "b", 1), { html: "a b a", changed: 1 });
  assert.deepEqual(replace("a a a", "a", "b"), { html: "b b b", changed: 3 });
  assert.deepEqual(replace("a a a", "a", "b", 5), { html: "a a a", changed: 0 });
  assert.deepEqual(replace("a a", "z", "b"), { html: "a a", changed: 0 });
  assert.equal(replace("one two", "one ", "").html, "two");
});

test("replace: a cell holding a pasted picture keeps it (the model has no place for one)", () => {
  const img = `<img class="comment-img" data-blob="${"a".repeat(64)}">`;
  const html = sanitizeHtml("hello " + img + " <strong>world</strong> world");
  const res = replace(html, "world", "earth");
  assert.equal(res.changed, 2);
  assert.ok(res.html.indexOf('data-blob="' + "a".repeat(64) + '"') !== -1, res.html);
  assert.equal(res.html, sanitizeHtml("hello " + img + " <strong>earth</strong> earth"));
  /* across formatting too */
  const res2 = replace(sanitizeHtml(img + "bo<strong>ld</strong>!"), "bold", "X");
  assert.equal(res2.html, sanitizeHtml(img + "X!"));
});

test("replace: every stored cell, every match, comes out as the model says", () => {
  const r = rng(9);
  for (const html of STORED) {
    const text = projection(cellOf(html));
    const ms = find(html, "e");
    if (!ms.length) continue;
    const nth = Math.floor(r() * ms.length);
    const res = replace(html, "e", "EE", nth);
    const m = ms[nth];
    assert.equal(projection(cellOf(res.html)), text.slice(0, m.from) + "EE" + text.slice(m.to), html);
    assert.equal(sanitizeHtml(res.html), res.html);
  }
});

test("the DOM mapping reads a cell's DOM as the model reads its HTML", () => {
  for (const html of STORED) {
    const want = projection(cellOf(html));
    const body = inertBody(html);
    assert.equal(domProjection(body).map((c) => c.text).join(""), want, html);
    /* the caret spot ensureTrailingCaretSpot() may add is skipped */
    body.appendChild(body.ownerDocument.createTextNode("\u200B"));
    assert.equal(domProjection(body).map((c) => c.text).join(""), want, html);
  }
  /* a line feed inside a text node, and a paragraph the sanitiser would
     turn into a line break */
  assert.equal(domProjection(inertBody("a\r\nb")).map((c) => c.text).join(""), projection(cellOf("a\r\nb")));
  const para = "<div>one</div><div><br></div><div>two</div>";
  assert.equal(domProjection(inertBody(para)).map((c) => c.text).join(""), projection(cellOf(para)));
});

test("the DOM range over a match holds exactly the matched words", () => {
  for (const html of STORED) {
    const body = inertBody(html);
    const want = projection(cellOf(html));
    for (const needle of ["e", "the", "d m", "o\u00a0"]) {
      for (const m of find(html, needle)) {
        const range = domRangeFor(body, m.from, m.to, want);
        assert.ok(range, html);
        assert.equal(range.toString().replace(/\n/g, " "), want.slice(m.from, m.to), html);
      }
    }
  }
  /* a DOM that is not the stored cell gives no range at all */
  assert.equal(domRangeFor(inertBody("abc"), 0, 1, "xbc"), null);
});
