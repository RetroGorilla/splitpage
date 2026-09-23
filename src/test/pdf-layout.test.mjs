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
import { intern } from "../js/02c-blobs.js";
import { commentEntries } from "../js/10-comments.js";
import { buildPdf, pdfCommentImagesFor } from "../js/17-pdf.js";

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

/* ---- pictures in comments and replies ----

   A comment or reply body holds a picture as <img class="comment-img"
   data-blob="<sha>"> (#82 P6); commentEntries() reads bodies as plain
   text, so until the PDF asked for them as pieces every such picture was
   dropped, and a picture-only body printed "(empty)". The fake JPEGs are
   interned into the registry here, the way ensureBytes would have left
   them, and each is a different size so each is its own sha. */
const PW = 612;
const cimg = (w, h) => {
  const rec = intern(jpeg(w, h).bytes);
  assert.ok(rec, "fake JPEG " + w + "x" + h + " interned");
  return { rec, html: '<img class="comment-img" data-blob="' + rec.sha256 + '" data-w="' + w + '" data-h="' + h + '" data-mime="image/jpeg">' };
};
const MISSING = "f".repeat(64);

function commentPdf(comments, opts) {
  S.state = migrateRows({
    schema: 2, title: "Comment pictures",
    rows: [{ id: "r0", visualText: "A scene.", audioText: "Some audio.", status: "todo" }],
    comments: comments.map((c, i) => Object.assign({
      id: "c" + i, rowId: "r0", field: "audioText", author: "Ann",
      createdAt: "2026-09-0" + (i % 9 + 1) + "T10:00:00Z", replies: []
    }, c))
  });
  return (opts && opts.map) ? pdfCommentImagesFor().then((map) => buildPdf(null, map)) : Promise.resolve(buildPdf(null));
}

/* The comments section's draw ops, in order, with the page each is on,
   and every page's /XObject names. */
function commentOps(bytes) {
  const t = new TextDecoder("latin1").decode(bytes);
  const pages = parse(bytes);
  const start = pages.findIndex((ops) => ops.some((o) => o.kind === "text" && o.str === "Comments"));
  assert.ok(start >= 0, "no comments section");
  const out = [];
  pages.forEach((ops, p) => {
    if (p < start) return;
    let seen = p > start;
    ops.forEach((o) => {
      if (!seen) { if (o.kind === "text" && o.str === "Comments") seen = true; return; }
      if (o.kind === "img") out.push(Object.assign({ page: p, bottom: o.y }, o));
      else if (o.kind === "text" && !/^Comments/.test(o.str)) out.push(Object.assign({ page: p, bottom: o.y - 2.5 }, o));
    });
  });
  const xobjects = [...t.matchAll(/\/Type \/Page \/Parent[^\n]*/g)].map((m) => {
    const x = /\/XObject << ([^>]*) >>/.exec(m[0]);
    return x ? [...x[1].matchAll(/\/(Im\d+) /g)].map((n) => n[1]) : [];
  });
  return { ops: out, pages, xobjects, embedded: (t.match(/\/Subtype \/Image/g) || []).length };
}

/* In stream order each thing sits wholly below the one before it on its
   page (a line at the same height is the rest of the same line), and
   nothing leaves the page. */
function checkThread(ops) {
  ops.forEach((o, i) => {
    assert.ok(o.bottom >= M - 3 && o.top <= PH - M + 0.01, (o.name || o.str) + " off the page");
    if (o.kind === "img") assert.ok(o.x + o.w <= PW - M + 0.01, o.name + " past the right margin");
    const prev = ops[i - 1];
    if (!prev || prev.page !== o.page) return;
    if (prev.kind === "text" && o.kind === "text" && prev.y === o.y) return;
    assert.ok(o.top <= prev.bottom + 0.01,
      (o.name || o.str) + " (top " + o.top.toFixed(2) + ") overlaps " + (prev.name || prev.str) + " (bottom " + prev.bottom.toFixed(2) + ")");
  });
}

const textIndex = (ops, str) => ops.findIndex((o) => o.kind === "text" && o.str === str);

test("a comment's and a reply's pictures print in the thread, in order, clear of the text", async () => {
  const a = cimg(640, 480), b = cimg(200, 100), c = cimg(301, 202);
  for (const map of [false, true]) {
    const { ops, xobjects } = commentOps(await commentPdf([{
      body: "Before " + a.html + "Between<br>" + b.html + " After",
      replies: [{ id: "rp0", author: "Bob", body: "Reply text " + c.html + " reply after", createdAt: "2026-09-02T10:00:00Z" }]
    }], { map }));
    checkThread(ops);
    const imgs = ops.filter((o) => o.kind === "img");
    assert.equal(imgs.length, 3, "three pictures drawn (map " + map + ")");
    const order = ["Before", imgs[0].name, "Between", imgs[1].name, "After", "Reply", imgs[2].name, "reply"]
      .map((k) => ops.findIndex((o) => o.name === k || (o.kind === "text" && o.str === k)));
    assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), "out of order: " + order);
    /* the body's pictures at the body's indent, the reply's at the reply's */
    assert.equal(imgs[0].x, M + 12);
    assert.equal(imgs[2].x, M + 24);
    /* registered on the page that draws them */
    imgs.forEach((im) => assert.ok(xobjects[im.page].includes(im.name), im.name + " not in its page's resources"));
  }
});

