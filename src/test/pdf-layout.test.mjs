import "./_dom.mjs";
import "./_export-services-started.mjs";
import { liveDoc, liveWithAssets } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { intern } from "../adapters/storage/02c-blobs.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { commentEntries } from "../js/10-comments.js";
import { buildPdf, pdfCommentImagesFor } from "../js/17-pdf.js";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { loadTestDocument } from "./_document.mjs";

initStatus();
initTags();

const PH = 792, M = 54;
const VW = 184, VX = 100, AX = 298;
const VS = 9, VL = 12.5, AS = 10, AL = 14;
const TOPB = 10, TAIL = 14, EMPTY = 4, PIC_GAP = 8, ROW_GAP = 10, GUT_H = 36;
const ROW_TOP = PH - M - 23, PAGE_ROOM = ROW_TOP - M;
const colH = (n, lead) => (n ? TOPB + (n - 1) * lead + TAIL : EMPTY);

const jpeg = (w, h) => {
  const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
  return { bytes, size: { w, h } };
};
const lines = (n, word) => Array.from({ length: n }, (_, i) => (word || "Line") + " " + (i + 1)).join("<br>");

function pdfFor(rows) {
  loadTestDocument(migrateRows({
    schema: 2, title: "Layout", comments: [],
    rows: rows.map((r, i) => ({ id: "r" + i, visualText: r.v || "", audioText: r.a || "", status: "todo" }))
  }));
  return buildPdf(liveDoc(), rows.map((r) => (r.pic ? jpeg(r.pic[0], r.pic[1]) : null)));
}

function parse(bytes) {
  const t = new TextDecoder("latin1").decode(bytes);
  const pages = [];
  const re = /obj\n<< \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(t))) {
    const stream = t.substr(re.lastIndex, +m[1]);
    let artifact = false;
    pages.push(stream.split("\n").map((op) => {
      let x;
      if (/^\/Artifact .* BDC$/.test(op)) { artifact = true; return { kind: "other", op }; }
      if (op === "EMC") { artifact = false; return { kind: "other", op }; }
      if (artifact) return { kind: "footer", op };
      if ((x = /^q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([-\d.]+) cm \/(Im\d+) Do Q$/.exec(op))) {
        return { kind: "img", name: x[5], w: +x[1], h: +x[2], x: +x[3], y: +x[4], top: +x[4] + +x[2] };
      }
      if ((x = /^(?:q ([\d.]+ [\d.]+ [\d.]+) rg )?BT \/(F\d) ([\d.]+) Tf 1 0 0 1 ([\d.]+) ([-\d.]+) Tm \((.*)\) Tj ET(?: Q)?$/.exec(op))) {
        return { kind: "text", color: x[1] || null, str: x[6], font: x[2], size: +x[3], x: +x[4], y: +x[5], top: +x[5] + +x[3] };
      }
      if ((x = /^q 0\.863 0\.855 0\.831 RG 0\.5 w 54\.00 ([-\d.]+) m 558\.00 /.exec(op))) return { kind: "rowrule", y: +x[1], top: +x[1] };
      if ((x = / ([-\d.]+) [\d.]+ [\d.]+ re f Q$/.exec(op))) return { kind: "fill", y: +x[1], top: +x[1] };
      return { kind: "other", op };
    }));
  }
  return pages;
}

function checkLayout(pages) {
  const images = [];
  pages.forEach((ops, p) => {
    ops.forEach((op, i) => {
      if (op.kind !== "img") return;
      images.push(Object.assign({ page: p }, op));
      assert.ok(op.y >= M - 0.01 && op.top <= PH - M + 0.01, op.name + " off the page: " + JSON.stringify(op));
      const rule = ops.findIndex((o, k) => k > i && o.kind === "rowrule");
      if (rule < 0) {
        assert.ok(p < pages.length - 1, op.name + " has no row rule after it");
        ops.slice(i + 1).forEach((o) => {
          if (o.kind === "text" && o.x < op.x + op.w) assert.ok(o.top <= op.y + 0.01, o.str + " drawn over " + op.name);
        });
        return;
      }
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
    { pic: [300, 200] },
    { pic: [300, 200] },
    { a: "Short.", pic: [300, 200] },
    { v: "Short caption.", pic: [300, 200] },
    { a: lines(40), pic: [300, 200] },
    { a: "The last row." }
  ]));
  const images = checkLayout(pages);
  assert.equal(images.length, 6);
  assert.equal(images[1].w, VW);
  assert.equal(images[1].h.toFixed(2), (VW * 2 / 3).toFixed(2));
});

