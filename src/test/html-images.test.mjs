import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sanitizeHtml, storedHtmlFromDom, storedImageHtml } from "../js/04-richtext.js";
import { dataUrlForSync, has, inlineStateImages, recordFor } from "../js/02c-blobs.js";
import { migrateRows } from "../js/02-state.js";
import { refsIn } from "../../shared/blob-policy.js";

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w, h) => new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
  ...be32(w), ...be32(h), 8, 6, 0, 0, 0, ...be32(0), ...be32(0), 0x49, 0x45, 0x4e, 0x44
]);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const dataUrl = (b, type) => "data:" + (type || "image/png") + ";base64," + Buffer.from(b).toString("base64");
const stored = (s, w, h, mime) => '<img class="comment-img" data-blob="' + s + '"' +
  (w ? ' data-w="' + w + '" data-h="' + h + '" data-mime="' + mime + '"' : "") + ">";

test("an inline data: image becomes the stored form, its bytes in the registry", () => {
  const b = png(71, 13);
  const out = sanitizeHtml('before <img src="' + dataUrl(b) + '" alt="x" onerror="alert(1)"> after');
  assert.equal(out, "before " + stored(sha(b), 71, 13, "image/png") + " after");
  assert.equal(out.indexOf("data:"), -1);
  assert.equal(out.indexOf("src"), -1);
  assert.ok(has(sha(b)));
  assert.deepEqual(recordFor(sha(b)), { sha256: sha(b), width: 71, height: 13, mime: "image/png" });
});

test("the type is the bytes', whatever the URI claims, and line-wrapped base64 is the same picture", () => {
  const b = png(72, 13);
  const wrapped = "data:image/jpeg;base64," + Buffer.from(b).toString("base64").replace(/(.{16})/g, "$1\n");
  assert.equal(sanitizeHtml('<img src="' + wrapped + '">'), stored(sha(b), 72, 13, "image/png"));
});

test("sanitising is idempotent", () => {
  const b = png(73, 13);
  const unknown = "f".repeat(64);
  for (const html of [
    '<p>a <img src="' + dataUrl(b) + '"> b</p>',
    '<img data-blob="' + unknown + '" data-w="5" data-h="6" data-mime="image/webp">',
    '<img data-blob="' + unknown + '">',
    '<b>x</b><img data-blob="' + sha(b) + '" src="blob:https://splitpage.test/1">'
  ]) {
    const once = sanitizeHtml(html);
    assert.equal(sanitizeHtml(once), once, html);
  }
});

test("a data-blob image loses any src — the hydrator's blob: URL, or anything else", () => {
  const b = png(74, 13);
  sanitizeHtml('<img src="' + dataUrl(b) + '">');
  const other = png(75, 13);
  for (const src of ["blob:https://splitpage.test/abc", "https://evil.example/x.png", dataUrl(other), "javascript:alert(1)"]) {
    assert.equal(sanitizeHtml('<img data-blob="' + sha(b) + '" src="' + src + '">'), stored(sha(b), 74, 13, "image/png"), src);
  }
  assert.equal(has(sha(other)), false, "a data: src next to a valid data-blob is not even interned");
});

test("a known sha takes the registry's record; an unknown one keeps a valid record of its own, or none", () => {
  const b = png(76, 13);
  sanitizeHtml('<img src="' + dataUrl(b) + '">');
  assert.equal(sanitizeHtml('<img data-blob="' + sha(b) + '" data-w="999" data-h="1" data-mime="image/gif">'),
    stored(sha(b), 76, 13, "image/png"), "the attributes cannot lie about bytes this page holds");
  const unknown = "a1".repeat(32);
  assert.equal(sanitizeHtml('<img class="x" data-blob="' + unknown + '" data-w="5" data-h="6" data-mime="image/webp" width="9">'),
    stored(unknown, 5, 6, "image/webp"), "kept, to hydrate from a store or the server later");
  for (const bad of [' data-w="5" data-h="6" data-mime="image/svg+xml"', ' data-w="0" data-h="6" data-mime="image/png"',
    ' data-w="5.5" data-h="6" data-mime="image/png"', ' data-w="5" data-mime="image/png"', ' data-w="-5" data-h="6" data-mime="image/png"']) {
    assert.equal(sanitizeHtml('<img data-blob="' + unknown + '"' + bad + ">"), stored(unknown), bad);
  }
});

test("a bad sha is dropped — unless the image also carries a picture of its own", () => {
  for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "", " " + "a".repeat(64)]) {
    assert.equal(sanitizeHtml('x<img data-blob="' + bad + '">y'), "xy", JSON.stringify(bad));
  }
  const b = png(77, 13);
  assert.equal(sanitizeHtml('<img data-blob="nope" src="' + dataUrl(b) + '">'), stored(sha(b), 77, 13, "image/png"));
});

test("never SVG, never a remote image, never a data: URI that is not a picture", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>';
  for (const src of [
    "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"),
    "data:image/svg+xml," + encodeURIComponent(svg),
    "data:image/png;base64," + Buffer.from(svg).toString("base64"),
    "data:image/png;base64,AAAA",
    "data:text/html;base64,PHNjcmlwdD4=",
    "https://example.com/x.png",
    "blob:https://splitpage.test/abc",
    "x"
  ]) {
    assert.equal(sanitizeHtml('a<img src="' + src + '">b'), "ab", src);
  }
});

