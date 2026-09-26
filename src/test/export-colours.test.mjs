/* Category colours in the exports (#171): the production breakdown's
 * Category column in the PDF (17-pdf.js buildPdf) and the .docx (15-docx.js
 * buildDocx), and the packing list's heading (buildPackingListPdf), drawn in
 * the light theme's --tag-* colours through TAG_PRINT_COLORS (14-export.js;
 * palette.test.mjs keeps that table equal to app.css :root).
 *
 * Read back the way the other export tests do: the .docx with the app's own
 * zipRead and a DOMParser over word/document.xml, the PDF's uncompressed
 * content streams as text. And a .docx with every category and a
 * highlighted phrase still reopening (docxToRows) as exactly its script,
 * the highlight still Word's "yellow" and still read back as a <mark>.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { TAG_CATEGORIES, __init as initTags } from "../js/07-production-tags.js";
import { breakdownRows } from "../js/08-production-panels.js";
import { TAG_PRINT_COLORS, htmlToPlainText, zipRead } from "../js/14-export.js";
import { __init as initDocx, buildDocx, docxToRows } from "../js/15-docx.js";
import { buildPackingListPdf, buildPdf } from "../js/17-pdf.js";

initTags();
initStatus();
initDocx();

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const tag = (cat, name) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;

/* one item in every category, two props, and a highlighted phrase */
function load() {
  S.state = migrateRows({
    schema: 2, title: "Colours", comments: [],
    rows: [
      { id: "r0", visualText: "The " + tag("prop", "Mug") + " at the " + tag("location", "Kitchen"),
        audioText: "Say <mark>hello</mark> to " + tag("cast", "Ann") + ".", status: "todo" },
      { id: "r1", visualText: tag("vfx", "Glow") + " and a " + tag("prop", "Kettle"),
        audioText: tag("sound", "Theme") + " over the " + tag("gear", "Tripod") + ".", status: "todo" }
    ]
  });
}

/* PDF colour operands for "RRGGBB", as 17-pdf.js writes them */
const rgb = (hex) => [0, 2, 4].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");

function streams(bytes) {
  const t = new TextDecoder("latin1").decode(bytes);
  const out = [];
  const re = /obj\n<< \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(t))) out.push(t.substr(re.lastIndex, +m[1]));
  return out;
}

async function documentXml(bytes) {
  const zip = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const xml = new TextDecoder().decode(await zip.get("word/document.xml"));
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  assert.equal(doc.getElementsByTagName("parsererror").length, 0, "document.xml does not parse");
  return doc;
}

test("breakdownRows says which category each row is", () => {
  load();
  const rows = breakdownRows();
  assert.deepEqual(rows.map((r) => [r.catId, r.categoryLabel]).sort(),
    [["cast", "Cast"], ["gear", "Gear"], ["location", "Location"], ["prop", "Prop"], ["prop", "Prop"], ["sound", "Music/SFX"], ["vfx", "VFX"]]);
});

