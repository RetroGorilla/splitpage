/* The clipboard through the document model (#85, design §5, D6, D7):
 * src/js/05c-clipboard.js's pure half — what a copy or a cut of a script
 * cell puts on the clipboard, and what a paste or a drop takes off it.
 *
 * A copy never carries a comment. A cut does, tagged with a nonce only the
 * tab that cut knows, and a paste keeps comment marks only from HTML
 * carrying that tab's live nonce, for comments the document still has.
 * Pictures and video cards never land in a script cell. A pasted b-roll
 * key gets an id of its own unless nothing in the document has its id.
 * The live half — a real ClipboardEvent, the undo entry, the comment card
 * following its words, the b-roll list — is browser suite
 * 77-clipboard-model.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  brollIdsTaken, cellFromClipboard, clipboardOfCell, cutNonceIn, freshBrollIds, stripComments
} from "../js/05c-clipboard.js";
import { commentIds, fromHtml, projection, sliceCell, toHtml } from "../js/04c-doc-model.js";

const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const tag = (name) => `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="${name}" contenteditable="false">${name}</span>`;
const CELL = fromHtml("pick up the " + cmt("c1", "<strong>red</strong> " + tag("mug")) + " now<br>then go");

test("a copy carries the words and their formatting, never a comment", () => {
  const out = clipboardOfCell(sliceCell(CELL, 5, 23));
  assert.equal(out.html, "up the <strong>red</strong> " + tag("mug") + " now");
  assert.equal(out.text, "up the red mug now");
  assert.equal(out.html.indexOf("cmt-anchor"), -1);
  assert.equal(cutNonceIn(out.html), null, "a copy is never a cut");
});

test("a cut keeps its comment marks and names this tab's nonce", () => {
  const out = clipboardOfCell(sliceCell(CELL, 5, 23), { keepComments: true, nonce: "abc123" });
  assert.equal(out.html, '<span data-splitpage-cut="abc123">up the ' + cmt("c1", "<strong>red</strong> " + tag("mug")) + " now</span>");
  assert.equal(cutNonceIn(out.html), "abc123");
  assert.equal(out.text, "up the red mug now");
  /* the plain text: a line break as \n, a no-break space as a space */
  assert.equal(clipboardOfCell(fromHtml("a&nbsp;b<br>c")).text, "a b\nc");
});

test("stripComments takes every comment mark and nothing else", () => {
  const cell = stripComments(CELL);
  assert.deepEqual(commentIds(cell), []);
  assert.equal(projection(cell), projection(CELL));
  assert.equal(toHtml(cell), "pick up the <strong>red</strong> " + tag("mug") + " now<br>then go");
});

test("cutNonceIn reads the marker however the clipboard wrapped it", () => {
  assert.equal(cutNonceIn('<meta charset="utf-8"><span data-splitpage-cut="f00d">x</span>'), "f00d");
  assert.equal(cutNonceIn("<html><body><!--StartFragment--><span data-splitpage-cut='beef'>x</span><!--EndFragment--></body></html>"), "beef");
  assert.equal(cutNonceIn("<span>no marker</span>"), null);
  assert.equal(cutNonceIn(""), null);
  assert.equal(cutNonceIn(null), null);
});

test("a paste keeps comments only from this tab's live cut, for comments that exist", () => {
  const cut = clipboardOfCell(sliceCell(CELL, 5, 23), { keepComments: true, nonce: "n1" });
  const have = (id) => id === "c1";
  const mine = cellFromClipboard(cut.html, cut.text, { nonce: "n1", hasComment: have });
  assert.equal(mine.fromCut, true);
  assert.deepEqual(mine.comments, ["c1"]);
  assert.deepEqual(commentIds(mine.cell), ["c1"]);
  assert.equal(mine.text, null, "HTML goes in as a cell, not as typing");
  /* another tab's cut, or this tab's spent one */
  const other = cellFromClipboard(cut.html, cut.text, { nonce: "n2", hasComment: have });
  assert.equal(other.fromCut, false);
  assert.deepEqual(commentIds(other.cell), []);
  assert.equal(projection(other.cell), projection(mine.cell), "the words come all the same");
  const spent = cellFromClipboard(cut.html, cut.text, { nonce: null, hasComment: have });
  assert.deepEqual(commentIds(spent.cell), []);
  /* a comment deleted since the cut */
  const gone = cellFromClipboard(cut.html, cut.text, { nonce: "n1", hasComment: () => false });
  assert.equal(gone.fromCut, true);
  assert.deepEqual(gone.comments, []);
  assert.deepEqual(commentIds(gone.cell), []);
  /* a comment span in HTML from anywhere else is words, never a comment */
  const foreign = cellFromClipboard(cmt("c1", "hi"), "hi", { nonce: "n1", hasComment: have });
  assert.deepEqual(commentIds(foreign.cell), []);
});