test("a picture-only row's height is its picture plus the normal row gap", () => {
  const pages = parse(pdfFor([{ pic: [300, 200] }, { pic: [300, 200] }]));
  const [a, b] = pages.flat().filter((o) => o.kind === "img");
  assert.ok(a && b);
  assert.equal(pages.length, 1);
  assert.ok(Math.abs(a.y - b.top - (PIC_GAP + EMPTY + ROW_GAP)) < 0.02, "gap " + (a.y - b.top));
});

test("a picture that does not fit in what is left of a page starts a new page", () => {
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

const PW = 612;
const CI = 20, RI = 34;
const cimg = (w, h) => {
  const rec = intern(jpeg(w, h).bytes);
  assert.ok(rec, "fake JPEG " + w + "x" + h + " interned");
  return { rec, html: '<img class="comment-img" data-blob="' + rec.sha256 + '" data-w="' + w + '" data-h="' + h + '" data-mime="image/jpeg">' };
};
const MISSING = "f".repeat(64);

function commentPdf(comments) {
  loadTestDocument(migrateRows({
    schema: 2, title: "Comment pictures",
    rows: [{ id: "r0", visualText: "A scene.", audioText: "Some audio.", status: "todo" }],
    comments: comments.map((c, i) => Object.assign({
      id: "c" + i, rowId: "r0", field: "audioText", author: "Ann",
      createdAt: "2026-09-0" + (i % 9 + 1) + "T10:00:00Z", replies: []
    }, c))
  }));
  const [doc, assets] = liveWithAssets();
  return pdfCommentImagesFor(doc, assets).then((map) => buildPdf(doc, null, map));
}

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
  {
    const { ops, xobjects } = commentOps(await commentPdf([{
      body: "Before " + a.html + "Between<br>" + b.html + " After",
      replies: [{ id: "rp0", author: "Bob", body: "Reply text " + c.html + " reply after", createdAt: "2026-09-02T10:00:00Z" }]
    }]));
    checkThread(ops);
    const imgs = ops.filter((o) => o.kind === "img");
    assert.equal(imgs.length, 3, "three pictures drawn");
    const order = ["Before", imgs[0].name, "Between", imgs[1].name, "After", "Reply", imgs[2].name, "reply"]
      .map((k) => ops.findIndex((o) => o.name === k || (o.kind === "text" && o.str === k)));
    assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), "out of order: " + order);
    assert.equal(imgs[0].x, M + CI);
    assert.equal(imgs[2].x, M + RI);
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
  assert.ok(Math.abs(bi.w - (PW - M - (M + CI)) * 0.6) < 0.01 && Math.abs(bi.w / bi.h - 1.5) < 0.01, JSON.stringify(bi));
  assert.ok(Math.abs(si.w - 30) < 0.01 && Math.abs(si.h - 22.5) < 0.01, JSON.stringify(si));
  assert.ok(ti.h <= 260.01 && Math.abs(ti.h / ti.w - 8) < 0.01, JSON.stringify(ti));
  assert.equal(textIndex(ops, "\\(empty\\)"), -1);
});

test("a picture whose bytes are missing prints \"[image unavailable]\"", async () => {
  {
    const { ops, embedded } = commentOps(await commentPdf([
      { body: "Look: <img class=\"comment-img\" data-blob=\"" + MISSING + "\"> there." }
    ]));
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
  ]));
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
  for (let n = 0; n <= 46; n++) {
    const { ops } = commentOps(await commentPdf([
      { body: lines(n, "Push") + (n ? "<br>" : "") + pic.html + " After it." }
    ]));
    checkThread(ops);
    const img = ops.find((o) => o.kind === "img");
    assert.ok(img, "n=" + n + ": the picture was dropped");
    const prev = ops[ops.indexOf(img) - 1];
    if (prev.page < img.page) {
      broke++;
      assert.ok(prev.y - 13 - 3 - img.h < M, "n=" + n + ": broke a page it fitted on");
      assert.ok(img.top > PH - M - 60, "n=" + n + ": not at the top of the new page (" + img.top + ")");
    }
  }
  assert.ok(broke > 0, "no variant pushed the picture onto the next page");
});

