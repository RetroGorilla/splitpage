import "./_dom.mjs";
import { liveDoc } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { escapeHtml, migrateRows } from "../js/02-state.js";
import { withPageHead } from "../js/02b-doc-id.js";
import { cellOf, toPlainText } from "../js/04c-doc-model.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { exportMetaLine } from "../js/14d-export-text.js";
import { buildBreakdownCsv, buildBrollCsv, buildCsv, csvToRows } from "../js/16-csv.js";
import { LONG_DEMO } from "../js/_starters.js";
import { exportDocumentOf, exportFacts } from "../js/14b-export-kit.js";

initTags();
initStatus();

const demo = () => { S.state = migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state))); return S.state; };

function sheet(text) {
  assert.equal(text.charCodeAt(0), 0xFEFF, "a BOM, so Excel reads UTF-8");
  const src = text.slice(1);
  assert.ok(!/[^\r]\n(?=[^"]*$)/.test(src.split('"').filter((_, i) => i % 2 === 0).join("")), "CRLF between rows");
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') { q = true; continue; }
    if (c === ",") { row.push(f); f = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; continue; }
    f += c;
  }
  row.push(f); rows.push(row);
  return rows;
}

const HEAD = ["Scene", "Start", "Status", "Read", "Read set by hand", "Visual", "Audio", "Tags", "B-roll", "Open comments"];

test("the script's sheet: a row per scene with its start, status, read time, tags, b-roll and open threads", () => {
  const s = demo();
  const rows = sheet(buildCsv(liveDoc()));
  assert.deepEqual(rows[0], HEAD);
  const scene = (n) => rows[n];
  assert.deepEqual(scene(1).slice(0, 5), ["01", "00:00", "Shot", "0:10", ""]);
  assert.equal(scene(1)[5], toPlainText(cellOf(s.rows[0].visualText)));
  assert.equal(scene(1)[6], toPlainText(cellOf(s.rows[0].audioText)));
  assert.equal(scene(1)[7], "Prop: Pentax K1000; Location: workbench; Music/SFX: shutter click");
  assert.deepEqual(scene(2).slice(0, 5), ["02", "00:10", "Shot", "0:06", "yes"]);
  assert.deepEqual(scene(25).slice(0, 5), ["25", "08:14", "To do", "0:12", "yes"]);
  assert.equal(rows.slice(1, 31).filter((r) => r[4] === "yes").length, 2);
  assert.equal(scene(5)[7], "Prop: toothpick, light seal kit, naphtha; Gear: overhead rig");
  assert.equal(scene(21)[7], "", "nothing tagged in scene 21");
  assert.equal(scene(4)[8], "fingertip pushing on the sticky old foam (shot)");
  assert.equal(scene(6)[8], "the toothpick lifting a long strand of goo (shot, flagged)");
  assert.equal(scene(22)[8], "feet on the gravel path, low angle (to shoot)");
  assert.deepEqual([3, 9, 18, 24].map((n) => scene(n)[9]), ["1", "", "2", "3"]);
  assert.deepEqual(scene(10).slice(0, 4), ["10", "02:48", "Ready", "0:38"]);
  assert.deepEqual(scene(13).slice(0, 4), ["13", "03:43", "To do", "0:45"]);
});

test("the sheet's totals are labelled, the target beside them, and the comments carry their numbers", () => {
  demo();
  const rows = sheet(buildCsv(liveDoc()));
  assert.deepEqual(rows[31], ["Total", "", "13 of 30 shot", "9:44", "", "", "", "", "", ""]);
  assert.deepEqual(rows[32], ["Target", "", "0:44 over", "9:00", "", "", "", "", "", ""]);
  assert.deepEqual(rows[33], [""]);
  assert.deepEqual(rows[34], ["Comments"]);
  assert.deepEqual(rows[35], ["No.", "Location", "Status", "Assigned to", "Author", "Date", "Quoted text", "Comment"]);
  const c = rows.slice(36);
  assert.deepEqual(c[0].slice(0, 5), ["1", "Scene 03 · Audio", "Open", "", "Jo (editor)"]);
  assert.equal(c[0][6], "Some of them really, really don't.");
  assert.deepEqual(c[1].slice(0, 5), ["", "", "", "", "↳ Sam"], "the reply under its thread");
  assert.deepEqual(c[2].slice(0, 3), ["", "Scene 09 · Audio", "Resolved by Sam"], "resolved: no number");
  assert.deepEqual(c[3].slice(0, 5), ["2", "Scene 18 · Audio", "Open", "Jo (editor)", "Sam"]);
  assert.deepEqual(c[4].slice(0, 2), ["3", "Scene 24 · Audio"]);
  assert.ok(!buildCsv(liveDoc()).includes("Row "), "the app says Scene");
});

test("the new sheet reopens as exactly its scenes: no totals, no comments", () => {
  const s = demo();
  const back = csvToRows(buildCsv(liveDoc()));
  assert.equal(back.length, 30);
  back.forEach((r, i) => {
    assert.equal(r.visualText, escapeHtml(toPlainText(cellOf(s.rows[i].visualText))).replace(/\n/g, "<br>"), "scene " + (i + 1));
    assert.equal(r.audioText, escapeHtml(toPlainText(cellOf(s.rows[i].audioText))).replace(/\n/g, "<br>"), "scene " + (i + 1));
  });
});

test("a sheet exported before #169's columns reopens as its scenes, its comments left out", () => {
  const old = "﻿" + [
    "Scene,Status,Est. time,Visual,Audio",
    '01,Shot,0:10,"Wide on the kettle.\nB-roll: steam",Hello there.',
    "02,To do,0:02,Close,Goodbye.",
    ",,0:12,,",
    "",
    "Comments",
    "Location,Status,Assigned to,Author,Date,Quoted text,Comment",
    'Row 01 · Audio,Open,,Ann,"Sep 1, 2026, 10:00 AM",Hello there.,Nice.',
    ',,,↳ Bob,"Sep 2, 2026, 10:00 AM",,Agreed.'
  ].join("\r\n");
  assert.deepEqual(csvToRows(old).map((r) => [r.visualText, r.audioText]), [
    ["Wide on the kettle.<br>B-roll: steam", "Hello there."],
    ["Close", "Goodbye."]
  ]);
});

test("somebody else's sheet keeps what follows a row that says Comments", () => {
  const theirs = "No.,Visual,Audio,Status\n1,Wide,Hello,done\nComments,,,\n2,Close,Bye,done\n";
  assert.deepEqual(csvToRows(theirs).map((r) => [r.visualText, r.audioText]),
    [["Wide", "Hello"], ["Close", "Bye"]]);
  const noStatus = "Scene,Visual,Audio\n1,Wide,Hello\nComments,,\n2,Close,Bye\n";
  assert.equal(csvToRows(noStatus).length, 2, "not our header: nothing is cut");
});

test("a script with no target and no comments: no Target row, no Comments block", () => {
  S.state = migrateRows({ schema: 2, title: "Plain", rows: [{ id: "r0", visualText: "Wide", audioText: "Hello there.", status: "ready" }] });
  const rows = sheet(buildCsv(liveDoc()));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].slice(0, 3), ["01", "00:00", "Ready"]);
  assert.equal(rows[2][0], "Total");
  assert.equal(rows[2][2], "0 of 1 shot");
  assert.equal(csvToRows(buildCsv(liveDoc())).length, 1);
});

