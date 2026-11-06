import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mockClock } from "./_m4-matrix.mjs";
import { jsonCopy } from "./golden-helpers.mjs";

await bootApp();
after(closeApp);

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { confirmSavedNow } = await import("../bootstrap/wiring/save-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { htmlToPlainScript, toMarkdownDoc, toMarkdownTableDoc } = await import("../adapters/formats/export-text.ts");
const { buildBreakdownCsv, buildCsv } = await import("../adapters/formats/csv.ts");
const { buildDocx, buildNarrationText } = await import("../adapters/formats/docx.ts");
const { captureExportDocument } = await import("../bootstrap/wiring/export-capture.ts");
const { exportFacts } = await import("../adapters/formats/export-kit.ts");
const { buildMarkdownProject, buildSplitpageFile, parseMarkdownProject, applyMarkdownProject } = await import("../adapters/formats/project-file.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { standaloneHtmlFor } = await import("../adapters/page/standalone-html.ts");
const { buildScriptXlsx, buildBreakdownXlsx, buildBrollXlsx } = await import("../adapters/formats/xlsx.ts");
const { buildScriptPrintPage } = await import("../adapters/formats/script-print.ts");
const { buildScriptWithListsPrintPage, buildPackingListPrintPage, buildShotListPrintPage } = await import("../adapters/formats/list-print.ts");
const { exportServices } = await import("../application/export/services.ts");
const { videoCardHtml } = await import("../bootstrap/richtext.ts");

const CAPTURED_AT = Date.UTC(2026, 10, 6, 12, 0);
const tag = (cat, name, text) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${text === undefined ? name : text}</span>`;
const chip = (name) => `<span class="who-anchor" data-who="${name}" contenteditable="false">@${name}</span>`;

function script(withChips) {
  const at = (name, sep) => (withChips ? chip(name) + sep : "");
  const end = (name) => (withChips ? " " + chip(name) : "");
  return {
    schema: 5, title: "Name chips", docId: "d" + "7".repeat(32), rev: 1, targetSeconds: 30, wordsPerMinute: 150,
    people: [{ id: "p1", name: "Sam" }, { id: "p2", name: "Ann" }],
    productionTags: [
      { id: "t1", cat: "prop", name: "Lamp", owner: "p1", notes: "", status: "needed" },
      { id: "t2", cat: "location", name: "Kitchen", owner: "p2", notes: "", status: "have" }
    ],
    brollShots: [],
    rows: [
      { id: "r1", status: "todo", visualText: at("Sam", " ") + "Wide on the " + tag("location", "Kitchen") + end("Ann") + ".<br>Then the " + tag("prop", "Lamp") + end("Sam"),
        audioText: "Welcome" + end("Ann") + ", everyone. <b>Bold" + end("Sam") + "</b> words." },
      { id: "r2", status: "ready", visualText: "Close on hands", audioText: at("Sam", " ") + "Two more words." }
    ],
    comments: []
  };
}

function load(raw) {
  loadTestDocument(migrateRows(jsonCopy(raw)));
  undoOwner().flush();
  confirmSavedNow();
  return captureExportDocument();
}

function outputs(doc) {
  const { title, ...facts } = exportFacts(doc);
  const input = { doc, services: exportServices(), assets: { picture: () => null } };
  return {
    standalone: standaloneHtmlFor(doc),
    markdown: toMarkdownDoc(doc),
    table: toMarkdownTableDoc(doc, { export: true }),
    plain: htmlToPlainScript(doc),
    csv: buildCsv(doc),
    breakdown: buildBreakdownCsv(doc),
    narration: buildNarrationText(doc),
    docx: Buffer.from(buildDocx(doc)).toString("base64"),
    scriptXlsx: Buffer.from(buildScriptXlsx(doc)).toString("base64"),
    breakdownXlsx: Buffer.from(buildBreakdownXlsx(doc)).toString("base64"),
    brollXlsx: Buffer.from(buildBrollXlsx(doc)).toString("base64"),
    scriptPrint: buildScriptPrintPage(input),
    scriptListsPrint: buildScriptWithListsPrintPage(input),
    packingPrint: buildPackingListPrintPage(input, "prop"),
    shotsPrint: buildShotListPrintPage(input),
    facts: { title, ...facts }
  };
}

test("every export of a script with name chips matches the same script without them", (t) => {
  mockClock(t, CAPTURED_AT);
  const plain = outputs(load(script(false)));
  const chipped = outputs(load(script(true)));
  assert.match(currentDocument().rows[0].visualText, /who-anchor/, "the chips are in the loaded document");
  for (const key of Object.keys(plain)) assert.deepEqual(chipped[key], plain[key], key);
  assert.doesNotMatch(JSON.stringify(chipped), /@Sam|@Ann/);
});

test("standalone HTML removes chips from both columns and preserves video media comments", () => {
  const video = videoCardHtml("https://www.youtube.com/watch?v=abcdefghijk");
  const raw = script(true);
  raw.rows[0].visualText += video;
  const doc = load(raw);
  const html = standaloneHtmlFor(doc);
  const state = JSON.parse(html.match(/<script id="state-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.doesNotMatch(JSON.stringify(state.rows), /who-anchor|@Sam|@Ann/);
  assert.match(JSON.stringify(state.comments), /video-embed-card/);
  assert.match(JSON.stringify(state.comments), /abcdefghijk/);
  assert.deepEqual(state.comments, doc.comments);
  assert.match(doc.beats[0].visualText, /who-anchor/);
});

test("the .splitpage and .md project files keep the chips and read them back unchanged", async () => {
  const doc = load(script(true));
  const rows = jsonCopy(currentDocument().rows.map((r) => [r.visualText, r.audioText]));
  assert.match(buildSplitpageFile(doc), /who-anchor/);
  const proj = parseMarkdownProject(buildMarkdownProject(doc));
  assert.ok(proj);
  const back = await applyMarkdownProject(proj);
  assert.deepEqual(back.rows.map((r) => [r.visualText, r.audioText]), rows);
});