const LEAD = 13, SIZE = 9.5;
const LINE_ROOM = LEAD - SIZE;

function commentLines(ops) {
  const out = [];
  ops.forEach((o) => {
    if (o.kind !== "text") return;
    const last = out[out.length - 1];
    if (last && last.page === o.page && last.y === o.y) { last.words.push(o.str); return; }
    out.push({ page: o.page, y: o.y, x: o.x, words: [o.str] });
  });
  return out;
}
const lineOf = (ls, word) => ls.findIndex((l) => l.words[0] === word);

test("the lines of one comment paragraph are exactly one line height apart", async () => {
  const para = (w, n) => Array.from({ length: n }, () => w).join(" ");
  const { ops } = commentOps(await commentPdf([{
    quotedText: para("quoted", 60),
    body: lines(6, "Body") + "<br>" + para("wraps", 90),
    replies: [
      { id: "rp0", author: "Bob", body: para("replying", 70), createdAt: "2026-09-02T10:00:00Z" },
      { id: "rp1", author: "Dee", body: lines(4, "Second"), createdAt: "2026-09-03T10:00:00Z" }
    ]
  }]));
  checkThread(ops);
  const ls = commentLines(ops);
  const part = (w) => ls.filter((l) => l.words[0] === w);
  const quote = ls.filter((l) => /quoted/.test(l.words.join(" ")));
  const body = ls.filter((l) => l.words[0] === "Body" || l.words[0] === "wraps");
  for (const [name, p] of [["quote", quote], ["body", body], ["reply 1", part("replying")], ["reply 2", part("Second")]]) {
    assert.ok(p.length >= 3, name + " wraps to several lines (" + p.length + ")");
    p.slice(1).forEach((l, i) => {
      if (l.page !== p[i].page) return;
      assert.ok(Math.abs(p[i].y - l.y - LEAD) < 0.005, name + " line " + (i + 2) + " is " + (p[i].y - l.y).toFixed(2) + "pt under the one before, not " + LEAD);
    });
    assert.equal(ls.indexOf(p[p.length - 1]) - ls.indexOf(p[0]), p.length - 1, name + " is not contiguous");
  }
  assert.equal(new Set(ls.map((l) => l.page)).size, 1, "fits one page");
  const starts = [lineOf(ls, "Scene"), ls.indexOf(quote[0]), ls.indexOf(body[0]), lineOf(ls, "Bob"), ls.indexOf(part("replying")[0])];
  starts.push(lineOf(ls, "Dee"), ls.indexOf(part("Second")[0]));
  starts.slice(1).forEach((at, i) => {
    assert.ok(at > starts[i], "part " + (i + 2) + " out of order");
    assert.ok(Math.abs(ls[at - 1].y - ls[at].y - (LEAD + SIZE)) < 0.005,
      "part " + (i + 2) + " starts " + (ls[at - 1].y - ls[at].y).toFixed(2) + "pt under the part before");
  });
  assert.equal(body.length, part("Body").length + part("wraps").length);
});

test("replies and pictures keep their order and the room around a picture", async () => {
  const a = cimg(160, 120), b = cimg(90, 60);
  const { ops } = commentOps(await commentPdf([{
    body: lines(3, "Top") + a.html + lines(3, "Mid") + b.html + lines(2, "End"),
    replies: [1, 2, 3].map((k) => ({ id: "rp" + k, author: "R" + k, body: lines(2, "Reply" + k) + (k === 2 ? a.html + "Tail" : ""), createdAt: "2026-09-0" + (k + 1) + "T10:00:00Z" }))
  }]));
  checkThread(ops);
  const ls = commentLines(ops);
  const imgs = ops.filter((o) => o.kind === "img");
  assert.equal(imgs.length, 3);
  const at = (k) => ops.findIndex((o) => o === k || (o.kind === "text" && o.str === k));
  const order = ["Top", imgs[0], "Mid", imgs[1], "End", "Reply1", "Reply2", imgs[2], "Tail", "Reply3"].map(at);
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), "out of order: " + order);
  const mid = ls.filter((l) => l.words[0] === "Mid");
  assert.equal(mid.length, 3);
  mid.slice(1).forEach((l, i) => assert.ok(Math.abs(mid[i].y - l.y - LEAD) < 0.005, "Mid lines " + (mid[i].y - l.y).toFixed(2) + "pt apart"));
  assert.equal(new Set(ops.map((o) => o.page)).size, 1, "fits one page");
  imgs.forEach((im) => {
    const i = ops.indexOf(im), before = ops[i - 1], after = ops[i + 1];
    assert.ok(Math.abs(before.y - LEAD - 3 - im.top) < 0.02, im.name + " top " + im.top + " after a line at " + before.y);
    assert.ok(Math.abs(im.y - 7 - SIZE - after.y) < 0.02, im.name + " bottom " + im.y + " then a line at " + after.y);
  });
});