test("a comment picture is sized to the column, keeps its aspect and is never enlarged", async () => {
  const big = cimg(3000, 2000), small = cimg(40, 30), tall = cimg(500, 4000);
  const { ops } = commentOps(await commentPdf([
    { body: big.html }, { body: small.html }, { body: tall.html }
  ]));
  checkThread(ops);
  const [bi, si, ti] = ops.filter((o) => o.kind === "img");
  /* 60% of the body's 492pt column, 3:2 */
  assert.ok(Math.abs(bi.w - 492 * 0.6) < 0.01 && Math.abs(bi.w / bi.h - 1.5) < 0.01, JSON.stringify(bi));
  /* 40 x 30 px at 96 dpi, not blown up to the column */
  assert.ok(Math.abs(si.w - 30) < 0.01 && Math.abs(si.h - 22.5) < 0.01, JSON.stringify(si));
  /* a tall one capped by height, aspect kept */
  assert.ok(ti.h <= 260.01 && Math.abs(ti.h / ti.w - 8) < 0.01, JSON.stringify(ti));
  /* a picture-only body prints the picture, not "(empty)" */
  assert.equal(textIndex(ops, "\\(empty\\)"), -1);
});

test("a picture whose bytes are missing prints \"[image unavailable]\"", async () => {
  for (const map of [false, true]) {
    const { ops, embedded } = commentOps(await commentPdf([
      { body: "Look: <img class=\"comment-img\" data-blob=\"" + MISSING + "\"> there." }
    ], { map }));
    checkThread(ops);
    assert.equal(embedded, 0);
    const strs = ops.map((o) => o.str);
    const at = strs.indexOf("[image");
    assert.ok(at > strs.indexOf("Look:") && strs[at + 1] === "unavailable]" && strs.indexOf("there.") > at + 1, strs.join("|"));
  }
});

test("an image conflict card prints its picture", async () => {
  const pic = cimg(320, 240);
  const { ops } = commentOps(await commentPdf([
    { kind: "conflict", field: "visualImage", conflictField: "Visual image", imageValue: pic.rec, body: "" }
  ], { map: true }));
  const imgs = ops.filter((o) => o.kind === "img");
  assert.equal(imgs.length, 1);
  assert.equal(textIndex(ops, "\\(empty\\)"), -1);
});

test("the same picture twice is embedded once and listed on every page that draws it", async () => {
  const pic = cimg(600, 400);
  const filler = lines(40, "Filler");
  const { ops, xobjects, embedded } = commentOps(await commentPdf([
    { body: pic.html }, { body: filler }, { body: pic.html }
  ]));
  checkThread(ops);
  const imgs = ops.filter((o) => o.kind === "img");
  assert.equal(imgs.length, 2);
  assert.equal(embedded, 1);
  assert.equal(imgs[0].name, imgs[1].name);
  assert.notEqual(imgs[0].page, imgs[1].page);
  imgs.forEach((im) => assert.ok(xobjects[im.page].includes(im.name)));
});

test("a comment picture that does not fit in what is left of a page starts the next page", async () => {
  const pic = cimg(400, 300);
  let broke = 0;
  for (let n = 0; n <= 32; n++) {
    const { ops } = commentOps(await commentPdf([
      { body: lines(n, "Push") + (n ? "<br>" : "") + pic.html + " After it." }
    ]));
    checkThread(ops);
    const img = ops.find((o) => o.kind === "img");
    assert.ok(img, "n=" + n + ": the picture was dropped");
    const prev = ops[ops.indexOf(img) - 1];
    if (prev.page < img.page) {
      broke++;
      /* it went over because it did not fit under the last line: whole
         at the top of the next page, under the continued heading */
      assert.ok(prev.y - 13 - 3 - img.h < M, "n=" + n + ": broke a page it fitted on");
      assert.ok(img.top > PH - M - 60, "n=" + n + ": not at the top of the new page (" + img.top + ")");
    }
  }
  assert.ok(broke > 0, "no variant pushed the picture onto the next page");
});

test("commentEntries() keeps its plain-text shape; pieces only when asked", () => {
  const pic = cimg(120, 90);
  S.state = migrateRows({
    schema: 2, title: "t", rows: [{ id: "r0", visualText: "v", audioText: "a", status: "todo" }],
    comments: [{ id: "c0", rowId: "r0", field: "audioText", author: "Ann", body: "One&nbsp;" + pic.html + "<br>two <b>three</b>",
      replies: [{ id: "rp0", author: "Bob", body: "plain <i>reply</i>" }] }]
  });
  const [plain] = commentEntries();
  assert.equal(plain.body, "One \ntwo three");
  assert.ok(!("pieces" in plain) && !("pieces" in plain.replies[0]));
  const [withPieces] = commentEntries({ pieces: true });
  assert.equal(withPieces.body, plain.body);
  assert.deepEqual(withPieces.pieces, [{ text: "One" }, { image: pic.rec.sha256 }, { text: "two three" }]);
  assert.deepEqual(withPieces.replies[0].pieces, [{ text: "plain reply" }]);
});
