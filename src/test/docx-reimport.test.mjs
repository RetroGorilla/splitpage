/* Reopening a .docx (15-docx.js docxToRows): a Splitpage export comes back
 * as its script and nothing else; any other Word document reads as before.
 *
 * buildDocx writes the script as a table in the "SplitpageTable" style and
 * then, when there are any, a "Comments" section (a Heading1, a paragraph
 * per comment line and reply, and since 2fa8b33 the comments' pictures).
 * The importer used to walk that section as prose: the heading became a
 * bold row, each comment line a narration row and a comment's picture a
 * row picture. It now stops at the export's own trailing sections — found
 * by the Heading1 coming after a SplitpageTable-styled table, not by the
 * word alone, so a user's own "Comments" heading still imports.
 *
 * The .docx is built with the app's own buildDocx (S.state set directly,
 * fake JPEG headers interned into the registry, as
 * comment-images-export.test.mjs does) or, for a foreign document, written
 * by hand with zipWrite. JPEG only: a PNG row picture would be re-encoded
 * through a canvas, which jsdom does not have. Browser suite
 * 41-export-polish drives the same through the real File menu and open
 * path, breakdown and PNG pictures included.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { intern } from "../js/02c-blobs.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { htmlToPlainText, strBytes, zipWrite } from "../js/14-export.js";
import { __init as initDocx, buildDocx, docxToRows } from "../js/15-docx.js";

initTags();
initStatus();
initDocx();

/* Just enough of a JPEG for the registry to sniff and measure. */
const jpegBytes = (w, h, salt) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt || 0, 0xFF, 0xD9]);
const pic = (bytes) => {
  const rec = intern(bytes);
  assert.ok(rec, "fake picture interned");
  return { rec, html: '<img class="comment-img" data-blob="' + rec.sha256 + '">' };
};

const asFile = (bytes, name) => new File([bytes], name || "script.docx");
const plainRows = (rows) => rows.map((r) => ({ v: htmlToPlainText(r.visualText), a: htmlToPlainText(r.audioText) }));

test("a Splitpage export reopens as exactly its script: no comment rows, no comment pictures", async () => {
  const rowPic = pic(jpegBytes(300, 200, 1));
  const cPic = pic(jpegBytes(120, 80, 2)), rPic = pic(jpegBytes(640, 480, 3));
  S.state = migrateRows({
    schema: 2, title: "Round trip",
    rows: [
      { id: "r0", visualText: "Host on camera", audioText: "Welcome <strong>back</strong>.", status: "todo", imageRef: rowPic.rec },
      { id: "r1", visualText: "", audioText: "Narration only.", status: "todo" },
      { id: "r2", visualText: "Wide shot", audioText: "", status: "todo" }
    ],
    comments: [
      { id: "c0", rowId: "r0", field: "audioText", author: "Ann", quotedText: "Welcome", assignee: "Bob",
        createdAt: "2026-09-01T10:00:00Z", body: "COMMENTLINE " + cPic.html + " AFTERPIC",
        replies: [{ id: "rp0", author: "Bob", createdAt: "2026-09-02T10:00:00Z", body: "REPLYLINE " + rPic.html }] },
      { id: "c1", rowId: "r2", field: "visualText", author: "Cy", createdAt: "2026-09-03T10:00:00Z",
        body: cPic.html, resolved: true, resolvedBy: "Ann", replies: [] }
    ]
  });
  const expected = plainRows(S.state.rows);
  const bytes = buildDocx();

  const parsed = await docxToRows(asFile(bytes));
  assert.equal(parsed.title, "Round trip");
  assert.deepEqual(plainRows(parsed.rows), expected, "the script's rows, and only those");
  const all = JSON.stringify(parsed.rows);
  for (const word of ["Comments", "COMMENTLINE", "REPLYLINE", "Ann", "Welcome”"]) {
    assert.equal(all.indexOf(word), -1, word + " leaked into a row");
  }
  /* the row's own picture comes back on its row; no comment picture does */
  assert.equal(parsed.rows[0].imageRef && parsed.rows[0].imageRef.sha256, rowPic.rec.sha256);
  assert.deepEqual(parsed.rows.slice(1).map((r) => r.imageRef), [null, null]);
});