test("storedImageHtml is exactly what the sanitiser writes", () => {
  const ref = { sha256: "b2".repeat(32), width: 8, height: 9, mime: "image/jpeg" };
  assert.equal(storedImageHtml(ref), stored(ref.sha256, 8, 9, "image/jpeg"));
  assert.equal(sanitizeHtml(storedImageHtml(ref)), storedImageHtml(ref));
  assert.equal(storedImageHtml(null), "");
  assert.equal(storedImageHtml({ ...ref, mime: "image/svg+xml" }), "");
});

test("storedHtmlFromDom takes the hydrator's attributes back out, and nothing else", () => {
  const s1 = "c3".repeat(32);
  const live = 'one <strong>two</strong> <img class="comment-img" data-blob="' + s1 + '" data-w="4" data-h="5" data-mime="image/png" src="blob:https://splitpage.test/9"> ' +
    '<img class="comment-img" data-blob="' + s1 + '" data-blob-state="missing" alt="Image unavailable" title="Image unavailable"> three&nbsp;';
  assert.equal(storedHtmlFromDom(live),
    'one <strong>two</strong> ' + stored(s1, 4, 5, "image/png") + " " + stored(s1) + " three&nbsp;");
  const plain = 'no <em>pictures</em> <img src="x"> here';
  assert.equal(storedHtmlFromDom(plain), plain, "no data-blob: untouched, not even re-serialised");
  assert.equal(storedHtmlFromDom(""), "");
});

test("an old document's inline comment, reply and cell images open content-addressed", () => {
  const [a, b, c] = [png(81, 13), png(82, 13), png(83, 13)];
  const doc = migrateRows({
    schema: 2, title: "Old HTML pictures",
    rows: [{ id: "r1", visualText: 'pasted <img src="' + dataUrl(a) + '">', audioText: "x" }],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", body: 'look <img class="comment-img" src="' + dataUrl(b) + '">',
      replies: [{ id: "rp1", body: 'and <img src="' + dataUrl(c) + '">', author: "B" }] }]
  });
  assert.equal(JSON.stringify(doc).indexOf("data:image"), -1);
  assert.equal(doc.rows[0].visualText, "pasted ");
  assert.equal(doc.comments.length, 2);
  assert.ok(doc.comments[1].body.endsWith("<br>" + stored(sha(a), 81, 13, "image/png")));
  assert.equal(doc.comments[0].body, "look " + stored(sha(b), 82, 13, "image/png"));
  assert.equal(doc.comments[0].replies[0].body, "and " + stored(sha(c), 83, 13, "image/png"));
  assert.deepEqual(refsIn(doc).sort(), [sha(a), sha(b), sha(c)].sort());
});

test("a file carries HTML images inline, and reading it back gives the stored form", () => {
  const [a, b, c] = [png(91, 13), png(92, 13), png(93, 13)];
  const ghost = "d4".repeat(32);
  const doc = migrateRows({
    schema: 2, title: "Pictures in HTML",
    rows: [{ id: "r1", visualText: 'v <img src="' + dataUrl(a) + '"> <img data-blob="' + ghost + '">', audioText: "x" }],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", body: '<img src="' + dataUrl(b) + '">',
      replies: [{ id: "rp1", body: 'r <img src="' + dataUrl(c) + '">', author: "B" }] }]
  });
  assert.equal(doc.rows[0].visualText.indexOf("<img"), -1);
  assert.equal(doc.comments.length, 3);
  const file = JSON.parse(JSON.stringify(doc));
  const missing = inlineStateImages(file);
  assert.deepEqual(missing, [ghost], "what nobody holds is reported and stays a ref");
  assert.ok(file.comments[1].body.endsWith('<br><img src="' + dataUrlForSync(sha(a)) + '" class="comment-img">'));
  assert.ok(file.comments[2].body.endsWith("<br>" + stored(ghost)));
  assert.equal(file.comments[0].body, '<img src="' + dataUrlForSync(sha(b)) + '" class="comment-img">');
  assert.equal(file.comments[0].replies[0].body, 'r <img src="' + dataUrlForSync(sha(c)) + '" class="comment-img">');
  const back = migrateRows(file);
  assert.equal(back.rows[0].visualText, doc.rows[0].visualText);
  assert.deepEqual(back.comments.map((x) => x.body), doc.comments.map((x) => x.body));
  assert.equal(back.comments[0].replies[0].body, doc.comments[0].replies[0].body);
  const some = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(inlineStateImages(some, [sha(b)]), []);
  assert.equal(some.comments[1].body, doc.comments[1].body);
  assert.equal(some.comments[0].body, '<img src="' + dataUrlForSync(sha(b)) + '" class="comment-img">');
  assert.equal(some.comments[0].replies[0].body, doc.comments[0].replies[0].body);
  const raw = { rows: [{ id: "r9", visualText: "v " + stored(sha(a), 91, 13, "image/png"), audioText: "" }], comments: [] };
  assert.deepEqual(inlineStateImages(raw), []);
  assert.equal(raw.rows[0].visualText, 'v <img src="' + dataUrlForSync(sha(a)) + '" class="comment-img">');
});
