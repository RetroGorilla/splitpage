import "./_dom.mjs";
import "./_export-services-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { buildExportDocument } from "../core/document/export-document.ts";
import { exportServices } from "../application/export/services.ts";
import { exportAssetsNow } from "../adapters/formats/export-assets.ts";
import { buildScriptPrintPage } from "../adapters/formats/script-print.ts";
import { buildDocx, buildNarrationDocx, docxToRows, buildNarrationText } from "../adapters/formats/docx.ts";
import { toMarkdownDoc, toMarkdownTableDoc } from "../adapters/formats/export-text.ts";
import { sceneFacts, scriptSectionFacts } from "../adapters/formats/export-projections.ts";
import { zipRead } from "../adapters/formats/zip.ts";
import { parseImportRows } from "../adapters/formats/import-text.js";

function fixture() {
  return buildExportDocument(migrateRows({ title: "Section outputs", rows: ["a", "b", "c", "d"].map((id, i) => ({
    id, audioText: "Spoken " + id, visualText: "Visual " + id, status: i === 2 ? "shot" : "todo", lengthSeconds: (i + 1) * 10
  })), sections: [{ id: "s1", name: "Opening & *part*", firstSceneId: "b" }, { id: "s2", name: "Ending", firstSceneId: "d" }] }),
  "2026-10-31T12:00:00Z", { production: [], commentNumbers: {}, broll: [] }, { clockMode: "24" });
}

test("captured section facts count every scene, keep the prefix unsectioned, and ignore view folds", () => {
  const doc = fixture();
  assert.deepEqual(scriptSectionFacts(doc, sceneFacts(doc)), [
    { id: "s1", name: "Opening & *part*", start: 1, end: 3, total: "0:50" },
    { id: "s2", name: "Ending", start: 3, end: 4, total: "0:40" }
  ]);
});

test("print headings span all columns, repeat in the table head, and retain shot scenes in order", () => {
  const doc = fixture();
  const html = buildScriptPrintPage({ doc, assets: exportAssetsNow(doc), services: exportServices() });
  const page = new DOMParser().parseFromString(html, "text/html");
  const tables = [...page.querySelectorAll(".script-table")];
  assert.equal(tables.length, 3);
  assert.equal(tables[0].querySelector(".script-section"), null);
  assert.deepEqual([...page.querySelectorAll(".script-section th")].map(el => [el.colSpan, el.textContent]), [
    [4, "Opening & *part*0:50"], [4, "Ending0:40"]
  ]);
  assert.equal(page.querySelectorAll("thead .script-section").length, 2);
  assert.deepEqual([...page.querySelectorAll(".scene-number")].map(el => el.textContent), ["01", "02", "03", "04"]);
  assert.match(page.querySelector(".shot-done").textContent, /Spoken c/);
  assert.equal(page.querySelector("part"), null);
});

test("Word headings span four columns and reimport never creates heading scenes", async () => {
  const doc = fixture(), bytes = buildDocx(doc, exportAssetsNow(doc));
  const parts = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(await parts.get("word/document.xml")), "application/xml");
  const spans = [...xml.getElementsByTagName("w:gridSpan")];
  assert.equal(spans.length, 2);
  for (const span of spans) {
    assert.equal(span.getAttribute("w:val"), "4");
    assert.equal(span.parentElement.parentElement.getElementsByTagName("w:keepNext").length, 1);
  }
  const imported = await docxToRows(new File([bytes], "sections.docx"));
  assert.deepEqual(imported.rows.map(row => exportServices().htmlToPlainText(row.audioText)), ["Spoken a", "Spoken b", "Spoken c", "Spoken d"]);
  assert.match(xml.documentElement.textContent, /Opening & \*part\* · 0:50/);
});