test("a comment near the bottom of a page carries on at the top of the next, never below the margin", async () => {
  let carried = 0, within = 0;
  for (let n = 0; n <= 56; n++) {
    const { ops } = commentOps(await commentPdf([
      { body: lines(n, "Push") },
      { body: lines(12, "Tail"), replies: [{ id: "rp0", author: "Bob", body: lines(5, "Answer"), createdAt: "2026-09-02T10:00:00Z" }] }
    ]));
    checkThread(ops);
    const ls = commentLines(ops);
    ls.forEach((l) => assert.ok(l.y - LINE_ROOM >= M - 0.005, "n=" + n + ": " + l.words.join(" ") + " at y=" + l.y + " is below the margin"));
    ls.slice(1).forEach((l, i) => {
      const prev = ls[i];
      if (l.page === prev.page) return;
      carried++;
      if (l.words[0] === prev.words[0]) {
        within++;
        assert.ok(prev.y - LEAD - LINE_ROOM < M, "n=" + n + ": broke after y=" + prev.y + " with room for another line");
      }
      assert.ok(Math.abs(l.y - (PH - M - 26 - SIZE)) < 0.005, "n=" + n + ": continued at y=" + l.y);
    });
    const words = ls.map((l) => l.words.join(" "));
    const want = [...Array.from({ length: n }, (_, i) => "Push " + (i + 1)), ...Array.from({ length: 12 }, (_, i) => "Tail " + (i + 1)), ...Array.from({ length: 5 }, (_, i) => "Answer " + (i + 1))];
    assert.deepEqual(words.filter((w) => /^(Push|Tail|Answer) /.test(w)), want, "n=" + n);
  }
  assert.ok(carried > 10 && within > 5, "only " + carried + " variants reached a second page, " + within + " mid-paragraph");
});

test("commentEntries(exportDocumentOf(S.state)) keeps its plain-text shape; pieces only when asked", () => {
  const pic = cimg(120, 90);
  loadTestDocument(migrateRows({
    schema: 2, title: "t", rows: [{ id: "r0", visualText: "v", audioText: "a", status: "todo" }],
    comments: [{ id: "c0", rowId: "r0", field: "audioText", author: "Ann", body: "One&nbsp;" + pic.html + "<br>two <b>three</b>",
      replies: [{ id: "rp0", author: "Bob", body: "plain <i>reply</i>" }] }]
  }));
  const [plain] = commentEntries(exportDocumentOf(S.state));
  assert.equal(plain.body, "One \ntwo three");
  assert.ok(!("pieces" in plain) && !("pieces" in plain.replies[0]));
  const [withPieces] = commentEntries(exportDocumentOf(S.state), { pieces: true });
  assert.equal(withPieces.body, plain.body);
  assert.deepEqual(withPieces.pieces, [{ text: "One" }, { image: pic.rec.sha256 }, { text: "two three" }]);
  assert.deepEqual(withPieces.replies[0].pieces, [{ text: "plain reply" }]);
});

const HIGHLIGHT_DROP = 2.5;

function drawnRows(pages) {
  const rows = [];
  let cur = null;
  pages.forEach((ops, p) => {
    let drewHere = false;
    ops.forEach((o) => {
      if (o.kind === "text" && !o.color && o.font === "F2" && o.size === 12 && o.x === M && /^\d+$/.test(o.str)) {
        assert.equal(cur, null, "row " + o.str + " starts before row " + (cur && cur.n) + " has its rule");
        cur = { n: +o.str, page: p, y: o.y + TOPB, lines: [], pic: null };
        rows.push(cur);
        drewHere = true;
      } else if (o.kind === "text" && !o.color && (o.size === VS || o.size === AS) && o.x >= VX - 0.01) {
        assert.ok(cur, "line " + o.str + " outside a row");
        const col = o.x >= AX - 0.01 ? "a" : "v";
        assert.equal(o.size, col === "a" ? AS : VS, o.str + " at the other column's size");
        const last = cur.lines.filter((l) => l.col === col).pop();
        if (last && last.page === p && last.y === o.y) last.str += " " + o.str;
        else cur.lines.push({ col, page: p, y: o.y, str: o.str });
        drewHere = true;
      } else if (o.kind === "img") {
        assert.ok(cur, o.name + " outside a row");
        cur.pic = { page: p, y: o.y, h: o.h };
        drewHere = true;
      } else if (o.kind === "rowrule") {
        assert.ok(cur, "a rule with no row");
        assert.ok(drewHere, "row " + cur.n + "'s rule is alone at the top of page " + (p + 1));
        cur.rulePage = p;
        cur.ruleY = o.y;
        cur = null;
        drewHere = false;
      }
    });
  });
  assert.equal(cur, null, "the last row has no rule");
  return rows;
}

