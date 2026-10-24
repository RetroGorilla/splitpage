import "./_dom.mjs";
import "./_copy-paste-mounted.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  attachToGallery, brollIdsTaken, cellFromClipboard, clipboardOfCell, cutNonceIn, freshBrollIds, stripComments,
  videoLink, videoLinksInText
} from "../features/clipboard/cell-clipboard.js";
import { commentIds, projection } from "../core/text/runs.ts";
import { fromHtml } from "../legacy/richtext.ts";
import { sliceCell } from "../core/text/edits.ts";
import { toHtml } from "../core/text/html.ts";

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
  const other = cellFromClipboard(cut.html, cut.text, { nonce: "n2", hasComment: have });
  assert.equal(other.fromCut, false);
  assert.deepEqual(commentIds(other.cell), []);
  assert.equal(projection(other.cell), projection(mine.cell), "the words come all the same");
  const spent = cellFromClipboard(cut.html, cut.text, { nonce: null, hasComment: have });
  assert.deepEqual(commentIds(spent.cell), []);
  const gone = cellFromClipboard(cut.html, cut.text, { nonce: "n1", hasComment: () => false });
  assert.equal(gone.fromCut, true);
  assert.deepEqual(gone.comments, []);
  assert.deepEqual(commentIds(gone.cell), []);
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

test("what a paste attaches to its scene (#124): video links, cards, <video>, pictures", () => {
  assert.equal(videoLink("https://www.youtube.com/watch?v=abc"), "https://www.youtube.com/watch?v=abc");
  assert.equal(videoLink("https://youtu.be/abc"), "https://youtu.be/abc");
  assert.equal(videoLink("https://player.vimeo.com/video/1"), "https://player.vimeo.com/video/1");
  assert.equal(videoLink("https://example.com/clip.MP4"), "https://example.com/clip.MP4");
  assert.equal(videoLink("https://example.com/page"), null);
  assert.equal(videoLink("https://notyoutube.com/x"), null);
  assert.equal(videoLink("javascript:alert(1)//youtube.com"), null);
  assert.deepEqual(videoLinksInText("  https://youtu.be/abc \n"), { text: "", links: ["https://youtu.be/abc"] });
  assert.deepEqual(videoLinksInText("see https://youtu.be/abc."), { text: "see https://youtu.be/abc.", links: ["https://youtu.be/abc"] });
  assert.deepEqual(videoLinksInText("see https://example.com"), { text: "see https://example.com", links: [] });
  const got = cellFromClipboard(
    "Before <a class=\"video-embed-card\" href=\"https://vimeo.com/1\">Watch video</a>" +
    "<a href=\"https://youtu.be/abc\">youtu.be/abc</a> <a href=\"https://youtu.be/abc\">the take</a> " +
    "<video src=\"https://cdn.example.com/a.webm\"></video><img src=\"https://example.com/p.png\"> after", "", {});
  assert.equal(projection(got.cell), "Before  the take  after");
  assert.deepEqual(got.attach, [
    { kind: "video", href: "https://vimeo.com/1" },
    { kind: "video", href: "https://youtu.be/abc" },
    { kind: "video", href: "https://cdn.example.com/a.webm" }
  ]);
  assert.equal(got.lost, 1);
  const bare = cellFromClipboard("<a href=\"https://youtu.be/abc\">https://youtu.be/abc</a>", "https://youtu.be/abc", {});
  assert.equal(projection(bare.cell), "");
  assert.deepEqual(bare.attach, [{ kind: "video", href: "https://youtu.be/abc" }]);
  assert.equal(cellFromClipboard("<img src=\"https://example.com/p.png\">x", "", { skipImages: true }).lost, 0);
});

test("what a paste attaches goes into the scene's gallery, each its own item (#135)", () => {
  const P1 = { sha256: "a".repeat(64), width: 4, height: 3, mime: "image/png" };
  const P2 = { sha256: "b".repeat(64), width: 4, height: 3, mime: "image/png" };
  const row = { id: "r1", imageRef: null };
  let got = attachToGallery(row, [{ kind: "video", href: "https://youtu.be/abc" }]);
  assert.deepEqual(got, { pictures: 0, videos: 1, links: ["https://youtu.be/abc"] });
  assert.equal(row.imageRef, null);
  assert.deepEqual(row.imageLinks, [{ href: "https://youtu.be/abc", poster: true }]);
  attachToGallery(row, [{ kind: "image", ref: P1 }]);
  assert.equal(row.imageRef, null);
  assert.deepEqual(row.moreImages, [{ imageRef: P1 }]);
  got = attachToGallery(row, [{ kind: "image", ref: P2 }, { kind: "videoFile", name: "<b>take</b>.mp4", size: 3 }]);
  assert.deepEqual(got, { pictures: 1, videos: 1, links: [] });
  assert.deepEqual(row.moreImages, [{ imageRef: P1 }, { imageRef: P2 }, { links: [{ name: "take.mp4", size: 3, poster: true }] }]);
  attachToGallery(row, [{ kind: "image", ref: P2 }, { kind: "video", href: "https://youtu.be/abc" }]);
  assert.equal(row.moreImages.length, 3);
  const row2 = { id: "r2", imageRef: P1 };
  attachToGallery(row2, [{ kind: "videoFile", name: "b.mov", size: 9, poster: P2 }]);
  assert.equal(row2.imageRef.sha256, P1.sha256);
  assert.deepEqual(row2.moreImages, [{ imageRef: P2, links: [{ name: "b.mov", size: 9, poster: true }] }]);
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
  assert.equal(projection(cellFromClipboard("line<br>", "", {}).cell), "line\n");
});

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
  assert.deepEqual(ids(brollIdsTaken(state, "r2", "visualText", fromHtml("two"), true)), ["bsA", "bsB", "bsC"]);
  assert.deepEqual(ids(brollIdsTaken(state, "r1", "visualText", fromHtml(KEY("bsA") + " the gulls"), true)), ["bsA", "bsC"]);
});

test("freshBrollIds: a key keeps its id only when nothing has it, and never twice in one paste", () => {
  const pasted = fromHtml(KEY("bsA") + " one<br>" + KEY("bsZ") + " two<br>" + KEY("bsZ") + " three");
  const out = freshBrollIds(pasted, { bsA: true }, counter());
  assert.deepEqual(keyIds(out.cell), ["bsNew1", "bsZ", "bsNew2"]);
  assert.deepEqual(out.minted, ["bsNew1", "bsNew2"]);
  assert.equal(toHtml(out.cell), KEY("bsNew1") + " one<br>" + KEY("bsZ") + " two<br>" + KEY("bsNew2") + " three");
  assert.equal(projection(out.cell), projection(pasted));
  const one = fromHtml(KEY("bsA") + " one");
  const same = freshBrollIds(one, {}, counter());
  assert.deepEqual(same.minted, []);
  assert.equal(toHtml(same.cell), toHtml(one));
  const again = freshBrollIds(fromHtml(KEY("bsA")), { bsA: true, bsNew1: true }, counter());
  assert.deepEqual(keyIds(again.cell), ["bsNew2"]);
  const real = freshBrollIds(fromHtml(KEY("bsA")), { bsA: true });
  assert.match(keyIds(real.cell)[0], /^bs[a-z0-9]+$/);
  assert.notEqual(keyIds(real.cell)[0], "bsA");
  const cut = clipboardOfCell(one, { keepComments: true, nonce: "n1" });
  const got = cellFromClipboard(cut.html, cut.text, { nonce: "n1" });
  assert.equal(got.fromCut, true);
  assert.deepEqual(keyIds(got.cell), ["bsA"]);
});