test("a paste is sanitised, keeps formatting and tags, and drops pictures and video cards", () => {
  const html = '<meta charset="utf-8"><style>p { color: red }</style><b>bold</b> <script>alert(1)</script><i onclick="x()">it</i> ' +
    '<img src="data:image/png;base64,AAAA"> ' + tag("mug") +
    ' <a class="video-embed-card" href="https://youtu.be/x">Watch video</a><a href="javascript:alert(1)">bad</a>';
  const got = cellFromClipboard(html, "ignored", {});
  assert.equal(got.media, 2);
  assert.equal(toHtml(got.cell), "<strong>bold</strong> <em>it</em>  " + tag("mug") + " bad");
  /* only a picture: nothing from the HTML, so the plain text goes in */
  const onlyPic = cellFromClipboard('<img src="data:image/png;base64,AAAA">', "", {});
  assert.equal(onlyPic.media, 1);
  assert.equal(projection(onlyPic.cell), "");
});

test("a Google Docs fragment's font-weight:normal wrapper cancels its own <b>, not its bold spans (#121)", () => {
  const html = '<b style="font-weight:normal;" id="docs-internal-guid-x">' +
    '<span style="font-weight:700;">GBOLD</span>' +
    '<span style="font-weight:400;"> plain </span>' +
    '<span style="font-style:italic;font-weight:400;">GITAL</span></b>';
  const got = cellFromClipboard(html, "ignored", {});
  assert.equal(toHtml(got.cell), "<strong>GBOLD</strong> plain <em>GITAL</em>");
});

test("plain text goes in as typing, a line break as a line break", () => {
  const got = cellFromClipboard("", "one\r\ntwo", {});
  assert.equal(got.text, "one\r\ntwo");
  assert.equal(projection(got.cell), "one\ntwo");
  assert.equal(got.fromCut, false);
});

test("a copied paragraph does not bring a line break with it", () => {
  assert.equal(projection(cellFromClipboard("<p>one sentence</p>", "", {}).cell), "one sentence");
  assert.equal(projection(cellFromClipboard("<p>a</p><p>b</p>\n<!--EndFragment-->", "", {}).cell), "a\nb");
  /* a line break the words themselves end in stays */
  assert.equal(projection(cellFromClipboard("line<br>", "", {}).cell), "line\n");
});

/* ---- b-roll keys: a pasted key is a line of its own ---- */

const KEY = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const keyIds = (cell) => cell.filter((r) => r.atom).map((r) => r.id);
const counter = () => { let n = 0; return () => "bsNew" + (++n); };

test("brollIdsTaken: every key in the script, and the list's records unless a cut is moving it", () => {
  const state = {
    rows: [
      { id: "r1", visualText: KEY("bsA") + " the gulls<br>" + KEY("bsB") + " drone", audioText: "said " + KEY("bsC") },
      { id: "r2", visualText: "two", audioText: "" }
    ],
    brollShots: [{ id: "bsA" }, { id: "bsGone" }]
  };
  const ids = (t) => Object.keys(t).sort();
  assert.deepEqual(ids(brollIdsTaken(state, "r2", "visualText", fromHtml("two"), false)), ["bsA", "bsB", "bsC", "bsGone"]);
  /* a cut: the orphaned record's id is free for its own key to come back to */
  assert.deepEqual(ids(brollIdsTaken(state, "r2", "visualText", fromHtml("two"), true)), ["bsA", "bsB", "bsC"]);
  /* the cell pasted into counts as it is without the selection the paste replaces */
  assert.deepEqual(ids(brollIdsTaken(state, "r1", "visualText", fromHtml(KEY("bsA") + " the gulls"), true)), ["bsA", "bsC"]);
});

test("freshBrollIds: a key keeps its id only when nothing has it, and never twice in one paste", () => {
  const pasted = fromHtml(KEY("bsA") + " one<br>" + KEY("bsZ") + " two<br>" + KEY("bsZ") + " three");
  const out = freshBrollIds(pasted, { bsA: true }, counter());
  assert.deepEqual(keyIds(out.cell), ["bsNew1", "bsZ", "bsNew2"]);
  assert.deepEqual(out.minted, ["bsNew1", "bsNew2"]);
  /* only the ids change: the words, the key's letters and every mark stay */
  assert.equal(toHtml(out.cell), KEY("bsNew1") + " one<br>" + KEY("bsZ") + " two<br>" + KEY("bsNew2") + " three");
  assert.equal(projection(out.cell), projection(pasted));
  /* nothing taken: the same cell back */
  const one = fromHtml(KEY("bsA") + " one");
  const same = freshBrollIds(one, {}, counter());
  assert.deepEqual(same.minted, []);
  assert.equal(toHtml(same.cell), toHtml(one));
  /* a minted id that is itself taken is minted again */
  const again = freshBrollIds(fromHtml(KEY("bsA")), { bsA: true, bsNew1: true }, counter());
  assert.deepEqual(keyIds(again.cell), ["bsNew2"]);
  /* the default mint is the b-roll one (makeId("bs")) */
  const real = freshBrollIds(fromHtml(KEY("bsA")), { bsA: true });
  assert.match(keyIds(real.cell)[0], /^bs[a-z0-9]+$/);
  assert.notEqual(keyIds(real.cell)[0], "bsA");
  /* a cut's HTML reads its key as it went: the nonce only decides what is taken */
  const cut = clipboardOfCell(one, { keepComments: true, nonce: "n1" });
  const got = cellFromClipboard(cut.html, cut.text, { nonce: "n1" });
  assert.equal(got.fromCut, true);
  assert.deepEqual(keyIds(got.cell), ["bsA"]);
});
