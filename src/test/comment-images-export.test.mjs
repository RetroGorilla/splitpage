import "./_dom.mjs";
import "./_export-services-started.mjs";
import { liveDoc, liveWithAssets } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { migrateRows } from "../js/02-state.js";
import { intern } from "../adapters/storage/02c-blobs.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { commentBodyText, commentEntries } from "../js/10-comments.js";
import { zipRead } from "../adapters/formats/zip.ts";
import { toMarkdownDoc, toMarkdownTableDoc } from "../adapters/formats/export-text.ts";
import { buildDocx } from "../adapters/formats/docx.ts";
import { buildCsv } from "../adapters/formats/csv.ts";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { loadTestDocument } from "./_document.mjs";

initTags();

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const jpegBytes = (w, h) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
const pngBytes = (w, h) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
};
const pic = (bytes) => {
  const rec = intern(bytes);
  assert.ok(rec, "fake picture interned");
  return { rec, html: '<img class="comment-img" data-blob="' + rec.sha256 + '">' };
};
const MISSING = "f".repeat(64);

const ROW1 = { id: "r0", visualText: "A scene.", audioText: "Some audio.", status: "todo" };
const ROW2 = { id: "r1", visualText: "Another.", audioText: "More audio.", status: "todo" };

function setDoc(rows, comments) {
  loadTestDocument(migrateRows({
    schema: 2, title: "Comment pictures",
    rows: rows || [ROW1, ROW2],
    comments: comments.map((c, i) => Object.assign({
      id: "c" + i, rowId: "r0", field: "audioText", author: "Ann",
      createdAt: "2026-09-0" + (i % 9 + 1) + "T10:00:00Z", replies: []
    }, c))
  }));
}

async function readDocx(bytes) {
  const zip = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const text = async (name) => new TextDecoder().decode(await zip.get(name));
  const parse = (s) => {
    const x = new DOMParser().parseFromString(s, "application/xml");
    assert.equal(x.getElementsByTagName("parsererror").length, 0);
    return x;
  };
  const doc = parse(await text("word/document.xml"));
  const rels = {};
  Array.from(parse(await text("word/_rels/document.xml.rels")).getElementsByTagName("Relationship"))
    .forEach((r) => { rels[r.getAttribute("Id")] = r.getAttribute("Target"); });
  const types = await text("[Content_Types].xml");
  const paras = Array.from(doc.getElementsByTagNameNS(W, "body")[0].childNodes).filter((n) => n.localName === "p");
  const start = paras.findIndex((p) => p.textContent === "Comments");
  assert.ok(start >= 0, "no Comments heading");
  const section = paras.slice(start + 1).map((p) => {
    const blip = p.getElementsByTagName("a:blip")[0];
    const ind = p.getElementsByTagNameNS(W, "ind")[0];
    const indent = ind ? +ind.getAttributeNS(W, "left") : 0;
    if (blip) {
      const ext = p.getElementsByTagName("wp:extent")[0];
      const docPr = p.getElementsByTagName("wp:docPr")[0];
      return { img: rels[blip.getAttributeNS(R, "embed")], cx: +ext.getAttribute("cx"), cy: +ext.getAttribute("cy"), id: docPr.getAttribute("id"), indent };
    }
    return { text: p.textContent, italic: p.getElementsByTagNameNS(W, "i").length > 0, indent };
  });
  const docPrIds = Array.from(doc.getElementsByTagName("wp:docPr")).map((d) => d.getAttribute("id"));
  return { zip, rels, types, section, docPrIds };
}

test("the .docx embeds a comment's and a reply's pictures in order, each part once, as its own type", async () => {
  const png = pic(pngBytes(640, 480)), jpg = pic(jpegBytes(200, 100)), rowPic = pic(jpegBytes(300, 300));
  const conflictPic = pic(pngBytes(320, 240));
  setDoc([Object.assign({ imageRef: rowPic.rec }, ROW1), ROW2], [
    { body: "Before " + png.html + "Between<br>" + jpg.html + " After",
      replies: [{ id: "rp0", author: "Bob", body: "Reply text " + png.html + " reply after " + rowPic.html, createdAt: "2026-09-02T10:00:00Z" }] },
    { kind: "conflict", rowId: "r1", field: "visualImage", conflictField: "Visual image", imageValue: conflictPic.rec, body: "" },
    { rowId: "r1", body: "Look: <img class=\"comment-img\" data-blob=\"" + MISSING + "\"> there." }
  ]);
  const { zip, rels, types, section, docPrIds } = await readDocx(buildDocx(...liveWithAssets()));

  assert.deepEqual(Object.values(rels).filter((t) => t.startsWith("media/")),
    ["media/image1.jpeg", "media/image2.png", "media/image3.jpeg", "media/image4.png"]);
  for (const [name, p] of [["image1.jpeg", rowPic], ["image2.png", png], ["image3.jpeg", jpg], ["image4.png", conflictPic]]) {
    assert.deepEqual(await zip.get("word/media/" + name), pngOrJpeg(p), name + " holds its picture's bytes");
  }
  assert.ok(types.includes('<Default Extension="png" ContentType="image/png"/>'));
  assert.ok(types.includes('<Default Extension="jpeg" ContentType="image/jpeg"/>'));
  assert.equal(new Set(docPrIds).size, docPrIds.length, "duplicate drawing ids: " + docPrIds);

  const seq = section.map((p) => p.img ? "IMG:" + p.img : p.text);
  const at = (k, from) => seq.indexOf(k, from || 0);
  const order = [at("Before"), at("IMG:media/image2.png"), at("Between"), at("IMG:media/image3.jpeg"), at("After")];
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), "comment out of order: " + seq.join(" | "));
  const reply = at("Reply text");
  const rorder = [reply, at("IMG:media/image2.png", reply), at("reply after", reply), at("IMG:media/image1.jpeg", reply)];
  assert.ok(rorder.every((v, i) => v >= 0 && (i === 0 || v > rorder[i - 1])), "reply out of order: " + seq.join(" | "));
  assert.equal(section[order[1]].indent, 360);
  assert.equal(section[rorder[1]].indent, 720);

  assert.ok(at("IMG:media/image4.png") > rorder[3]);
  assert.equal(at("(empty)"), -1);

  const look = at("Look:");
  assert.ok(look > 0 && seq[look + 1] === "[image unavailable]" && seq[look + 2] === "there.", seq.join(" | "));
  assert.ok(section[look + 1].italic);
});