const migrated = new Map();
function rowPdf(specs) {
  const base = migrateRows({ schema: 2, title: "Layout", comments: [], rows: [] });
  loadTestDocument(Object.assign(base, {
    rows: specs.map((r, i) => {
      const key = r.v + "/" + r.a;
      if (!migrated.has(key)) {
        migrated.set(key, migrateRows({ schema: 2, title: "x", comments: [], rows: [{ id: "r", visualText: lines(r.v), audioText: lines(r.a), status: "todo" }] }).rows[0]);
      }
      return Object.assign({}, migrated.get(key), { id: "r" + i });
    })
  }));
  return buildPdf(liveDoc(), specs.map((r) => (r.pic ? jpeg(r.pic[0], r.pic[1]) : null)));
}

function checkRowRules(specs, label) {
  const pages = parse(rowPdf(specs));
  checkLayout(pages);
  const rows = drawnRows(pages);
  assert.equal(rows.length, specs.length, label + ": rows drawn");
  rows.forEach((row, i) => {
    const spec = specs[i], at = label + " row " + row.n;
    assert.ok(row.ruleY >= M - 0.005, at + ": rule at y=" + row.ruleY + ", below the margin");
    ["v", "a"].forEach((col) => {
      const ls = row.lines.filter((l) => l.col === col);
      assert.deepEqual(ls.map((l) => l.str), Array.from({ length: spec[col] }, (_, k) => "Line " + (k + 1)), at + ": " + col + " lines");
      ls.forEach((l) => {
        assert.ok(l.y >= M - 0.005, at + ": " + l.str + " at y=" + l.y + ", below the margin");
        assert.ok(l.y - HIGHLIGHT_DROP >= M - HIGHLIGHT_DROP - 0.005);
      });
    });
    row.lines.forEach((l) => assert.ok(l.page < row.rulePage || l.y > row.ruleY, at + ": " + l.str + " under its rule"));
    const picH = row.pic ? row.pic.h + PIC_GAP : 0;
    const need = Math.max(picH + colH(spec.v, VL), colH(spec.a, AL), GUT_H);
    const lead = { v: VL, a: AL };
    if (row.rulePage > row.page) {
      if (i === 0) assert.equal(row.page, 0, at + ": the first scene left page 1");
      else {
        assert.ok(Math.abs(row.y - ROW_TOP) < 0.01, at + ": split, but started at y=" + row.y + ", not the top of a page");
        assert.ok(need > PAGE_ROOM + 0.005, at + ": split although it fits on a page (" + need + ")");
      }
      for (let p = row.page; p < row.rulePage; p++) {
        ["v", "a"].forEach((col) => {
          if (!row.lines.some((l) => l.col === col && l.page > p)) return;
          const here = row.lines.filter((l) => l.col === col && l.page === p);
          const L = lead[col];
          let last;
          if (here.length) last = here[here.length - 1].y;
          else if (col === "v" && row.pic && row.pic.page === p) last = row.pic.y - PIC_GAP - TOPB + L;
          else if (col === "a" && p > row.page) return assert.fail(at + ": no audio on page " + (p + 1) + " while it carries on");
          else last = (p === row.page ? row.y : ROW_TOP) - TOPB + L;
          assert.ok(last - L - TAIL < M, at + ": page " + (p + 1) + " broke the " + col + " column after y=" + last + " with room left");
        });
      }
    } else {
      assert.ok(Math.abs(row.y - need - row.ruleY) < 0.01, at + ": rule at " + row.ruleY + ", expected " + (row.y - need));
    }
    const prev = rows[i - 1];
    if (prev && row.page > prev.rulePage) {
      assert.ok(prev.ruleY - ROW_GAP - need < M - 0.005, at + ": moved to page " + (row.page + 1) + " with room for it on page " + row.page);
    }
  });
  return rows;
}