test("the breakdown sheet: the old columns where they were, when each item is first needed and its group after them", () => {
  demo();
  const rows = sheet(buildBreakdownCsv(liveDoc()));
  assert.deepEqual(rows[0], ["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "In script", "Notes", "B-roll shots",
                             "First scene at", "Group"]);
  const item = (name) => rows.find((r) => r[1] === name);
  assert.deepEqual(item("Pentax K1000").slice(9), ["00:00", "Props & set dressing"]);
  assert.deepEqual(item("button cell battery").slice(0, 3), ["Prop", "button cell battery", "Sourcing"]);
  assert.deepEqual(item("button cell battery").slice(9), ["03:43", "Props & set dressing"]);
  assert.deepEqual(item("Riverside park").slice(9), ["06:43", "Locations & shots"]);
  assert.deepEqual(item("lo-fi bed").slice(9), ["01:50", "Music & SFX"]);
  assert.deepEqual(item("gimbal").slice(9), ["05:11", "Gear"]);
  assert.ok(rows.slice(1).every((r) => r.length === 11));
});

test("the b-roll sheet: the scene's start after the columns it had", () => {
  demo();
  const rows = sheet(buildBrollCsv(liveDoc()));
  assert.deepEqual(rows[0], ["Scene", "Shot", "Status", "Flagged", "Location", "Props", "Cuts against", "Assigned to", "Note", "Description",
                             "Scene start"]);
  assert.equal(rows.length, 10);
  assert.deepEqual([rows[1][0], rows[1][1], rows[1][10]], ["04", "fingertip pushing on the sticky old foam", "01:03"]);
  assert.deepEqual([rows[2][0], rows[2][3], rows[2][10]], ["06", "yes", "01:50"]);
  assert.deepEqual(rows.slice(1).map((r) => r[10]), ["01:03", "01:50", "02:48", "04:28", "05:11", "05:56", "06:43", "07:25", "08:28"]);
});

const SHELL = '<!doctype html><html lang="en"><head>\n<meta charset="utf-8">\n<!-- an injected <script> is not a script -->\n' +
  "<title>Splitpage</title>\n" +
  '<meta name="description" content="A two-column visual/audio script editor with a built-in teleprompter reader.">\n' +
  '</head><body><script id="state-data" type="application/json">\n{"title":"<title>x</title>"}\n</script></body></html>';

test("the standalone page is named for the script: its title and the export's meta line", () => {
  demo();
  const html = withPageHead(SHELL, { title: LONG_DEMO.state.title + " — SplitShare", description: exportMetaLine(exportFacts(exportDocumentOf(S.state))) });
  assert.ok(html.includes("<title>I Fixed a $40 Film Camera (and Shot a Roll With It) — SplitShare</title>"));
  assert.ok(html.includes('<meta name="description" content="30 scenes · 9:44 running time · Target 9:00 · 0:44 over · 13 of 30 shot · '));
  assert.equal((html.match(/<title>/g) || []).length, 2, "the document's own text in the body is left alone");
  assert.ok(html.endsWith('{"title":"<title>x</title>"}\n</script></body></html>'));
  assert.ok(!html.includes("A two-column visual/audio"));
});

test("the page's head escapes the title, keeps a $& in it, and adds a description where the shell has none", () => {
  const html = withPageHead(SHELL.replace(/<meta name="description"[^>]*>\n/, ""),
    { title: 'Ben & "Jerry" <3 $& $1', description: "a\nb" });
  assert.ok(html.includes("<title>Ben &amp; &quot;Jerry&quot; &lt;3 $&amp; $1</title>\n<meta name=\"description\" content=\"a b\">"), html);
  assert.equal(withPageHead(SHELL, {}), SHELL);
});
