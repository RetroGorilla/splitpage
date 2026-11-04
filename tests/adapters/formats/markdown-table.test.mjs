import "../../../src/test/_dom.mjs";
import "../../../src/test/_preferences-started.mjs";
import "../../../src/test/_export-services-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../../../src/bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { mountProductionTagsFeature as initTags } from "../../../src/bootstrap/wiring/production-tags.ts";
import { detectTwoColumnFormat, parseImportRows } from "../../../src/adapters/formats/import-text.ts";
import { parseMarkdownTable } from "../../../src/adapters/formats/markdown-table.ts";
import { cellOf } from "../../../src/bootstrap/richtext.ts";
import { toMarkdown } from "../../../src/core/text/projections.ts";
import { exportMetaLine, toMarkdownDoc, toMarkdownTableDoc } from "../../../src/adapters/formats/export-text.ts";
import { LONG_DEMO } from "../../../src/starters/index.ts";
import { exportDocumentOf } from "../../../src/bootstrap/wiring/export-capture.ts";
import { exportFacts } from "../../../src/adapters/formats/export-kit.ts";
import { loadTestDocument } from "../../../src/test/_document.mjs";

initTags();

const cells = (rows) => rows.map((r) => [r.visualText, r.audioText]);

test("stacked imports distinguish scene headers from legacy Scene and current Beat rows", () => {
  for (const word of ["Scene", "Beat"]) {
    const text = `# Video\n\n_2 ${word.toLowerCase()}s · 0:02 running time_\n\n## Scene B · 0:02\n\n### ${word} B.1 · 00:00\n\n**Filmed** · Read 0:01\n\n*Visual —* Wide\n\nHello\n\n---\n\n### ${word} B.2 · 00:01\n\n_(blank ${word.toLowerCase()})_\n`;
    assert.equal(detectTwoColumnFormat(text), "stacked");
    assert.deepEqual(cells(parseImportRows(text, "twocolumn")), [["Wide", "Hello"], ["", ""]]);
  }
});

