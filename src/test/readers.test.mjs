/* Readers on the document model (#85, step 3 of docs/DOCUMENT-MODEL.md §10).
 *
 * doc-model.test.mjs proves the model's readers agree with the HTML readers
 * on CANONICAL HTML — toHtml's own output. The app's stored cells are not
 * canonical: they keep whatever nesting the browser and the sanitiser gave
 * them (<em><strong> as often as <strong><em>, a comment split around a
 * bold word, two <strong>s side by side). A reader only moves onto the
 * model if it gives what it gave before for THOSE cells, so every check
 * here runs over stored-shaped HTML: the demo document, the model's own
 * fixtures run through the sanitiser, and seeded random cells built the
 * way editing builds them — each run wrapped on its own, its marks in a
 * random order — then sanitised, as every cell is on blur and on load.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cellOf, toDocxRuns, toPlainText } from "../js/04c-doc-model.js";
import { sanitizeHtml } from "../js/04-richtext.js";
import { htmlToPlainText, htmlToRuns } from "../js/14-export.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const WORDS = ["the", "red", "mug", "a b", "two\nlines", " ", "  ", "é", "x<y", "&", "\n", "\"q\"", "'s", "tab\t", "bo", "ld"];
const WRAP = { b: "strong", i: "em", u: "u", s: "s", hl: "mark" };
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

/* One cell the way editing leaves it: every run wrapped separately, so
   neighbours that share a format sit in elements of their own, in
   whichever order the marks happened to be applied. */
function storedCell(r) {
  const n = Math.floor(r() * 12);
  let out = "";
  for (let i = 0; i < n; i++) {
    if (r() < 0.07) { out += '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span>'; continue; }
    let h = esc(WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.5 ? " " : ""));
    const keys = Object.keys(WRAP).filter(() => r() < 0.25).sort(() => r() - 0.5);
    for (const k of keys) h = "<" + WRAP[k] + ">" + h + "</" + WRAP[k] + ">";
    if (r() < 0.15) h = `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Item ${i}" contenteditable="false">${h}</span>`;
    if (r() < 0.1) h = '<a href="https://e.x/">' + h + "</a>";
    if (r() < 0.2) h = `<span class="cmt-anchor" data-cmt="c${Math.floor(r() * 3)}">${h}</span>`;
    out += h;
  }
  return sanitizeHtml(out);
}

const tagSpan = (cat, name, inner) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${inner}</span>`;

const HAND = [
  "",
  "plain words",
  "two&nbsp; spaces",
  "line one<br>line two<br>",
  "<em>x <strong>y</strong></em> z",
  "<strong>a</strong><strong>b</strong> <em><strong>c</strong></em><strong><em>d</em></strong>",
  '<strong>bo<span class="cmt-anchor" data-cmt="c1">ld</span></strong>',
  'pick up the <strong>' + tagSpan("prop", "Red mug", "red mug") + "</strong> now",
  '<a href="https://e.x/">one</a><a href="https://e.x/">two</a>',
  '<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span> drone<br>next',
  '<div>para one</div><div><br></div><div>para <b>three</b></div>'
].map((h) => sanitizeHtml(h));

const seed = JSON.parse(readFileSync(new URL("../seed-state.json", import.meta.url), "utf8"));
const STORED = HAND.slice();
for (const row of seed.rows) STORED.push(row.visualText || "", row.audioText || "");
{ const r = rng(85); for (let i = 0; i < 1500; i++) STORED.push(storedCell(r)); }

test("plain text: the model reads every stored cell as htmlToPlainText does", () => {
  for (const html of STORED) assert.equal(toPlainText(cellOf(html)), htmlToPlainText(html), html);
});

test("plain text: where the model reads differently, by design (D7, §3)", () => {
  /* a video card has no place in a script cell: its label is not script */
  const card = sanitizeHtml('see <a class="video-embed-card" href="https://youtu.be/x">x</a>');
  assert.match(htmlToPlainText(card), /Watch video/);
  assert.equal(toPlainText(cellOf(card)), "see");
  /* a line feed inside a text node shows as a space (white-space: normal) */
  assert.equal(htmlToPlainText("a\nb"), "a\nb");
  assert.equal(toPlainText(cellOf("a\nb")), "a b");
  /* a zero-width space is a caret spot, never content */
  assert.equal(toPlainText(cellOf("a​b")), "ab");
});

/* Word and the PDF writer draw a run's text in its format; two neighbouring
   runs in the same format draw exactly as one. */
function coalesce(runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    const same = last && r.text !== "\n" && last.text !== "\n" &&
      ["b", "i", "u", "s", "mark", "href"].every((k) => (last[k] || null) === (r[k] || null));
    if (same) last.text += r.text; else out.push(Object.assign({}, r));
  }
  return out;
}

test("docx/pdf runs: the same text in the same formats as htmlToRuns, for every stored cell", () => {
  let merged = 0;
  for (const html of STORED) {
    const before = htmlToRuns(html);
    const after = toDocxRuns(cellOf(html));
    /* the only difference: neighbours in one format that the stored HTML
       kept in separate elements (<strong>a</strong><strong>b</strong>)
       can come out as one run */
    assert.deepEqual(coalesce(after), coalesce(before), html);
    assert.ok(after.length <= before.length, html);
    if (after.length !== before.length) merged++;
  }
  assert.ok(merged > 0, "the random cells do exercise neighbouring same-format elements");
});
