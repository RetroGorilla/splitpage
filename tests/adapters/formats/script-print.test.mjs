import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { TextEncoder } from "node:util";
import { JSDOM } from "jsdom";
import { buildScriptPrintPage, scriptPrintSections } from "../../../src/adapters/formats/script-print.ts";
import { buildPrintPage, printPicture } from "../../../src/adapters/formats/print-page.ts";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import { exportFacts, exportSummaryParts } from "../../../src/adapters/formats/export-kit.ts";
import { beatFacts } from "../../../src/adapters/formats/export-projections.ts";
import { scriptFixture, PNG } from "./fixtures/script-print-fixture.mjs";

function page(input) { return new JSDOM(buildScriptPrintPage(input)).window.document; }

test("script print preserves captured facts, scene metadata, rich text and annotations", () => {
  const { input } = scriptFixture();
  const dom = page(input);
  const facts = exportFacts(input.doc, input.services);
  assert.equal(dom.querySelector("h1").textContent, facts.title);
  assert.equal(dom.querySelector(".print-meta").textContent, exportSummaryParts(facts).concat(facts.date).join(" · "));
  const beat = beatFacts(input.doc, input.services)[0];
  assert.equal(dom.querySelector(".scene-number").textContent, beat.number);
  assert.deepEqual([...dom.querySelectorAll(".scene-meta")].map((el) => el.textContent), [beat.start, beat.status.label]);
  assert.equal(dom.querySelector(".read-set").textContent, beat.read);
  for (const [selector, text] of [["strong", "Bold"], ["em", "italic"], ["u", "underline"], ["s", "strike"], ["mark", "highlight"],
    [".tag", "Camera"], [".broll", "B-roll"], [".direction", "whisper"], [".cue", "MUSIC"]]) {
    assert.ok([...dom.querySelectorAll(selector)].some((el) => el.textContent.includes(text)), selector);
  }
  assert.equal(dom.querySelector(".tag").style.color, "rgb(118, 74, 162)");
  assert.equal(dom.querySelector(".comment-marker").textContent, "1");
  assert.match(dom.querySelector(".script-table").textContent, /中文 日本語 العربية हिन्दी 😀/);
  assert.equal(dom.querySelector(".rundown,[aria-label='Scene rundown']"), null);
  assert.match(dom.body.textContent, /Grey rows: shot scenes/);
  assert.deepEqual([...dom.querySelectorAll("td p")].map((el) => el.textContent), [
    "YouTube https://www.youtube.com/watch?v=aqz-KE-bpKQ", "Local clip (video file)"
  ]);
});

test("shot scenes have grey rows and retain their written status without a scene strip", () => {
  const { source, input } = scriptFixture("long");
  const doc = buildExportDocument(source, input.doc.capturedAt, { production: [], commentNumbers: input.doc.commentNumbers, broll: [] });
  const dom = page({ ...input, doc });
  const rows = [...dom.querySelectorAll(".script-table tbody tr")];
  assert.equal(rows.length, 18);
  assert.equal(rows[0].classList.contains("shot-done"), false);
  for (const row of rows.slice(1)) {
    assert.equal(row.classList.contains("shot-done"), true);
    assert.match(row.querySelector("td").textContent, /Shot/);
  }
  assert.equal(dom.querySelector(".rundown,[aria-label='Scene rundown']"), null);
});

test("comments retain anchors, locations, quotes, authors, assignments, resolution, replies and pictures in order", () => {
  const dom = page(scriptFixture().input);
  const comments = dom.querySelector("#comments");
  assert.match(comments.textContent, /2 open · 1 resolved/);
  for (const text of ["Scene 01 · Audio", "Document title", "Deleted scene", "Ann <script>", "Captured words", "Assigned to Jo", "Resolved by Sam", "Bob", "End reply"]) {
    assert.ok(comments.textContent.includes(text), text);
  }
  const thread = [...comments.querySelectorAll(".comment")].find((el) => el.textContent.includes("Before"));
  assert.deepEqual([...thread.children].filter((el) => el.matches("p.print-text,img")).map((el) => el.tagName === "IMG" ? "image" : el.textContent), ["Before", "image", "After"]);
  assert.match(thread.querySelector(".reply").textContent, /Reply\[image unavailable\]End reply/);
});