test("a plain two-column table, header and separator both consumed", () => {
  const out = parseMarkdownTable([
    "| Visual | Audio |",
    "| --- | --- |",
    "| wide shot | Hello there. |",
    "| cutaway | And then this. |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["wide shot", "Hello there."], ["cutaway", "And then this."]]);
  assert.deepEqual(out.map((r) => r.statusText), ["", ""]);
});

test("no header at all: the first two columns are Visual and Audio", () => {
  const out = parseMarkdownTable("| a | b |\n| c | d |");
  assert.deepEqual(cells(out), [["a", "b"], ["c", "d"]]);
});

test("the header names the columns, wherever they sit", () => {
  const out = parseMarkdownTable([
    "| # | Narration | Screen | Status |",
    "| --- | --- | --- | --- |",
    "| 01 | Hello. | wide shot | shot |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["wide shot", "Hello."]]);
  assert.equal(out[0].statusText, "shot");
});

test("a header naming only one column never points both fields at it", () => {
  const audioFirst = parseMarkdownTable("| Audio | Notes |\n| --- | --- |\n| Hello. | wide shot |");
  assert.deepEqual(cells(audioFirst), [["wide shot", "Hello."]]);

  const audioSecond = parseMarkdownTable("| Notes | Audio |\n| --- | --- |\n| wide shot | Hello. |");
  assert.deepEqual(cells(audioSecond), [["wide shot", "Hello."]]);

  const visualOnly = parseMarkdownTable("| Notes | Visual |\n| --- | --- |\n| Hello. | wide shot |");
  assert.deepEqual(cells(visualOnly), [["wide shot", "Hello."]]);
});

test("an escaped pipe stays inside its cell", () => {
  const out = parseMarkdownTable([
    "| Visual | Audio | Status |",
    "| --- | --- | --- |",
    "| a \\| b | c \\| d | shot |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["a | b", "c | d"]]);
  assert.equal(out[0].statusText, "shot");
});

test("a separator row is never data, however it is written", () => {
  const out = parseMarkdownTable([
    "| Visual | Audio |",
    "|:---|---:|",
    "| a | b |",
    "| :--: | :--: |",
    "| c | d |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["a", "b"], ["c", "d"]]);
});

test("lines with no pipe in them are ignored", () => {
  const out = parseMarkdownTable([
    "# A heading",
    "",
    "Some prose about the script.",
    "| Visual | Audio |",
    "| --- | --- |",
    "| a | b |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["a", "b"]]);
});

test("a scene with nothing typed in it is dropped by default and kept with keepEmpty", () => {
  const md = [
    "| # | Visual | Audio | Status |",
    "| --- | --- | --- | --- |",
    "| 01 | a | b | todo |",
    "| 02 |  |  | todo |",
    "| 03 | c | d | todo |"
  ].join("\n");
  assert.deepEqual(cells(parseMarkdownTable(md)), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(cells(parseMarkdownTable(md, { keepEmpty: true })),
    [["a", "b"], ["", ""], ["c", "d"]]);
});

test("a row with nothing in ANY column reads as a separator, keepEmpty or not", () => {
  const md = "| Visual | Audio |\n| --- | --- |\n| a | b |\n|  |  |\n| c | d |";
  assert.deepEqual(cells(parseMarkdownTable(md, { keepEmpty: true })), [["a", "b"], ["c", "d"]]);
});

test("a row with only one of the two cells filled is always kept", () => {
  assert.deepEqual(cells(parseMarkdownTable("| Visual | Audio |\n| --- | --- |\n| a |  |\n|  | d |")),
    [["a", ""], ["", "d"]]);
});

test("CRLF and untrimmed cells", () => {
  const out = parseMarkdownTable("| Visual | Audio |\r\n| --- | --- |\r\n|   a   |   b   |\r\n");
  assert.deepEqual(cells(out), [["a", "b"]]);
});

test("nothing table-shaped at all gives an empty list, never a throw", () => {
  assert.deepEqual(parseMarkdownTable(""), []);
  assert.deepEqual(parseMarkdownTable("just some prose\nwith no pipes"), []);
  assert.deepEqual(parseMarkdownTable("| Visual | Audio |\n| --- | --- |"), []);
});

test("a short row does not read a neighbour's column", () => {
  const out = parseMarkdownTable("| Visual | Audio | Status |\n| --- | --- | --- |\n| a |");
  assert.deepEqual(cells(out), [["a", ""]]);
  assert.equal(out[0].statusText, "");
});

test("a Two columns export reads back as its scenes only, not its breakdown or comments", () => {
  const tag = (cat, name) =>
    `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;
  loadTestDocument(migrateRows({
    schema: 2, title: "Two col",
    rows: [
      { id: "r1", visualText: "Wide " + tag("vfx", "explosion"), audioText: "Hello there.", status: "todo" },
      { id: "r2", visualText: "Close on the " + tag("prop", "mug"), audioText: "Coffee time.", status: "todo" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", author: "Ann", body: "a | b | c",
      createdAt: "2026-09-01T10:00:00Z", replies: [] }]
  }));
  const md = toMarkdownTableDoc(exportDocumentOf(currentDocument()));
  assert.match(md, /## Production breakdown/);
  assert.match(md, /## Comments/);
  const expected = [["Wide explosion", "Hello there."], ["Close on the mug", "Coffee time."]];
  assert.deepEqual(cells(parseMarkdownTable(md)), expected);
  assert.equal(detectTwoColumnFormat(md), "table");
  assert.deepEqual(cells(parseImportRows(md, "twocolumn")), expected);
});

test("someone else's table keeps what follows its own Comments heading", () => {
  const md = "| Visual | Audio |\n| --- | --- |\n| a | b |\n\n## Comments\n\n| c | d |";
  assert.deepEqual(cells(parseMarkdownTable(md)), [["a", "b"], ["c", "d"]]);
});

test("the stacked Markdown export of the long demo reads back as its 30 scenes", () => {
  loadTestDocument(migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state))));
  const orig = currentDocument().rows;
  const md = toMarkdownDoc(exportDocumentOf(currentDocument()));
  assert.match(md, /## Production breakdown/);
  assert.match(md, /## Comments/);
  assert.equal(detectTwoColumnFormat(md), "stacked");
  const out = parseImportRows(md, "twocolumn");
  assert.equal(out.length, 30);
  out.forEach((r, i) => {
    assert.equal(r.visualText, toMarkdown(cellOf(orig[i].visualText)), "scene " + (i + 1) + " Visual");
    assert.equal(r.audioText, toMarkdown(cellOf(orig[i].audioText)), "scene " + (i + 1) + " Audio");
  });
});

test("a stacked export's blank scene, video link and multi-line cells", () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "Stack",
    rows: [
      { id: "r1", visualText: "Wide<br>then close", audioText: "Hello <strong>there</strong>.<br><br>Second para.", status: "todo",
        imageLinks: ["https://www.youtube.com/watch?v=aqz-KE-bpKQ"] },
      { id: "r2", visualText: "", audioText: "", status: "todo" },
      { id: "r3", visualText: "", audioText: "Just audio.", status: "todo" }
    ]
  }));
  const md = toMarkdownDoc(exportDocumentOf(currentDocument()));
  assert.deepEqual(cells(parseImportRows(md, "twocolumn")), [
    ["Wide\nthen close", "Hello **there**.\n\nSecond para."],
    ["", ""],
    ["", "Just audio."]
  ]);
});

test("Markdown that only looks like the stacked export reads as it always did", () => {
  assert.equal(detectTwoColumnFormat("# Notes\n\nSome intro.\n\n### Beat 01\n\nWords."), null);
  assert.equal(detectTwoColumnFormat("### Beat 01\n\nWords.\n\n### Beat 02\n\nMore."), null);
});

const demo = () => { loadTestDocument(migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state)))); return currentDocument(); };

test("the stacked export of the long demo: meta line, scene headings, status and read time", () => {
  demo();
  const md = toMarkdownDoc(exportDocumentOf(currentDocument()));
  const lines = md.split("\n");
  assert.equal(lines[0], "# " + LONG_DEMO.state.title);
  assert.equal(lines[2], "_" + exportMetaLine(exportFacts(exportDocumentOf(currentDocument()))) + "_");
  assert.match(lines[2], /^_30 beats · 9:44 running time · Target 9:00 · 0:44 over · 13 of 30 filmed · .*2026_$/);
  assert.ok(md.includes("### Beat A.1 · 00:00\n\n**Filmed** · Read 0:10\n\n*Visual —* Cold open"));
  assert.ok(md.includes("### Beat A.4 · 01:03\n\n**Filmed** · Read 0:37\n"));
  assert.ok(md.includes("### Beat A.10 · 02:48\n\n**Ready** · Read 0:38\n"));
  assert.ok(md.includes("### Beat A.13 · 03:43\n\n**To do** · Read 0:45\n"));
  assert.ok(md.includes("### Beat A.2 · 00:10\n\n**Filmed** · Read 0:06, set by hand\n"));
  assert.equal((md.match(/, set by hand$/gm) || []).length, 2);
  assert.ok(!/\bRow\b/.test(md), "the app says Scene");
  assert.ok(md.includes("*Visual —* Close-up: the back door open, crumbling foam in the channels.  \n" +
    "Lower third: “Problem 1 — light seals”  \nB-roll: fingertip pushing on the sticky old foam\n\nFirst problem."));
});

test("the stacked export numbers each open thread after its words, and a resolved one not at all", () => {
  demo();
  const md = toMarkdownDoc(exportDocumentOf(currentDocument()));
  assert.ok(md.includes("really, really don't.<sup>1</sup> This one"), "scene 03");
  assert.ok(md.includes("Buy two.<sup>2</sup>\n"), "scene 18");
  assert.ok(md.includes("nothing left to show you.<sup>3</sup>\n"), "scene 24");
  assert.equal((md.match(/<sup>\d+<\/sup>/g) || []).length, 3, "scene 09's resolved thread has none");
  assert.ok(md.includes("gummy in the escapement.\n"));
  const tail = md.slice(md.indexOf("## Comments"));
  assert.ok(tail.includes("**1 · Beat A.3 · Audio** — Jo (editor)"));
  assert.ok(tail.includes("**2 · Beat A.18 · Audio** _(assigned to Jo (editor))_ — Sam"));
  assert.ok(tail.includes("**3 · Beat A.24 · Audio** — Jo (editor)"));
  assert.ok(tail.includes("**Beat A.9 · Audio** _(resolved by Sam)_ — Jo (editor)"));
  assert.ok(tail.indexOf("**1 · ") < tail.indexOf("**Beat A.9") && tail.indexOf("**Beat A.9") < tail.indexOf("**2 · "), "script order");
  assert.ok(tail.includes("> ↳ **Sam** · "));
});

test("the export tail: the breakdown by category, the b-roll shot list as task lists, then the comments", () => {
  demo();
  for (const md of [toMarkdownDoc(exportDocumentOf(currentDocument())), toMarkdownTableDoc(exportDocumentOf(currentDocument()), { export: true })]) {
    const at = (s) => md.indexOf(s);
    assert.ok(at("## Production breakdown") < at("## B-roll shot list") && at("## B-roll shot list") < at("## Comments"));
    const bd = md.slice(at("## Production breakdown"), at("## B-roll shot list"));
    assert.deepEqual(bd.match(/^### .*$/gm), [
      "### Props & set dressing (6)", "### Locations & shots (4)", "### Cast & wardrobe (2)",
      "### VFX & graphics (10)", "### Music & SFX (6)", "### Gear (3)"
    ]);
    assert.equal((bd.match(/^\| Item \| Status \| Beats \| Assigned to \| Notes \|$/gm) || []).length, 6);
    assert.ok(bd.includes("| Pentax K1000 | Have it | A.1, A.28 | Sam | The $40 flea-market body. Keep the lens cap on between setups. |"));
    assert.ok(bd.includes("| toothpick | Have it | A.5, A.7 | — |  |"), "nobody assigned: a dash, as the panel shows it");
    assert.ok(bd.includes("| gimbal | Returned | A.16 | — | Borrowed for the shop day. |"));
    assert.ok(!/\| Prop \|/.test(bd), "the category is the heading, not a column");
    const br = md.slice(at("## B-roll shot list"), at("## Comments"));
    assert.ok(br.includes("_3 of 9 filmed · 1 flagged_"));
    assert.ok(br.includes("**Beat A.4** · 01:03 · 1/1 filmed\n\n- [x] A.4.1 fingertip pushing on the sticky old foam\n"));
    assert.ok(br.includes("- [x] A.6.1 the toothpick lifting a long strand of goo — **Flagged** · Note: "));
    assert.ok(br.includes("**Beat A.22** · 06:43 · 0/1 filmed\n\n- [ ] A.22.1 feet on the gravel path, low angle — Riverside park\n"));
    assert.equal((br.match(/^- \[[ x]\] /gm) || []).length, 9);
    assert.equal((br.match(/^- \[x\] /gm) || []).length, 3);
    assert.ok(!/FLAGGED/.test(br));
  }
});

test("the new stacked export reads back as exactly its scenes, and nothing round them", () => {
  const s = demo();
  const md = toMarkdownDoc(exportDocumentOf(currentDocument()));
  assert.equal(detectTwoColumnFormat(md), "stacked");
  const out = parseImportRows(md, "twocolumn");
  assert.equal(out.length, 30);
  out.forEach((r, i) => {
    assert.equal(r.visualText, toMarkdown(cellOf(s.rows[i].visualText)), "scene " + (i + 1) + " Visual");
    assert.equal(r.audioText, toMarkdown(cellOf(s.rows[i].audioText)), "scene " + (i + 1) + " Audio");
    assert.ok(!/<sup>|· Read |^\*\*Shot\*\*/.test(r.visualText + r.audioText));
  });
});

test("a thread's marker sits outside a mark that ends with it, inside one that goes on, before a space", () => {
  const cmt = (id, inner) => '<span class="cmt-anchor" data-cmt="' + id + '">' + inner + "</span>";
  const doc = migrateRows({
    schema: 2, title: "Markers",
    rows: [
      { id: "r0", visualText: "", status: "todo",
        audioText: "<strong>" + cmt("a", "Bold words") + " run on</strong> and " + cmt("b", "<em>end here</em>") + ". Then " + cmt("c", "trailing ") + "space." },
      { id: "r1", visualText: "Look " + cmt("d", "one " + cmt("e", "two")) + " [1] stays", audioText: "Say (1) and " + cmt("f", "gone") + " too.", status: "todo" }
    ],
    comments: ["a", "b", "c", "d", "e", "f"].map((id) => ({
      id, rowId: id < "d" ? "r0" : "r1", field: id === "d" || id === "e" ? "visualText" : "audioText",
      author: "Ann", body: id, resolved: id === "f", createdAt: "2026-09-01T10:00:00Z", replies: []
    }))
  });
  loadTestDocument(doc);
  const md = toMarkdownDoc(exportDocumentOf(currentDocument()));
  assert.ok(md.includes("**Bold words<sup>1</sup> run on** and *end here*<sup>2</sup>. Then trailing<sup>3</sup> space."), md);
  assert.ok(md.includes("*Visual —* Look one two<sup>4</sup><sup>5</sup> [1] stays"), md);
  assert.ok(md.includes("Say (1) and gone too."), "resolved: no marker");
  const out = parseImportRows(md, "twocolumn");
  assert.deepEqual(out.map((r) => [r.visualText, r.audioText]),
    doc.rows.map((r) => [toMarkdown(cellOf(r.visualText)), toMarkdown(cellOf(r.audioText))]));
  assert.equal(out[1].visualText, "Look one two [1] stays");
});

test("a stacked export written before #169's look still reads back as its scenes", () => {
  const old = [
    "# Old one", "",
    "_3 beats · est. 0:12 running time_", "",
    "### Beat 01", "",
    "▶ [youtube.com/watch?v=aqz-KE-bpKQ](https://www.youtube.com/watch?v=aqz-KE-bpKQ)", "",
    "*Visual —* Wide on the **kettle**.", "B-roll: steam rising", "",
    "Hello there. *(beat)* Welcome back.", "", "---", "",
    "### Beat 02", "", "_(blank scene)_", "", "---", "",
    "### Beat 03", "", "Just audio.", "", "---", "",
    "## Production breakdown", "",
    "| Category | Item | Status | Assigned to | Mentions | Scenes | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| Prop | kettle | Needed |  | 1 | 01 |  |", "",
    "## Comments", "",
    "**Row 01 · Audio** — Ann · Sep 1, 2026, 10:00 AM", "", "> Hello there.", "", "Nice.", "", "---", ""
  ].join("\n");
  assert.equal(detectTwoColumnFormat(old), "stacked");
  assert.deepEqual(cells(parseImportRows(old, "twocolumn")), [
    ["Wide on the **kettle**.\nB-roll: steam rising", "Hello there. *(beat)* Welcome back."],
    ["", ""],
    ["", "Just audio."]
  ]);
});

test("the two-column export: the meta line and the gutter's columns, reopened as its scenes", () => {
  const s = demo();
  const md = toMarkdownTableDoc(exportDocumentOf(currentDocument()), { export: true });
  const lines = md.split("\n");
  assert.equal(lines[2], "_" + exportMetaLine(exportFacts(exportDocumentOf(currentDocument()))) + "_");
  assert.equal(lines[7], "| # | Start | Status | Visual | Audio | Read |");
  assert.ok(lines[9].startsWith("| A.1 | 00:00 | Filmed | Cold open, macro:"));
  assert.ok(lines[9].endsWith(" | 0:10 |"));
  assert.ok(lines[10].startsWith("| A.2 | 00:10 | Filmed | ") && lines[10].endsWith(" | ((music up)) | 0:06, set by hand |"));
  assert.equal(detectTwoColumnFormat(md), "table");
  const out = parseImportRows(md, "twocolumn");
  assert.equal(out.length, 30);
  const project = parseMarkdownTable(toMarkdownTableDoc(exportDocumentOf(currentDocument())));
  assert.deepEqual(cells(out), cells(project));
  assert.equal(out[12].statusText, "To do");
  assert.equal(s.rows.length, 30);
});

test("a tail that opens on the b-roll list ends the script too, in either shape", () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "Just b-roll",
    rows: [
      { id: "r0", visualText: '<span class="broll-key" data-broll-id="b1" contenteditable="false">B-roll:</span> gulls over the nets', audioText: "Morning.", status: "todo" },
      { id: "r1", visualText: "Close", audioText: "Evening.", status: "todo" }
    ],
    brollShots: [{ id: "b1", name: "gulls over the nets", status: "shot" }]
  }));
  const stacked = toMarkdownDoc(exportDocumentOf(currentDocument())), table = toMarkdownTableDoc(exportDocumentOf(currentDocument()), { export: true });
  for (const md of [stacked, table]) {
    assert.ok(!md.includes("## Production breakdown") && !md.includes("## Comments"));
    assert.ok(md.includes("## B-roll shot list\n\n_1 of 1 filmed_\n\n**Beat A.1** · 00:00 · 1/1 filmed\n\n- [x] A.1.1 gulls over the nets\n"), md);
    assert.deepEqual(cells(parseImportRows(md, "twocolumn")), [["B-roll: gulls over the nets", "Morning."], ["Close", "Evening."]]);
  }
});

test("a script with no target, tags, b-roll or comments: the meta line says less, the tail is absent", () => {
  loadTestDocument(migrateRows({ schema: 2, title: "Plain", rows: [{ id: "r0", visualText: "Wide", audioText: "Hello there.", status: "ready" }] }));
  const md = toMarkdownDoc(exportDocumentOf(currentDocument()));
  assert.match(md, /^# Plain\n\n_1 beat · 0:0\d running time · 0 of 1 filmed · [^_\n]+_\n\n## A · 0:0\d\n\n### Beat A\.1 · 00:00\n\n\*\*Ready\*\* · Read 0:0\d\n\n\*Visual —\* Wide\n\nHello there\.\n\n---\n$/);
  assert.equal((md.match(/^## .*$/gm) || []).join(""), "## A · 0:01");
  const table = toMarkdownTableDoc(exportDocumentOf(currentDocument()), { export: true });
  assert.equal((table.match(/^## .*$/gm) || []).join(""), "## A · 0:01");
  assert.ok(!/Target/.test(table));
  loadTestDocument(migrateRows({ schema: 2, title: "Empty", rows: [] }));
  assert.equal(toMarkdownDoc(exportDocumentOf(currentDocument())), "# Empty\n\n_No beats yet._\n");
  assert.equal(toMarkdownTableDoc(exportDocumentOf(currentDocument()), { export: true }), "# Empty\n\n_No beats yet._\n");
  assert.equal(toMarkdownTableDoc(exportDocumentOf(currentDocument())), "# Empty\n\n_No rows yet._\n", "the project's table, as it always was");
});
