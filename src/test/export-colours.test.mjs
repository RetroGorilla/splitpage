import { TAG_CATEGORIES } from "../core/production/looks.ts";
import "./_dom.mjs";
import "./_export-services-started.mjs";
import { liveWithAssets } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { mountProductionTagsFeature as initTags } from "../bootstrap/wiring/production-tags.ts";
import { breakdownRows } from "../adapters/formats/export-projections.ts";
import { zipRead } from "../adapters/formats/zip.ts";
import { TAG_PRINT_COLORS } from "../adapters/formats/print-colors.ts";
import { htmlToPlainText } from "../bootstrap/plain-text.ts";
import { buildDocx, docxToRows } from "../adapters/formats/docx.ts";
import { exportDocumentOf } from "../bootstrap/wiring/export-capture.ts";
import { loadTestDocument } from "./_document.mjs";

initTags();

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const tag = (cat, name) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;

function load() {
  loadTestDocument(migrateRows({
    schema: 2, title: "Colours", comments: [],
    rows: [
      { id: "r0", visualText: "The " + tag("prop", "Mug") + " at the " + tag("location", "Kitchen"),
        audioText: "Say <mark>hello</mark> to " + tag("cast", "Ann") + ".", status: "todo" },
      { id: "r1", visualText: tag("vfx", "Glow") + " and a " + tag("prop", "Kettle"),
        audioText: tag("sound", "Theme") + " over the " + tag("gear", "Tripod") + ".", status: "todo" }
    ]
  }));
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
  const rows = breakdownRows(exportDocumentOf(currentDocument()));
  assert.deepEqual(rows.map((r) => [r.catId, r.categoryLabel]).sort(),
    [["cast", "Cast"], ["gear", "Gear"], ["location", "Location"], ["prop", "Prop"], ["prop", "Prop"], ["sound", "Music/SFX"], ["vfx", "VFX"]]);
});

test("the .docx breakdown heads each category with its dot and name in its colour; the highlight is unchanged", async () => {
  load();
  const doc = await documentXml(buildDocx(...liveWithAssets()));
  const tables = doc.getElementsByTagNameNS(W, "tbl");
  assert.equal(tables.length, 2, "script table and breakdown table");
  const trs = Array.from(tables[1].getElementsByTagNameNS(W, "tr"));
  const val = (el) => el.getAttributeNS(W, "val") || el.getAttribute("w:val");

  const head = Array.from(trs[0].getElementsByTagNameNS(W, "tc")).map((tc) => tc.textContent);
  assert.deepEqual(head, ["Item", "Status", "Scenes", "Assigned to", "Notes"]);

  const seen = new Set();
  let current = null;
  for (const tr of trs.slice(1)) {
    const cells = Array.from(tr.getElementsByTagNameNS(W, "tc"));
    if (tr.getElementsByTagNameNS(W, "gridSpan").length) {
      const runs = Array.from(cells[0].getElementsByTagNameNS(W, "r"));
      current = TAG_CATEGORIES.find((c) => runs[1].textContent === c.plural);
      assert.ok(current, "a group head reads " + JSON.stringify(cells[0].textContent));
      seen.add(current.id);
      assert.deepEqual(runs.map((r) => r.textContent.trim()),
        ["●", current.plural, String(breakdownRows(exportDocumentOf(currentDocument())).filter((r) => r.catId === current.id).length)]);
      for (const r of runs.slice(0, 2)) assert.equal(val(r.getElementsByTagNameNS(W, "color")[0]), TAG_PRINT_COLORS[current.id]);
      continue;
    }
    assert.ok(current, "an item before any group head");
    assert.ok(breakdownRows(exportDocumentOf(currentDocument())).some((r) => r.catId === current.id && r.name === cells[0].textContent), cells[0].textContent + " under " + current.id);
    for (const c of Array.from(tr.getElementsByTagNameNS(W, "color"))) {
      assert.ok(!Object.values(TAG_PRINT_COLORS).includes(val(c)), "an item cell in a category colour");
    }
  }
  assert.deepEqual([...seen].sort(), TAG_CATEGORIES.map((c) => c.id).sort(), "every category drawn");

  const hl = Array.from(doc.getElementsByTagNameNS(W, "highlight"));
  assert.equal(hl.length, 1);
  assert.equal(val(hl[0]), "yellow");
  assert.equal(hl[0].parentNode.parentNode.textContent, "hello");
});

test("the .docx script draws each tag in its category's colour and reopens without it", async () => {
  load();
  const doc = await documentXml(buildDocx(...liveWithAssets()));
  const runs = Array.from(doc.getElementsByTagNameNS(W, "tbl")[0].getElementsByTagNameNS(W, "r"));
  const tagged = runs.filter((r) => {
    const s = r.getElementsByTagNameNS(W, "rStyle")[0];
    return s && (s.getAttributeNS(W, "val") || s.getAttribute("w:val")) === "SplitpageTag";
  });
  const byName = Object.fromEntries(tagged.map((r) => [r.textContent, r]));
  for (const [name, cat] of [["Mug", "prop"], ["Kitchen", "location"], ["Ann", "cast"], ["Glow", "vfx"], ["Kettle", "prop"], ["Theme", "sound"], ["Tripod", "gear"]]) {
    const r = byName[name];
    assert.ok(r, name + " is not drawn as a tag");
    const color = r.getElementsByTagNameNS(W, "color")[0];
    const u = r.getElementsByTagNameNS(W, "u")[0];
    assert.equal(color.getAttributeNS(W, "val") || color.getAttribute("w:val"), TAG_PRINT_COLORS[cat], name);
    assert.equal(u.getAttributeNS(W, "color") || u.getAttribute("w:color"), TAG_PRINT_COLORS[cat], name);
  }
});

test("a .docx with coloured categories reopens as exactly its script, highlight included", async () => {
  load();
  const expected = currentDocument().rows.map((r) => ({ v: htmlToPlainText(r.visualText), a: htmlToPlainText(r.audioText) }));
  const parsed = await docxToRows(new File([buildDocx(...liveWithAssets())], "colours.docx"));
  assert.equal(parsed.title, "Colours");
  assert.deepEqual(parsed.rows.map((r) => ({ v: htmlToPlainText(r.visualText), a: htmlToPlainText(r.audioText) })), expected);
  assert.match(parsed.rows[0].audioText, /<mark>hello<\/mark>/, "the highlight no longer reads back as a mark");
  const all = JSON.stringify(parsed.rows);
  for (const word of ["●", "Production breakdown", "Music & SFX", "Item", "<u>"]) {
    assert.equal(all.indexOf(word), -1, word + " leaked into a row");
  }
});
