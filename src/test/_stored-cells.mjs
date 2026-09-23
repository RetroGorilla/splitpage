/* Cells as the app STORES them, for suites that check a reader or a writer
 * against the document model (#85) on real input rather than on the
 * model's own canonical HTML.
 *
 * Stored cells are not canonical: they keep whatever nesting the browser
 * and the sanitiser gave them (<em><strong> as often as <strong><em>, a
 * comment split around a bold word, two <strong>s side by side). STORED is
 * the demo document, hand-written non-canonical cells, and seeded random
 * cells built the way editing builds them — each run wrapped on its own,
 * its marks in a random order — then sanitised, as every cell is on blur
 * and on load.
 *
 * Import after ./_dom.mjs: building STORED runs the sanitiser.
 */
import { readFileSync } from "node:fs";
import { sanitizeHtml } from "../js/04-richtext.js";

export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const WORDS = ["the", "red", "mug", "a\u00a0b", "two\nlines", " ", "  ", "é", "x<y", "&", "\n", "\"q\"", "'s", "tab\t", "bo", "ld"];
const WRAP = { b: "strong", i: "em", u: "u", s: "s", hl: "mark" };
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

export const tagSpan = (cat, name, inner) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${inner}</span>`;

/* One cell the way editing leaves it: every run wrapped separately, so
   neighbours that share a format sit in elements of their own, in
   whichever order the marks happened to be applied. */
export function storedCell(r) {
  const n = Math.floor(r() * 12);
  let out = "";
  for (let i = 0; i < n; i++) {
    if (r() < 0.07) { out += '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span>'; continue; }
    let h = esc(WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.5 ? " " : ""));
    const keys = Object.keys(WRAP).filter(() => r() < 0.25).sort(() => r() - 0.5);
    for (const k of keys) h = "<" + WRAP[k] + ">" + h + "</" + WRAP[k] + ">";
    if (r() < 0.15) h = tagSpan("prop", "Item " + i, h);
    if (r() < 0.1) h = '<a href="https://e.x/">' + h + "</a>";
    if (r() < 0.2) h = `<span class="cmt-anchor" data-cmt="c${Math.floor(r() * 3)}">${h}</span>`;
    out += h;
  }
  return sanitizeHtml(out);
}

const HAND = [
  "",
  "plain words",
  "two&nbsp; spaces",
  "line one<br>line two<br>",
  "<em>x <strong>y</strong></em> z",
  "<strong>a</strong><strong>b</strong> <em><strong>c</strong></em><strong><em>d</em></strong>",
  '<strong>bo<span class="cmt-anchor" data-cmt="c1">ld</span></strong>',
  "pick up the <strong>" + tagSpan("prop", "Red mug", "red mug") + "</strong> now",
  '<a href="https://e.x/">one</a><a href="https://e.x/">two</a>',
  '<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span> drone<br>next',
  "<div>para one</div><div><br></div><div>para <b>three</b></div>"
].map((h) => sanitizeHtml(h));

const seed = JSON.parse(readFileSync(new URL("../seed-state.json", import.meta.url), "utf8"));
export const STORED = HAND.slice();
for (const row of seed.rows) STORED.push(row.visualText || "", row.audioText || "");
{ const r = rng(85); for (let i = 0; i < 1500; i++) STORED.push(storedCell(r)); }