function pngOrJpeg(p) {
  const w = p.rec.width, h = p.rec.height;
  return p.rec.mime === "image/png" ? pngBytes(w, h) : jpegBytes(w, h);
}

test("a .docx comment picture is at most 60% of the column, keeps its aspect and is never enlarged past 96 dpi", async () => {
  const big = pic(pngBytes(3000, 2000)), small = pic(jpegBytes(40, 30)), tall = pic(pngBytes(500, 4000));
  setDoc(null, [{ body: big.html, replies: [{ id: "rp", author: "Bob", body: big.html }] }, { body: small.html }, { body: tall.html }]);
  const { section } = await readDocx(buildDocx(...liveWithAssets()));
  const imgs = section.filter((p) => p.img);
  assert.equal(imgs.length, 4);
  const [b, br, s, t] = imgs;
  assert.equal(b.cx, Math.round((10080 - 360) * 635 * 0.6));
  assert.equal(br.cx, Math.round((10080 - 720) * 635 * 0.6));
  assert.ok(Math.abs(b.cx / b.cy - 1.5) < 0.001);
  assert.equal(b.img, br.img);
  assert.equal(s.cx, 40 * 9525);
  assert.equal(s.cy, 30 * 9525);
  assert.equal(t.cy, 260 * 12700);
  assert.ok(Math.abs(t.cy / t.cx - 8) < 0.001);
  assert.equal(section.filter((p) => p.text === "(empty)").length, 0);
});

test("Markdown and CSV write \"[image]\" where a picture was, in reading order", () => {
  const a = pic(pngBytes(64, 48)), b = pic(jpegBytes(80, 60)), c = pic(pngBytes(90, 70));
  setDoc(null, [
    { body: "Before " + a.html + " after", replies: [{ id: "rp0", author: "Bob", body: b.html, createdAt: "2026-09-02T10:00:00Z" }] },
    { kind: "conflict", rowId: "r1", field: "visualImage", conflictField: "Visual image", imageValue: c.rec, body: "" },
    { rowId: "r1", body: "Missing <img class=\"comment-img\" data-blob=\"" + MISSING + "\">" }
  ]);
  for (const md of [toMarkdownDoc(exportDocumentOf(currentDocument())), toMarkdownTableDoc(exportDocumentOf(currentDocument()), { export: true }), toMarkdownTableDoc(exportDocumentOf(currentDocument()))]) {
    const tail = md.slice(md.indexOf("## Comments"));
    assert.ok(tail.includes("Before  \n[image]  \nafter"), tail);
    assert.ok(tail.includes("> ↳ **Bob** · ") && /\*\*Bob\*\* · [^\n]*: {2}\[image\]/.test(tail), tail);
    assert.ok(tail.includes("Missing  \n[image]"), tail);
    assert.ok(!tail.includes("_(empty)_"), tail);
  }
  assert.ok(toMarkdownDoc(exportDocumentOf(currentDocument())).includes("**Scene 01 · Audio** — Ann"));
  assert.ok(toMarkdownTableDoc(exportDocumentOf(currentDocument())).includes("**Row 01 · Audio** — Ann"));

  const csv = buildCsv(liveDoc());
  assert.ok(csv.includes(',"Before\n[image]\nafter"'), csv);
  assert.ok(/,↳ Bob,[^\n]*,,\[image\]/.test(csv), csv);
  assert.equal(csv.split("\r\n").filter((l) => /,\[image\]$/.test(l)).length, 2, "the reply and the conflict card");
  assert.ok(csv.includes("\r\n,Scene 01 · Audio,Open,,Ann,"), csv);

  const [one, conflict, missing] = commentEntries(exportDocumentOf(currentDocument()), { pieces: true });
  assert.equal(commentBodyText(one), "Before\n[image]\nafter");
  assert.equal(commentBodyText(one.replies[0]), "[image]");
  assert.equal(commentBodyText(conflict), "[image]");
  assert.equal(commentBodyText(missing), "Missing\n[image]");
});

test("a text-only comment reads exactly as its plain body", () => {
  setDoc(null, [{ body: "One&nbsp;<b>two</b><br>three", replies: [{ id: "rp", author: "Bob", body: "" }] }, { body: "" }]);
  const [c, empty] = commentEntries(exportDocumentOf(currentDocument()), { pieces: true });
  assert.equal(commentBodyText(c), c.body);
  assert.equal(commentBodyText(c.replies[0]), "");
  assert.equal(commentBodyText(empty), "");
  const [plain] = commentEntries(exportDocumentOf(currentDocument()));
  assert.equal(commentBodyText(plain), plain.body);
});