test("an export with no comments reopens the same, and one with comments matches it", async () => {
  const rows = [
    { id: "r0", visualText: "One", audioText: "First.", status: "todo" },
    { id: "r1", visualText: "Two", audioText: "Second.", status: "todo" }
  ];
  S.state = migrateRows({ schema: 2, title: "Plain", rows, comments: [] });
  const bare = await docxToRows(asFile(buildDocx()));
  S.state = migrateRows({ schema: 2, title: "Plain", rows, comments: [
    { id: "c0", rowId: "r0", field: "audioText", author: "Ann", createdAt: "2026-09-01T10:00:00Z", body: "A note", replies: [] }
  ] });
  const withComments = await docxToRows(asFile(buildDocx()));
  assert.deepEqual(plainRows(withComments.rows), plainRows(bare.rows));
  assert.equal(withComments.rows.length, 2);
});

/* A Word document of the user's own, the smallest one docxToRows reads:
   document.xml alone, no rels. */
const W_DOC = (body) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + "</w:body></w:document>";
const para = (text, style) => "<w:p>" + (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : "") +
  '<w:r><w:t xml:space="preserve">' + text + "</w:t></w:r></w:p>";
const cell = (text) => "<w:tc>" + para(text) + "</w:tc>";
const table = (styleId, cells) => "<w:tbl><w:tblPr>" + (styleId ? '<w:tblStyle w:val="' + styleId + '"/>' : "") + "</w:tblPr>" +
  cells.map((r) => "<w:tr>" + r.map(cell).join("") + "</w:tr>").join("") + "</w:tbl>";
const foreignDocx = (body) => zipWrite([{ name: "word/document.xml", data: strBytes(W_DOC(body)) }]);

test("a user's own Word document with a Comments heading still imports it and what follows", async () => {
  const body = para("My script", "Title") +
    table("TableGrid", [["Visual", "Audio"], ["Opening shot", "Hello there."]]) +
    para("Comments", "Heading1") +
    para("We should cut this line.") +
    para("Production breakdown", "Heading1") +
    para("Two lights.");
  const parsed = await docxToRows(asFile(foreignDocx(body)));
  assert.equal(parsed.title, "My script");
  assert.deepEqual(plainRows(parsed.rows), [
    { v: "Opening shot", a: "Hello there." },
    { v: "Comments", a: "" },
    { v: "", a: "We should cut this line." },
    { v: "Production breakdown", a: "" },
    { v: "", a: "Two lights." }
  ]);
});

test("only the export's own headings, in its own style, after its own table end the script", async () => {
  const script = table("SplitpageTable", [["No.", "Visual", "Audio"], ["01", "Shot", "Line."]]);
  const read = async (tail) => plainRows((await docxToRows(asFile(foreignDocx(para("T", "Title") + script + tail)))).rows);
  /* a "Comments" that is not a Heading1, and a Heading1 that is not one of
     the export's, are the user's and stay */
  assert.deepEqual(await read(para("Comments") + para("kept")), [
    { v: "Shot", a: "Line." }, { v: "", a: "Comments" }, { v: "", a: "kept" }
  ]);
  assert.deepEqual(await read(para("Notes", "Heading1") + para("kept")), [
    { v: "Shot", a: "Line." }, { v: "Notes", a: "" }, { v: "", a: "kept" }
  ]);
  /* the export's breakdown heading ends it as the comments heading does */
  assert.deepEqual(await read(para("Production breakdown", "Heading1") + para("dropped") +
    para("Comments", "Heading1") + para("dropped too")), [{ v: "Shot", a: "Line." }]);
  /* and before the table, the same heading is the user's */
  const before = await docxToRows(asFile(foreignDocx(para("T", "Title") + para("Comments", "Heading1") + script)));
  assert.deepEqual(plainRows(before.rows), [{ v: "Comments", a: "" }, { v: "Shot", a: "Line." }]);
});