test("the .docx breakdown draws each category's dot and label in its colour; the header and the highlight are unchanged", async () => {
  load();
  const doc = await documentXml(buildDocx());
  const tables = doc.getElementsByTagNameNS(W, "tbl");
  assert.equal(tables.length, 2, "script table and breakdown table");
  const trs = Array.from(tables[1].getElementsByTagNameNS(W, "tr"));

  /* the header row is exactly the words the importer recognises, in black */
  const head = Array.from(trs[0].getElementsByTagNameNS(W, "tc")).map((tc) => tc.textContent);
  assert.deepEqual(head, ["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "Notes"]);
  assert.equal(trs[0].getElementsByTagNameNS(W, "color").length, 0, "the header row got a colour");

  const seen = new Set();
  for (const tr of trs.slice(1)) {
    const cells = Array.from(tr.getElementsByTagNameNS(W, "tc"));
    const cat = TAG_CATEGORIES.find((c) => "● " + c.label === cells[0].textContent);
    assert.ok(cat, "category cell reads " + JSON.stringify(cells[0].textContent));
    seen.add(cat.id);
    const runs = Array.from(cells[0].getElementsByTagNameNS(W, "r"));
    assert.deepEqual(runs.map((r) => r.textContent), ["● ", cat.label]);
    for (const r of runs) {
      const color = r.getElementsByTagNameNS(W, "color")[0];
      assert.ok(color, cat.id + ": a run with no colour");
      assert.equal(color.getAttributeNS(W, "val") || color.getAttribute("w:val"), TAG_PRINT_COLORS[cat.id]);
    }
    /* the other columns stay black */
    for (const tc of cells.slice(1)) assert.equal(tc.getElementsByTagNameNS(W, "color").length, 0);
  }
  assert.deepEqual([...seen].sort(), TAG_CATEGORIES.map((c) => c.id).sort(), "every category drawn");

  /* the script's highlight is still Word's yellow, and nothing else is */
  const hl = Array.from(doc.getElementsByTagNameNS(W, "highlight"));
  assert.equal(hl.length, 1);
  assert.equal(hl[0].getAttributeNS(W, "val") || hl[0].getAttribute("w:val"), "yellow");
  assert.equal(hl[0].parentNode.parentNode.textContent, "hello");
});

test("a .docx with coloured categories reopens as exactly its script, highlight included", async () => {
  load();
  const expected = S.state.rows.map((r) => ({ v: htmlToPlainText(r.visualText), a: htmlToPlainText(r.audioText) }));
  const parsed = await docxToRows(new File([buildDocx()], "colours.docx"));
  assert.equal(parsed.title, "Colours");
  assert.deepEqual(parsed.rows.map((r) => ({ v: htmlToPlainText(r.visualText), a: htmlToPlainText(r.audioText) })), expected);
  assert.match(parsed.rows[0].audioText, /<mark>hello<\/mark>/, "the highlight no longer reads back as a mark");
  const all = JSON.stringify(parsed.rows);
  for (const word of ["●", "Production breakdown", "Music/SFX", "Category"]) {
    assert.equal(all.indexOf(word), -1, word + " leaked into a row");
  }
});

/* The breakdown by category, as the Production panel groups it: each
   category's group headed by a dot in its colour and its plural in bold,
   in the text colour — the colour is the dot's, as the panel's is. */
test("the PDF breakdown heads each category's group with a dot in its colour and its plural", () => {
  load();
  const pages = streams(buildPdf([null, null]));
  const all = pages.join("\n");
  const at = all.indexOf("(Production breakdown) Tj");
  assert.ok(at > 0, "no breakdown page");
  const breakdown = all.slice(at).split("\n");
  const seen = new Set();
  for (let i = 0; i < breakdown.length; i++) {
    const m = /^q ([\d.]+ [\d.]+ [\d.]+) rg (.*) f Q$/.exec(breakdown[i]);
    if (!m) continue;
    const cat = TAG_CATEGORIES.find((c) => rgb(TAG_PRINT_COLORS[c.id]) === m[1]);
    assert.ok(cat, "a fill in a colour no category has: " + m[1]);
    /* a closed circle: a moveto, four curves */
    assert.equal((m[2].match(/ c\b/g) || []).length, 4, "not four curves: " + m[2]);
    assert.match(m[2], /^[\d.]+ [-\d.]+ m .* c h$/, "not one closed path: " + m[2]);
    /* then the group's name, bold, in the text colour, 11pt right of the margin */
    const label = /^BT \/F2 10 Tf 1 0 0 1 ([\d.]+) [\d.]+ Tm \((.*)\) Tj ET$/.exec(breakdown[i + 1]);
    assert.ok(label, "no name after the dot: " + breakdown[i + 1]);
    assert.equal(label[2], cat.plural.replace(/[()]/g, "\\$&"));
    assert.equal(+label[1], 65);
    seen.add(cat.id);
  }
  assert.deepEqual([...seen].sort(), TAG_CATEGORIES.map((c) => c.id).sort(), "every category's group drawn");
});

/* In the script itself each tagged word is drawn as the app draws it: in
   its category's colour, with a thin rule under it in that colour. */
test("the PDF script draws each tagged word in its category's colour, underlined in it", () => {
  load();
  const pages = streams(buildPdf([null, null]));
  const script = pages[0].split("\n");
  for (const [word, id] of [["Mug", "prop"], ["Kitchen", "location"], ["Ann", "cast"], ["Glow", "vfx"], ["Kettle", "prop"], ["Theme", "sound"], ["Tripod", "gear"]]) {
    const re = new RegExp("^q " + rgb(TAG_PRINT_COLORS[id]) + " rg BT /F1 [\\d.]+ Tf 1 0 0 1 ([\\d.]+) [\\d.]+ Tm \\(" + word + "\\) Tj ET Q$");
    const drawn = script.map((op) => re.exec(op)).find(Boolean);
    assert.ok(drawn, word + " is not drawn in " + id + "'s colour");
    assert.ok(script.some((op) => op.startsWith("q " + rgb(TAG_PRINT_COLORS[id]) + " rg " + drawn[1] + " ") && / re f Q$/.test(op)), word + " has no rule under it in " + id + "'s colour");
  }
  /* and the words that are not tags stay in the page's text colour */
  assert.ok(script.some((op) => /^BT \/F1 [\d.]+ Tf .* Tm \(The\) Tj ET$/.test(op)));
});

/* Found rendering the breakdown for #171: a note is wrapped at 8.5pt but was
   drawn at 9.5pt, so each word ran into the next ("Borrowfromtheprophouse."). */
test("the PDF breakdown draws a note at the size it was wrapped at, a space between its words", () => {
  load();
  S.state.productionTags.find((t) => t.name === "Mug").notes = "Borrow from the prop house.";
  const pdf = streams(buildPdf([null, null])).join("\n");
  const all = pdf.slice(pdf.indexOf("(Production breakdown) Tj"));
  const words = [];
  for (const m of all.matchAll(/BT \/F1 ([\d.]+) Tf 1 0 0 1 ([\d.]+) ([-\d.]+) Tm \((\w+\.?)\) Tj ET/g)) {
    if (["Borrow", "from", "the", "prop", "house."].includes(m[4])) words.push({ size: +m[1], x: +m[2], y: +m[3], w: m[4] });
  }
  assert.deepEqual(words.map((w) => w.w), ["Borrow", "from", "the", "prop", "house."]);
  for (const w of words) assert.equal(w.size, 8.5, w.w + " drawn at " + w.size);
  /* Helvetica at 8.5pt: "Borrow" is 3167/1000 em and a space 278, so
     "from" starts 29.28pt after it — drawn at the old 9.5pt, "Borrow" alone
     was 30.1pt wide and ran into it */
  assert.ok(Math.abs(words[1].x - words[0].x - 29.28) < 0.05, "from at +" + (words[1].x - words[0].x).toFixed(2));
});

test("the packing list's heading names its category in that category's colour", () => {
  load();
  for (const id of ["gear", "prop"]) {
    const cat = TAG_CATEGORIES.find((c) => c.id === id);
    const page = streams(buildPackingListPdf(id))[0].split("\n");
    const i = page.indexOf("q " + rgb(TAG_PRINT_COLORS[id]) + " rg");
    assert.ok(i > 0, id + ": no colour set");
    assert.match(page[i - 1], /\(Colours {2}— {2}\) Tj ET$/, id + ": the title before it");
    assert.match(page[i + 1], new RegExp("^BT /F2 15 Tf .* Tm \\(" + cat.plural.replace(/[&]/g, "\\$&") + "\\) Tj ET$"));
    assert.equal(page[i + 2], "Q");
    assert.match(page[i + 3], /\( packing list\) Tj ET$/);
    /* the items are not coloured */
    assert.equal(page.filter((op) => / rg$/.test(op)).length, 1, id + ": more than the heading coloured");
  }
});