test("every row's rule lands on or above the bottom margin, never alone, with no row split early", () => {
  let split = 0, carried = 0, pushed = 0, capped = 0;
  const shapes = [];
  for (const v of [0, 1, 2, 52, 53, 54, 100]) {
    for (const a of [0, 1, 3, 46, 47, 48, 100]) {
      for (const pic of [null, [VW, 200], [VW, 610], [VW, 625], [VW, 640], [VW, 655], [VW, 5000]]) {
        shapes.push({ v, a, pic });
      }
    }
  }
  for (let n = 0; n <= 52; n++) {
    shapes.forEach((shape) => {
      if (shape.v > 3 || shape.a > 3 ? n % 13 : n < 24 && n % 6) return;
      const rows = checkRowRules([{ v: 0, a: n }, shape, { v: 0, a: 1 }], "n=" + n + " " + JSON.stringify(shape));
      const row = rows[1];
      if (row.rulePage > row.page) split++;
      if (row.page > rows[0].page) pushed++;
      if (row.rulePage > row.page && !row.lines.some((l) => l.page === row.page)) carried++;
      if (row.pic && row.pic.h < Math.min(shape.pic[1], PAGE_ROOM) - 0.01) capped++;
    });
  }
  assert.ok(split > 100 && pushed > 100 && carried > 0 && capped > 0, "split " + split + ", pushed " + pushed + ", carried " + carried + ", capped " + capped);
});

test("a row that finishes a page's last lines takes its last line overleaf with its rule", () => {
  const rows = checkRowRules([{ v: 0, a: 1 }, { v: 0, a: 94 }], "94 lines");
  const row = rows[1];
  const pagesOf = [...new Set(row.lines.map((l) => l.page))];
  assert.deepEqual(pagesOf.map((p) => row.lines.filter((l) => l.page === p).length), [47, 46, 1]);
  assert.equal(row.ruleY, ROW_TOP - TOPB - TAIL);
  const top = checkRowRules([{ v: 0, a: 1 }, { v: 0, a: 1 }], "probe")[0].ruleY - ROW_GAP;
  const fit = Math.floor((top - M - TOPB - TAIL) / AL) + 1;
  const snug = checkRowRules([{ v: 0, a: 1 }, { v: 0, a: fit }], "snug");
  assert.equal(snug[1].page, 0);
  assert.ok(snug[1].ruleY - M < AL, "a line's room left under the snug row: " + snug[1].ruleY);
  const over = checkRowRules([{ v: 0, a: 1 }, { v: 0, a: fit + 1 }], "one over");
  assert.equal(over[1].page, 1);
  assert.equal(over[1].rulePage, 1);
});

test("the first scene never leaves page 1 to the title block alone", () => {
  const rows = checkRowRules([{ v: 0, a: 45 }, { v: 0, a: 1 }], "first");
  assert.equal(rows[0].page, 0);
  assert.equal(rows[0].rulePage, 1);
  assert.ok(rows[0].lines.some((l) => l.page === 0));
  const [pic] = checkRowRules([{ v: 1, a: 0, pic: [VW, 5000] }], "first picture");
  assert.equal(pic.pic.page, 0);
  assert.ok(pic.pic.h < PAGE_ROOM - 50, "not capped to page 1's room: " + pic.pic.h);
});

test("a picture that fills its page keeps its visual text, overleaf, and a picture-only row's rule stays inside the margin", () => {
  const [, withText] = checkRowRules([{ v: 0, a: 1 }, { v: 2, a: 0, pic: [VW, 5000] }, { v: 0, a: 1 }], "full picture + text");
  assert.equal(withText.pic.h.toFixed(2), PAGE_ROOM.toFixed(2));
  assert.deepEqual(withText.lines.map((l) => l.page), [2, 2]);
  const [, alone] = checkRowRules([{ v: 0, a: 1 }, { v: 0, a: 0, pic: [VW, 5000] }], "full picture alone");
  assert.equal(alone.ruleY, M);
  assert.equal(alone.pic.h.toFixed(2), (PAGE_ROOM - PIC_GAP - EMPTY).toFixed(2));
});