test("pictures come only from held raster bytes, including galleries and legacy data URLs", () => {
  const { source, input } = scriptFixture();
  const dom = page(input);
  assert.equal(dom.querySelectorAll("img").length, 3);
  assert.equal(dom.querySelectorAll(".image-unavailable").length, 2);
  for (const image of dom.querySelectorAll("img")) assert.equal(image.src, "data:image/png;base64," + Buffer.from(PNG).toString("base64"));
  source.rows[0].imageRef = null;
  source.rows[0].visualImage = "data:image/png;base64," + Buffer.from(PNG).toString("base64");
  const doc = buildExportDocument(source, input.doc.capturedAt, { production: [], commentNumbers: {}, broll: [] });
  assert.ok(page({ ...input, doc }).querySelector("td img"));
  assert.match(printPicture({ bytes: new TextEncoder().encode('<svg onload="alert(1)"></svg>'), mime: "image/png" }, "bad"), /unavailable/);
  assert.match(printPicture(null, "missing"), /unavailable/);
});

test("generated print HTML escapes content, rejects active URLs and forbids remote resources", () => {
  const { input } = scriptFixture();
  const html = buildScriptPrintPage(input);
  const dom = new JSDOM(html).window.document;
  assert.equal(dom.querySelectorAll("script,iframe,object,embed,link,base,[onload],[onclick]").length, 0);
  assert.equal(dom.querySelectorAll("a").length, 2);
  assert.deepEqual([...dom.querySelectorAll("a")].map((a) => a.href), [
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "https://example.com/reference"
  ]);
  assert.match(dom.querySelector('meta[http-equiv="Content-Security-Policy"]').content, /default-src 'none'; img-src data:/);
  assert.equal(dom.title, input.doc.title);
  const hostile = buildPrintPage('</style><script>alert(1)</script>"\\', [{ id: 'x" onload="bad', title: '<img src=x>', html: "<p>Trusted section</p>" }]);
  const hostileDom = new JSDOM(hostile).window.document;
  assert.equal(hostileDom.querySelectorAll("script,[onload]").length, 0);
  assert.equal(hostileDom.querySelector("section").getAttribute("aria-label"), "<img src=x>");
});

test("rendering a capture after edits keeps captured words, facts, comments and assets", () => {
  const { source, input } = scriptFixture();
  const before = buildScriptPrintPage(input);
  source.title = "Changed title";
  source.rows[0].audioText = "Changed words";
  source.rows[0].status = "shot";
  source.rows[0].imageRef = null;
  source.comments[0].body = "Changed comment";
  assert.equal(buildScriptPrintPage(input), before);
  const changed = buildExportDocument(source, input.doc.capturedAt, { production: [], commentNumbers: {}, broll: [] });
  assert.notEqual(buildScriptPrintPage({ ...input, doc: changed }), before);
  const later = buildExportDocument(input.doc.document, "2026-10-30T23:59:00Z", { production: [], commentNumbers: input.doc.commentNumbers, broll: [] }, { clockMode: "24" });
  assert.equal(buildScriptPrintPage({ ...input, doc: later }), before);
});

test("empty and long scripts preserve all content, with sections composable through the shared shell", () => {
  const empty = page(scriptFixture("empty").input);
  assert.match(empty.body.textContent, /No scenes yet/);
  assert.equal(empty.querySelectorAll("table,#comments,.rundown").length, 0);
  const { input } = scriptFixture("long");
  const scenes = scriptPrintSections(input);
  const html = buildPrintPage(input.doc.title, [scenes[0], { id: "packing", title: "Packing list", html: "<h2>Packing list fixture</h2>" }, ...scenes.slice(1)]);
  const dom = new JSDOM(html).window.document;
  assert.equal(dom.querySelectorAll("tbody tr").length, 18);
  assert.match(dom.body.textContent, /Visual line 179/);
  assert.match(dom.body.textContent, /Audio line 159/);
  assert.deepEqual([...dom.querySelectorAll("section")].map((el) => el.id), ["script", "packing", "comments"]);
});