test("both readable Markdown forms keep escaped section headings; project view and narration stay separate", () => {
  const doc = fixture();
  for (const markdown of [toMarkdownDoc(doc), toMarkdownTableDoc(doc, { export: true })]) {
    assert.ok(markdown.indexOf("Spoken a") < markdown.indexOf("## Opening"));
    assert.ok(markdown.includes("## Opening & \\*part\\* · 0:50"));
    assert.ok(markdown.indexOf("Spoken c") < markdown.indexOf("## Ending · 0:40"));
    assert.ok(markdown.indexOf("## Ending · 0:40") < markdown.indexOf("Spoken d"));
  }
  assert.doesNotMatch(toMarkdownTableDoc(doc), /## Opening|## Ending/);
  assert.doesNotMatch(buildNarrationText(doc), /Opening|Ending/);
});

test("narration Word retains section cues as metadata while plain narration stays speakable", async () => {
  const doc = fixture(), bytes = buildNarrationDocx(doc);
  const parts = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(await parts.get("word/document.xml")), "application/xml");
  const paragraphs = [...xml.getElementsByTagName("w:p")];
  const headings = paragraphs.filter(p => /Opening & \*part\*|Ending/.test(p.textContent));
  assert.equal(headings.length, 2);
  assert.ok(headings.every(p => p.getElementsByTagName("w:keepNext").length === 1));
  const imported = await docxToRows(new File([bytes], "narration.docx"));
  assert.doesNotMatch(imported.rows.map(row => row.audioText + row.visualText).join(""), /Opening|Ending/);
  assert.equal(imported.rows.map(row => exportServices().htmlToPlainText(row.audioText)).join(" ").replace(/\s+/g, " "),
    "Spoken a Spoken b Spoken c Spoken d");
  assert.doesNotMatch(buildNarrationText(doc), /Opening|Ending/);
});

function markdownFixture(anchors, count = 4) {
  return buildExportDocument(migrateRows({ title: "Section round trip", rows: Array.from({ length: count }, (_, i) => ({
    id: "r" + i, visualText: "Visual " + i, audioText: "Audio " + i,
    status: i % 2 ? "shot" : "todo", lengthSeconds: i % 3 ? 30 : 3600
  })), sections: anchors.map((at, i) => ({ id: "s" + i, name: "Part " + i + " & *notes* | #cue", firstSceneId: "r" + at })) }),
  "2026-10-31T12:00:00Z", { production: [], commentNumbers: {}, broll: [] }, { clockMode: "24" });
}

function assertMarkdownScenes(doc, markdown, message) {
  const rows = parseImportRows(markdown, "twocolumn");
  assert.deepEqual(rows.map(({ visualText, audioText }) => ({ visualText, audioText })),
    doc.scenes.map(({ visualText, audioText }) => ({ visualText, audioText })), message);
  assert.ok(rows.every(row => !Object.hasOwn(row, "sections") && !Object.hasOwn(row, "firstSceneId")));
}

for (const [form, write] of [
  ["stacked", doc => toMarkdownDoc(doc)],
  ["table", doc => toMarkdownTableDoc(doc, { export: true })]
]) {
  test(form + " Markdown reimports scenes with first, middle, last and adjacent section boundaries", () => {
    for (const anchors of [[], [0], [1], [3], [1, 2], [0, 1, 2, 3]]) {
      const doc = markdownFixture(anchors);
      assertMarkdownScenes(doc, write(doc), "boundaries " + JSON.stringify(anchors));
    }
    const doc = markdownFixture([1, 3]);
    const ownText = form === "stacked" ? "Audio 0\n\n## Personal notes · 0:50\n\nMore audio\n\n## Last note · 0:50" : "Audio 0 ## Personal notes · 0:50";
    const markdown = write(doc).replace("Audio 0", ownText);
    const rows = parseImportRows(markdown, "twocolumn");
    assert.equal(rows.length, 4);
    assert.equal(rows[0].audioText, ownText);
    assert.equal(rows[1].audioText, "Audio 1");
  });

  test(form + " Markdown seeded section placements preserve every scene and its order on reimport", () => {
    let seed = 3101031;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let trial = 0; trial < 128; trial++) {
      const count = 1 + next() % 12;
      const anchors = Array.from({ length: count }, (_, i) => i).filter(() => (next() >>> 16) % 3 === 0);
      const doc = markdownFixture(anchors, count);
      assertMarkdownScenes(doc, write(doc), "seed 3101031 trial " + trial + " boundaries " + JSON.stringify(anchors));
    }
  });
}
