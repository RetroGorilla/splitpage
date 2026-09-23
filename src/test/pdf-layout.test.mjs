/* The script PDF's row layout (17-pdf.js buildPdf) around pictures.
 *
 * A row whose picture had no text beside or under it in either column
 * never entered the text loop — the only place y moved past the picture —
 * so y dropped by the 14pt row gap alone and the next row was drawn over
 * the picture, leaving a 14pt strip of it showing (Im2 at y=331.17, Im3 at
 * y=317.17 in the report). buildPdf is not pure — it reads S.state — but it
 * needs no page: S.state is set directly, and passing `jpegs` (what
 * pdfImagesFor would have produced) keeps the image decoder out of it. The
 * PDF is uncompressed, so its content streams are read back as text and
 * every picture's draw rectangle checked against everything drawn after
 * its row. Browser suite 41-export-polish drives the same through the
 * real export.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { buildPdf } from "../js/17-pdf.js";

const PH = 792, M = 54;

/* Just enough of a JPEG for jpegSize(): SOI, then an SOF0 naming h x w. */
const jpeg = (w, h) => {
  const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
  return { bytes, size: { w, h } };
};
const lines = (n, word) => Array.from({ length: n }, (_, i) => (word || "Line") + " " + (i + 1)).join("<br>");

/* rows: [{ v, a, pic: [w, h] | undefined }] */
function pdfFor(rows) {
  S.state = migrateRows({
    schema: 2, title: "Layout", comments: [],
    rows: rows.map((r, i) => ({ id: "r" + i, visualText: r.v || "", audioText: r.a || "", status: "todo" }))
  });
  return buildPdf(rows.map((r) => (r.pic ? jpeg(r.pic[0], r.pic[1]) : null)));
}

/* Each page's content stream, in page order, as parsed draw ops. */
function parse(bytes) {
  const t = new TextDecoder("latin1").decode(bytes);
  const pages = [];
  const re = /obj\n<< \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(t))) {
    const stream = t.substr(re.lastIndex, +m[1]);
    pages.push(stream.split("\n").map((op) => {
      let x;
      if ((x = /^q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([-\d.]+) cm \/(Im\d+) Do Q$/.exec(op))) {
        return { kind: "img", name: x[5], w: +x[1], h: +x[2], x: +x[3], y: +x[4], top: +x[4] + +x[2] };
      }
      if ((x = /^BT \/(F\d) ([\d.]+) Tf 1 0 0 1 ([\d.]+) ([-\d.]+) Tm \((.*)\) Tj ET$/.exec(op))) {
        return { kind: "text", str: x[5], x: +x[3], y: +x[4], top: +x[4] + +x[2] };
      }
      if ((x = /^q 0\.90 0\.89 0\.86 RG 0\.5 w [\d.]+ ([-\d.]+) m /.exec(op))) return { kind: "rowrule", y: +x[1], top: +x[1] };
      if ((x = / ([-\d.]+) [\d.]+ [\d.]+ re f Q$/.exec(op))) return { kind: "fill", y: +x[1], top: +x[1] };
      return { kind: "other", op };
    }));
  }
  return pages;
}

/* The invariants the bug broke, over a whole document. */
function checkLayout(pages) {
  const images = [];
  pages.forEach((ops, p) => {
    ops.forEach((op, i) => {
      if (op.kind !== "img") return;
      images.push(Object.assign({ page: p }, op));
      /* on the page, not off its bottom or into its top margin */
      assert.ok(op.y >= M - 0.01 && op.top <= PH - M + 0.01, op.name + " off the page: " + JSON.stringify(op));
      /* the row's own rule, and everything after it on this page, lies
         below the picture — the next row starts under it */
      const rule = ops.findIndex((o, k) => k > i && o.kind === "rowrule");
      assert.ok(rule > i, op.name + " has no row rule after it");
      assert.ok(ops[rule].y < op.y, op.name + "'s row rule (y=" + ops[rule].y + ") is not below its picture (bottom " + op.y + ")");
      ops.slice(rule + 1).forEach((o) => {
        if (o.top === undefined) return;
        assert.ok(o.top <= op.y + 0.01,
          o.kind + " " + (o.str || o.name || "") + " (top " + o.top.toFixed(2) + ") drawn over " + op.name + " (bottom " + op.y.toFixed(2) + ") on page " + (p + 1));
      });
    });
  });
  for (let a = 0; a < images.length; a++) {
    for (let b = a + 1; b < images.length; b++) {
      const A = images[a], B = images[b];
      if (A.page !== B.page) continue;
      const overlap = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.top && B.y < A.top;
      assert.ok(!overlap, A.name + " and " + B.name + " overlap on page " + (A.page + 1));
    }
  }
  return images;
}

test("picture-only rows, a picture with short text and one with long text never overdraw each other", () => {
  const pages = parse(pdfFor([
    { a: "Scene one has audio." , pic: [300, 200] },
    { pic: [300, 200] },                        /* picture only: the report's scene 02 */
    { pic: [300, 200] },                        /* and again, straight after */
    { a: "Short.", pic: [300, 200] },           /* short audio text beside it */
    { v: "Short caption.", pic: [300, 200] },   /* short visual text under it */
    { a: lines(40), pic: [300, 200] },          /* text far longer than the picture */
    { a: "The last row." }
  ]));
  const images = checkLayout(pages);
  assert.equal(images.length, 6);
  /* the report's pair: 229 x 152.67, the second no longer 14pt below the first */
  assert.equal(images[1].w, 229);
  assert.equal(images[1].h.toFixed(2), "152.67");
});

test("a picture-only row's height is its picture plus the normal row gap", () => {
  const pages = parse(pdfFor([{ pic: [300, 200] }, { pic: [300, 200] }]));
  const [a, b] = pages.flat().filter((o) => o.kind === "img");
  assert.ok(a && b);
  assert.equal(pages.length, 1);
  /* bottom of one to top of the next = 8 + SIZE + 6 + 14 — exactly what a
     picture row with an empty visual column and one line or less of audio
     already got */
  assert.ok(Math.abs(a.y - b.top - 37.5) < 0.02, "gap " + (a.y - b.top));
});

test("a picture that does not fit in what is left of a page starts a new page", () => {
  /* Push a picture-only row (and a picture + short-text row) down the
     first page a line at a time; wherever it lands, it is whole, on a
     page, and nothing after it overlaps it. */
  let broke = 0;
  for (let n = 0; n <= 52; n++) {
    for (const row of [{ pic: [300, 200] }, { a: "Beside it.", pic: [300, 200] }, { pic: [200, 400] }]) {
      const pages = parse(pdfFor([{ a: lines(n) }, row, { pic: [300, 200] }, { a: "After." }]));
      const images = checkLayout(pages);
      assert.equal(images.length, 2, "n=" + n + ": a picture was dropped");
      if (images[0].page === 1) broke++;
    }
  }
  assert.ok(broke > 0, "no variant ever pushed the picture onto a new page");
});
