import { domToPos } from "../features/editing/cell-dom.ts";
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  historyCommit,
  historyNoteSelection,
  historyPush,
  historyRedo,
  historyUndo,
  liftMedia,
  markThroughoutText,
  mediaTable,
  newHistory,
  stripMediaMarks
} from "../js/05d-draft-edit.js";
import { cellLength, fromHtml, projection, setMark } from "../js/04c-doc-model.js";
import { posToDom } from "../features/editing/cell-dom.ts";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);
const img = (sha) => `<img class="comment-img" data-blob="${sha}" data-w="4" data-h="3" data-mime="image/png">`;
const CARD = '<a class="video-embed-card" href="https://youtube.com/watch?v=x" target="_blank" rel="noopener">' +
  '<span class="vec-play">\u25B6</span><span>Watch video</span><span class="vec-host">\u00B7 youtube.com</span></a>';

function roundTrip(html, fn) {
  const t = mediaTable([html]);
  const cell = t.cell(html);
  return t.html(fn ? fn(cell, t) : cell);
}

test("a picture and a video card come back as themselves", () => {
  const html = "look " + img(SHA) + "<br>" + CARD + "<br>and " + img(SHA2);
  assert.equal(roundTrip(html), html);
  const t = mediaTable([html]);
  const cell = t.cell(html);
  assert.equal(cellLength(cell), "look ".length + 1 + 1 + 1 + 1 + "and ".length + 1);
  assert.equal(Object.keys(t.media).length, 3);
});

test("a placeholder is never a character the box already holds", () => {
  const html = "icon \uE000 and \uE001 " + img(SHA);
  const t = mediaTable([html]);
  const lifted = liftMedia(html, t);
  const ch = Object.keys(t.media)[0];
  assert.ok(ch !== "\uE000" && ch !== "\uE001");
  assert.ok(lifted.indexOf(ch) !== -1);
  assert.equal(roundTrip(html), html);
});

test("a paste's own characters are reserved too", () => {
  const t = mediaTable(["x " + img(SHA), "pasted \uE000"]);
  t.cell("x " + img(SHA));
  assert.ok(!t.isMedia("\uE000"));
});

test("formatting over a picture leaves the picture out of it", () => {
  const html = "one " + img(SHA) + " two";
  const bold = roundTrip(html, (cell) => setMark(cell, 0, cellLength(cell), "b", true));
  assert.equal(bold, "<strong>one </strong>" + img(SHA) + "<strong> two</strong>");
  const linked = roundTrip("a " + CARD + " b", (cell) => setMark(cell, 0, cellLength(cell), "href", "https://e.com/"));
  assert.ok(linked.indexOf(CARD) !== -1);
  assert.equal((linked.match(/<a /g) || []).length, 3, linked);
  assert.ok(!/<a href="https:\/\/e\.com\/"[^>]*>[^<]*<a /.test(linked), linked);
});

test("an old body with a picture inside <strong> comes out with it outside", () => {
  assert.equal(roundTrip("<strong>a " + img(SHA) + " b</strong>"),
    "<strong>a </strong>" + img(SHA) + "<strong> b</strong>");
});

test("bold throughout ignores pictures, as it ignores line breaks", () => {
  const t = mediaTable([]);
  const html = "<strong>one </strong>" + img(SHA) + "<strong> two</strong><br>" + img(SHA2);
  const cell = t.cell(html);
  const n = cellLength(cell);
  assert.equal(markThroughoutText(cell, 0, n, "b", t.isMedia), true);
  assert.equal(t.markThroughout(cell, 0, n, "b"), true);
  const at = projection(cell).indexOf(Object.keys(t.media)[0]);
  assert.equal(markThroughoutText(cell, at, at + 1, "b", t.isMedia), false);
  const off = t.html(t.toggleMark(cell, 0, n, "b"));
  assert.equal(off.indexOf("<strong>"), -1);
  assert.equal((off.match(/<img /g) || []).length, 2);
});

test("stripMediaMarks leaves every other run alone", () => {
  const cell = fromHtml("<em>a\uE000b</em>");
  const out = stripMediaMarks(cell, (ch) => ch === "\uE000");
  assert.deepEqual(out, [
    { text: "a", marks: { i: true } },
    { text: "\uE000", marks: {} },
    { text: "b", marks: { i: true } }
  ]);
});

test("the DOM walk counts a picture and a video card as one position each", () => {
  const html = "ab" + img(SHA) + "cd<br>" + CARD + "ef";
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  const t = mediaTable([html]);
  const n = cellLength(t.cell(html));
  assert.equal(n, 2 + 1 + 2 + 1 + 1 + 2);
  for (let pos = 0; pos <= n; pos++) {
    const pt = posToDom(el, pos);
    assert.equal(domToPos(el, pt.node, pt.offset), pos, "pos " + pos);
  }
  const inCard = el.querySelector(".video-embed-card span:nth-child(2)").firstChild;
  assert.equal(domToPos(el, inCard, 0), 7);
  assert.equal(domToPos(el, inCard, 3), 7);
  el.remove();
});

const snap = (html, from) => ({ html, sel: from === undefined ? null : { from, to: from } });

test("typing is one entry, closed when undone", () => {
  const h = newHistory(snap("", 0));
  h.pending = true;
  const back = historyUndo(h, snap("hello", 5));
  assert.equal(back.html, "");
  assert.equal(h.index, 0);
  const again = historyRedo(h, snap("", 0));
  assert.equal(again.html, "hello");
  assert.equal(historyRedo(h, snap("hello", 5)), null);
});

test("a structural edit is an entry of its own and ends the redo branch", () => {
  const h = newHistory(snap("a", 1));
  historyPush(h, snap("<strong>a</strong>", 1));
  historyPush(h, snap("<strong>a</strong><br><br>", 2));
  assert.equal(historyUndo(h, snap("<strong>a</strong><br><br>", 2)).html, "<strong>a</strong>");
  historyPush(h, snap("<em>x</em>", 1));
  assert.equal(historyRedo(h, snap("<em>x</em>", 1)), null);
  assert.equal(historyUndo(h, snap("<em>x</em>", 1)).html, "<strong>a</strong>");
  assert.equal(historyUndo(h, snap("<strong>a</strong>", 1)).html, "a");
  assert.equal(historyUndo(h, snap("a", 1)), null);
});

test("typing after an undo ends the redo branch", () => {
  const h = newHistory(snap("", 0));
  historyPush(h, snap("one", 3));
  historyUndo(h, snap("one", 3));
  h.pending = true;
  assert.equal(historyRedo(h, snap("two", 3)), null);
  assert.equal(h.stack.length, 2);
  assert.equal(h.stack[1].html, "two");
});

test("a burst that changed nothing leaves no entry, and the selection an entry restores is where the next change began", () => {
  const h = newHistory(snap("abc", 3));
  h.pending = true;
  assert.equal(historyCommit(h, snap("abc", 1)), false);
  assert.equal(h.stack.length, 1);
  historyNoteSelection(h, { from: 0, to: 3 });
  historyPush(h, snap("<strong>abc</strong>", 0));
  assert.deepEqual(historyUndo(h, snap("<strong>abc</strong>", 0)).sel, { from: 0, to: 3 });
});

test("the history keeps its last 200 entries", () => {
  const h = newHistory(snap("", 0));
  for (let i = 1; i <= 250; i++) historyPush(h, snap("v" + i, 0));
  assert.equal(h.stack.length, 200);
  assert.equal(h.stack[h.index].html, "v250");
  assert.equal(h.stack[0].html, "v51");
});
