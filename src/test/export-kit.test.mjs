import "./_dom.mjs";
import "./_preferences-started.mjs";
import "./_export-services-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { __init as initSceneStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { __init as initTags } from "../js/07-production-tags.js";
import {
  breakdownGroups,
  brollSummaryText,
  exportBrollScenes,
  exportComments,
  exportFacts,
  exportSummaryParts
} from "../adapters/formats/export-kit.ts";
import {
  commentNumbers,
  exportDocumentOf
} from "../js/14b-export-kit.js";
import { exportRuns } from "../adapters/formats/export-kit.ts";
import { sceneFacts } from "../adapters/formats/export-projections.ts";
import { assemblePdf, pdfLampOp, pdfTextWidth, pdfWrapRuns } from "../adapters/formats/pdf.ts";
import { LONG_DEMO } from "../js/_starters.js";
import { loadTestDocument } from "./_document.mjs";

initSceneStatus();
initTags();

const copy = (o) => JSON.parse(JSON.stringify(o));
const demo = () => { loadTestDocument(migrateRows(copy(LONG_DEMO.state))); };

test("the document's facts: scenes, running time, target, shot count", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 26, 12) });
  demo();
  const f = exportFacts(exportDocumentOf(currentDocument()));
  assert.equal(f.title, LONG_DEMO.state.title);
  assert.equal(f.scenes, 30);
  assert.equal(f.runtime, "9:44");
  assert.deepEqual(f.target, { seconds: 540, text: "9:00", delta: "0:44", over: true });
  assert.equal(f.status.shot + f.status.ready + f.status.todo, 30);
  assert.equal(f.status.shot, 13);
  assert.ok(f.words > 1000);
  assert.match(f.date, /2026/);
  assert.deepEqual(exportSummaryParts(f), ["30 scenes", "9:44 running time", "Target 9:00 · 0:44 over", "13 of 30 shot"]);
});

test("a script with no target and one scene says so in the singular", () => {
  loadTestDocument(migrateRows({ schema: 2, title: "One", comments: [],
    rows: [{ id: "r0", visualText: "", audioText: "Hello there, and welcome to a line long enough to take a few seconds.", status: "todo" }] }));
  const parts = exportSummaryParts(exportFacts(exportDocumentOf(currentDocument())));
  assert.equal(parts[0], "1 scene");
  assert.equal(parts.some((p) => /Target/.test(p)), false);
  assert.equal(parts[2], "0 of 1 shot");
  currentDocument().targetSeconds = 1;
  assert.match(exportSummaryParts(exportFacts(exportDocumentOf(currentDocument())))[2], / over$/);
  currentDocument().targetSeconds = 3600;
  assert.match(exportSummaryParts(exportFacts(exportDocumentOf(currentDocument())))[2], / under$/);
});

test("each scene's gutter: number, start timecode, read time, set by hand or not, status", () => {
  demo();
  const scenes = sceneFacts(exportDocumentOf(currentDocument()));
  assert.equal(scenes.length, 30);
  assert.equal(scenes[0].number, "01");
  assert.equal(scenes[0].start, "00:00");
  assert.equal(scenes[1].start, "00:10");
  assert.equal(scenes[2].start, "00:16");
  assert.equal(scenes[0].read, "0:10");
  for (let i = 1; i < scenes.length; i++) assert.ok(scenes[i].startSeconds >= scenes[i - 1].startSeconds);
  assert.equal(scenes.filter((s) => s.readSet).length, 2);
  assert.equal(scenes[1].readSet, true);
  assert.deepEqual(scenes[0].status, { id: "shot", label: "Shot" });
  assert.ok(scenes.some((s) => s.status.id === "ready") && scenes.some((s) => s.status.id === "todo"));
});

test("the open threads are numbered down the script, a resolved one not at all", () => {
  demo();
  const nums = commentNumbers(exportDocumentOf(currentDocument()));
  const open = currentDocument().comments.filter((c) => !c.resolved);
  const resolved = currentDocument().comments.filter((c) => c.resolved);
  assert.equal(Object.keys(nums).length, open.length);
  assert.deepEqual(Object.values(nums).sort(), open.map((_, i) => i + 1));
  for (const c of resolved) assert.equal(nums[c.id], undefined);
  const list = exportComments(exportDocumentOf(currentDocument()));
  assert.equal(list.length, currentDocument().comments.length);
  const numbered = list.filter((c) => c.number);
  assert.deepEqual(numbered.map((c) => c.number), [1, 2, 3]);
  assert.equal(list[0].where, "Scene 03 · Audio");
  assert.equal(list.find((c) => c.resolved).number, null);
});

test("nested and overlapping spans count the way the script's counter does", () => {
  const span = (id, inner) => '<span class="cmt-anchor" data-cmt="' + id + '">' + inner + "</span>";
  loadTestDocument(migrateRows({
    schema: 2, title: "t",
    rows: [
      { id: "r0", visualText: "", audioText: span("a", "one " + span("b", "two")) + " three " + span("c", "four"), status: "todo" },
      { id: "r1", visualText: span("d", "look"), audioText: span("e", "say"), status: "todo" }
    ],
    comments: ["a", "b", "c", "d", "e"].map((id) => ({
      id, rowId: id === "d" || id === "e" ? "r1" : "r0", field: id === "d" ? "visualText" : "audioText",
      author: "Ann", body: id, resolved: id === "c"
    }))
  }));
  assert.deepEqual({ ...commentNumbers(exportDocumentOf(currentDocument())) }, { b: 1, a: 2, d: 3, e: 4 });
  const runs = exportRuns(currentDocument().rows[0].audioText, exportDocumentOf(currentDocument()).commentNumbers);
  const marked = runs.filter((r) => r.markers);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].text, "two");
  assert.deepEqual(marked[0].markers, [1, 2]);
});

test("a cell's runs carry their tag and its colour, the b-roll key, and the markers", () => {
  demo();
  const nums = commentNumbers(exportDocumentOf(currentDocument()));
  const v1 = exportRuns(currentDocument().rows[0].visualText, nums);
  const tagged = v1.filter((r) => r.tag);
  assert.ok(tagged.length >= 3);
  const pentax = tagged.find((r) => r.tag.name === "Pentax K1000");
  assert.deepEqual(pentax.tag, { cat: "prop", name: "Pentax K1000", color: "764AA2" });
  assert.equal(pentax.text, "Pentax K1000");
  const v4 = exportRuns(currentDocument().rows[3].visualText, nums);
  const key = v4.find((r) => r.broll);
  assert.ok(key, "scene 04 has a b-roll key");
  assert.match(key.text, /^B-roll/);
  const a3 = exportRuns(currentDocument().rows[2].audioText, nums);
  const m = a3.filter((r) => r.markers);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].markers, [1]);
  assert.match(m[0].text, /don't\.$/);
  assert.ok(a3.filter((r) => !r.cmt).every((r) => !("markers" in r) && !("tag" in r)));
});

test("the breakdown by category, in the panel's order and words", () => {
  demo();
  const groups = breakdownGroups(exportDocumentOf(currentDocument()));
  assert.deepEqual(groups.map((g) => g.catId), ["prop", "location", "cast", "vfx", "sound", "gear"]);
  assert.equal(groups[0].label, "Props & set dressing");
  assert.equal(groups[0].color, "764AA2");
  assert.ok(groups.every((g) => g.items.every((r) => r.catId === g.catId)));
});

test("the b-roll by scene, with each scene's start and count", () => {
  demo();
  const groups = exportBrollScenes(exportDocumentOf(currentDocument()));
  const all = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(all, 9);
  assert.equal(groups[0].label, "Scene 04");
  assert.equal(groups[0].start, "01:03");
  assert.equal(groups[0].done, 1);
  assert.equal(brollSummaryText(groups), "3 of 9 shot · 1 flagged");
  const s = currentDocument().brollShots.length;
  exportBrollScenes(exportDocumentOf(currentDocument()));
  assert.equal(currentDocument().brollShots.length, s, "reading the list adds nothing to it");
});

test("the PDF wrap keeps a run's annotations and makes room for its markers", () => {
  const runs = [
    { text: "Some words then ", b: false },
    { text: "a tagged thing", tag: { cat: "prop", name: "a tagged thing", color: "764AA2" }, cmt: ["x"], markers: [7] },
    { text: " after.", b: false }
  ];
  const lines = pdfWrapRuns(runs, 1000, 10, { markerWidth: () => 12 });
  assert.equal(lines.length, 1);
  const segs = lines[0];
  assert.ok(segs.filter((s) => s.tag).length >= 1);
  const last = segs.filter((s) => s.markers);
  assert.equal(last.length, 1);
  assert.equal(last[0].text, "thing");
  assert.equal(last[0].markerWidth, 12);
  const w = pdfTextWidth("Some words then a tagged thing", false, 10);
  const tight = pdfWrapRuns(runs, w + 2, 10, { markerWidth: () => 12 });
  assert.equal(tight[0][tight[0].length - 1].text, "tagged");
  assert.equal(tight[1][0].text, "thing");
  assert.deepEqual(tight[1][0].markers, [7]);
});

test("assemblePdf: a title the viewer shows, links, bookmarks, every stream still plain text", () => {
  const bytes = assemblePdf({
    size: [612, 792],
    pages: [
      { ops: ["BT /F1 10 Tf 1 0 0 1 54.00 700.00 Tm (Hello) Tj ET", pdfLampOp("check", 60, 60, 4, "171613")],
        links: [{ x: 54, y: 690, w: 40, h: 12, uri: "https://example.com/a?b=(c)" }] },
      { ops: ["BT /F2 10 Tf 1 0 0 1 54.00 700.00 Tm (Two) Tj ET"] }
    ],
    info: { title: "Café — the script" },
    outline: [{ title: "Script", page: 0, y: 792 }, { title: "Comments", page: 1 }]
  });
  const t = new TextDecoder("latin1").decode(bytes);
  assert.match(t, /^%PDF-1\.4/);
  assert.match(t, /\/DisplayDocTitle true/);
  assert.match(t, /\/Title <FEFF00430061006600E9/);
  assert.match(t, /\/Creator \(Splitpage\)/);
  assert.match(t, /\/CreationDate \(D:\d{8}\)/);
  assert.match(t, /\/Subtype \/Link \/Rect \[54\.00 690\.00 94\.00 702\.00\]/);
  assert.match(t, /\/URI \(https:\/\/example\.com\/a\?b=\\\(c\\\)\)/);
  assert.match(t, /\/Type \/Outlines/);
  assert.match(t, /\/Title \(Comments\)/);
  assert.match(t, /\/Info 7 0 R/);
  const streams = [...t.matchAll(/obj\n<< \/Length (\d+) >>\nstream\n/g)];
  assert.equal(streams.length, 2);
  const xref = t.slice(t.lastIndexOf("xref\n"));
  const offsets = xref.split("\n").slice(3).filter((l) => / 00000 n $/.test(l)).map((l) => +l.slice(0, 10));
  offsets.forEach((off, i) => assert.equal(t.slice(off, off + String(i + 1).length + 6), (i + 1) + " 0 obj"));
});
