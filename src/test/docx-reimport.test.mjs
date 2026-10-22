import "./_dom.mjs";
import "./_export-services-started.mjs";
import { liveDoc, liveWithAssets } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { intern } from "../adapters/storage/02c-blobs.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { strBytes } from "../adapters/formats/bytes.ts";
import { zipRead, zipWrite } from "../adapters/formats/zip.ts";
import { htmlToPlainText } from "../legacy/plain-text.ts";
import { __init as initDocx, buildDocx, buildNarrationDocx, docxToRows } from "../adapters/formats/docx.ts";
import { loadTestDocument } from "./_document.mjs";

initTags();
initStatus();
initDocx();

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
  loadTestDocument(migrateRows({
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
  }));
  const expected = plainRows(S.state.rows);
  const bytes = buildDocx(...liveWithAssets());

  const parsed = await docxToRows(asFile(bytes));
  assert.equal(parsed.title, "Round trip");
  assert.deepEqual(plainRows(parsed.rows), expected, "the script's rows, and only those");
  const all = JSON.stringify(parsed.rows);
  for (const word of ["Comments", "COMMENTLINE", "REPLYLINE", "Ann", "Welcome”"]) {
    assert.equal(all.indexOf(word), -1, word + " leaked into a row");
  }
  assert.equal(parsed.rows[0].imageRef && parsed.rows[0].imageRef.sha256, rowPic.rec.sha256);
  assert.deepEqual(parsed.rows.slice(1).map((r) => r.imageRef), [null, null]);
});

test("an export with no comments reopens the same, and one with comments matches it", async () => {
  const rows = [
    { id: "r0", visualText: "One", audioText: "First.", status: "todo" },
    { id: "r1", visualText: "Two", audioText: "Second.", status: "todo" }
  ];
  loadTestDocument(migrateRows({ schema: 2, title: "Plain", rows, comments: [] }));
  const bare = await docxToRows(asFile(buildDocx(...liveWithAssets())));
  loadTestDocument(migrateRows({ schema: 2, title: "Plain", rows, comments: [
    { id: "c0", rowId: "r0", field: "audioText", author: "Ann", createdAt: "2026-09-01T10:00:00Z", body: "A note", replies: [] }
  ] }));
  const withComments = await docxToRows(asFile(buildDocx(...liveWithAssets())));
  assert.deepEqual(plainRows(withComments.rows), plainRows(bare.rows));
  assert.equal(withComments.rows.length, 2);
});

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
  assert.deepEqual(await read(para("Comments") + para("kept")), [
    { v: "Shot", a: "Line." }, { v: "", a: "Comments" }, { v: "", a: "kept" }
  ]);
  assert.deepEqual(await read(para("Notes", "Heading1") + para("kept")), [
    { v: "Shot", a: "Line." }, { v: "Notes", a: "" }, { v: "", a: "kept" }
  ]);
  assert.deepEqual(await read(para("Production breakdown", "Heading1") + para("dropped") +
    para("Comments", "Heading1") + para("dropped too")), [{ v: "Shot", a: "Line." }]);
  assert.deepEqual(await read(para("B-roll shot list", "Heading1") + para("Scene 01") + para("a shot")),
    [{ v: "Shot", a: "Line." }]);
  const before = await docxToRows(asFile(foreignDocx(para("T", "Title") + para("Comments", "Heading1") + script)));
  assert.deepEqual(plainRows(before.rows), [{ v: "Comments", a: "" }, { v: "Shot", a: "Line." }]);
});

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const wAttr = (el, name) => el.getAttributeNS(W, name) || el.getAttribute("w:" + name);
const kids = (el, name) => Array.from(el.childNodes).filter((n) => n.localName === name);
const runStyle = (r) => { const s = r.getElementsByTagNameNS(W, "rStyle")[0]; return s ? wAttr(s, "val") : ""; };
const paraStyle = (p) => { const s = p.getElementsByTagNameNS(W, "pStyle")[0]; return s ? wAttr(s, "val") : ""; };
const prop = (r, name, a) => { const e = r.getElementsByTagNameNS(W, name)[0]; return e ? wAttr(e, a || "val") : null; };
const THIN = String.fromCharCode(0x2009);

async function parts(bytes) {
  const zip = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const text = async (name) => { const b = await zip.get(name); return b ? new TextDecoder().decode(b) : null; };
  const xml = (s) => {
    const x = new DOMParser().parseFromString(s, "application/xml");
    assert.equal(x.getElementsByTagName("parsererror").length, 0);
    return x;
  };
  const doc = xml(await text("word/document.xml"));
  return { text, xml, doc, body: doc.getElementsByTagNameNS(W, "body")[0] };
}

const tagSpan = (cat, name, inner) => `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${inner || name}</span>`;
const cmtSpan = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const DIR = (inner) => `<span class="stage-dir">${inner}</span>`;
const CUE = (inner) => `<span class="audio-cue">${inner}</span>`;
const KEY = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;

function roundTripState(pic) {
  return {
    schema: 2, title: "Round trip, then and now", wordsPerMinute: 150, targetSeconds: 60,
    rows: [
      { id: "r0", status: "shot",
        visualText: "Wide on the " + tagSpan("location", "workbench") + ", the " + tagSpan("prop", "Pentax K1000", "<strong>Pentax</strong> K1000") + " in frame.<br>" + KEY("bs_1") + " dust in the light",
        audioText: "Forty dollars. " + DIR("beat") + " " + cmtSpan("c0", "The meter's <em>dead</em>,") + " the seals are <u>gone</u>, <s>sadly</s> and the <mark>shutter</mark> sticks. See <a href=\"https://example.com/k1000\">the manual</a>." },
      { id: "r1", status: "ready", lengthSeconds: 12, imageRef: pic, imageLinks: [{ href: "https://www.youtube.com/watch?v=abc123", poster: true }],
        visualText: tagSpan("vfx", "Title card") + " over the montage.",
        audioText: "Welcome back.<br>" + CUE("SFX: " + tagSpan("sound", "door slam")) + "<br>" + cmtSpan("c1", "Old oil") + " has gone gummy." },
      { id: "r2", status: "todo", visualText: "Close on the needle.", audioText: "" },
      { id: "r3", status: "todo", visualText: "", audioText: cmtSpan("c2", tagSpan("cast", "Rita") + " says hello") + " and waves." }
    ],
    comments: [
      { id: "c0", rowId: "r0", field: "audioText", author: "Jo", createdAt: "2026-09-20T10:00:00Z", quotedText: "The meter's dead,", body: "Hold here.",
        replies: [{ id: "rp0", author: "Sam", createdAt: "2026-09-20T11:00:00Z", body: "OK." }] },
      { id: "c1", rowId: "r1", field: "audioText", author: "Jo", createdAt: "2026-09-21T10:00:00Z", quotedText: "Old oil", body: "Check this.",
        resolved: true, resolvedBy: "Sam", replies: [] },
      { id: "c2", rowId: "r3", field: "audioText", author: "Ann", createdAt: "2026-09-22T10:00:00Z", quotedText: "Rita says hello", body: "Nice.", replies: [] }
    ]
  };
}

const PIC = intern(jpegBytes(320, 180, 7));
const loadRoundTrip = () => { loadTestDocument(migrateRows(roundTripState(PIC))); };

const MANUAL = '<a href="https://example.com/k1000" target="_blank" rel="noopener">the manual</a>';
const R0_AUDIO = 'Forty dollars. <span class="stage-dir">beat</span> The meter\'s <em>dead</em>, the seals are <u>gone</u>, <s>sadly</s> and the <mark>shutter</mark> sticks. See ' + MANUAL + ".";
const OLD_READ = {
  script: {
    title: "Round trip, then and now",
    rows: [
      { v: "Wide on the workbench, the <strong>Pentax</strong> K1000 in frame.<br>B-roll: dust in the light", a: R0_AUDIO, pic: null, more: [] },
      { v: "Title card over the montage.", a: 'Welcome back.<br><span class="audio-cue">SFX: door slam</span><br>Old oil has gone gummy.',
        pic: PIC.sha256, more: [[{ href: "https://www.youtube.com/watch?v=abc123", poster: true }]] },
      { v: "Close on the needle.", a: "", pic: null, more: [] },
      { v: "", a: "Rita says hello and waves.", pic: null, more: [] }
    ]
  },
  narration: {
    title: "Round trip, then and now",
    rows: [
      { v: "", a: R0_AUDIO, pic: null, more: [] },
      { v: "", a: "Welcome back.<br>Old oil has gone gummy.", pic: null, more: [] },
      { v: "", a: "Rita says hello and waves.", pic: null, more: [] }
    ]
  }
};

async function readBack(bytes) {
  const r = await docxToRows(asFile(bytes));
  return {
    title: r.title,
    rows: r.rows.map((x) => ({
      v: x.visualText, a: x.audioText, pic: x.imageRef ? x.imageRef.sha256 : null,
      more: (x.moreImages || []).map((m) => m.imageRef ? m.imageRef.sha256 : m.links)
    }))
  };
}

const fixture = (name) => new Uint8Array(readFileSync(new URL("./fixtures/" + name, import.meta.url)));

test("a .docx exported before #169 reopens exactly as it did, script and narration", async () => {
  assert.deepEqual(await readBack(fixture("splitpage-3.0.0-beta.8.docx")), OLD_READ.script);
  assert.deepEqual(await readBack(fixture("splitpage-3.0.0-beta.8-narration.docx")), OLD_READ.narration);
});

test("the same script exported now reopens as exactly the same rows: nothing drawn round the words comes back", async () => {
  loadRoundTrip();
  assert.deepEqual(await readBack(buildDocx(...liveWithAssets())), OLD_READ.script);
  loadRoundTrip();
  assert.deepEqual(await readBack(buildNarrationDocx(liveDoc(), { directions: true })), OLD_READ.narration);
});

test("the title's meta line, tags, markers, the b-roll chip and the comments' underlines are each in their own style", async () => {
  loadRoundTrip();
  const { body } = await parts(buildDocx(...liveWithAssets()));
  const paras = kids(body, "p");
  assert.equal(paraStyle(paras[0]), "Title");
  assert.equal(paraStyle(paras[1]), "SplitpageMeta");
  assert.match(paras[1].textContent, /^4 scenes · 0:\d\d running time · Target 1:00 · 0:\d\d under · 1 of 4 shot · .+$/);

  const script = kids(body, "tbl")[0];
  const runs = Array.from(script.getElementsByTagNameNS(W, "r"));
  const run = (text) => runs.find((r) => r.textContent === text);
  assert.deepEqual(runs.filter((r) => runStyle(r) === "SplitpageMarker").map((r) => r.textContent.split(THIN).join("")), ["1", "2"]);
  const bench = run("workbench");
  assert.equal(runStyle(bench), "SplitpageTag");
  assert.equal(prop(bench, "color"), "2A7449");
  assert.equal(prop(bench, "u"), "single");
  assert.equal(prop(bench, "u", "color"), "2A7449");
  assert.equal(runStyle(run("Pentax")), "SplitpageTag");
  assert.ok(run("Pentax").getElementsByTagNameNS(W, "b").length, "the writer's bold inside a tag stays");
  assert.equal(runStyle(run("door slam")), "SplitpageCue");
  assert.equal(prop(run("door slam"), "u", "color"), "AB413E");
  const key = runs.find((r) => runStyle(r) === "SplitpageBroll");
  assert.equal(key.textContent, THIN + "B-roll:" + THIN);
  assert.equal(prop(key, "bdr", "color"), "00717F");
  assert.equal(prop(run("The meter's "), "u"), "dotted");
  assert.equal(prop(run("The meter's "), "u", "color"), "9E5800");
  assert.equal(prop(run("Old oil"), "u", "color"), "64635E");
  assert.equal(prop(run("Rita"), "color"), "A53C75");
  assert.equal(prop(run("Rita"), "u"), "dotted");
  assert.equal(prop(run("gone"), "u"), "single");
  assert.equal(prop(run("gone"), "u", "color"), null);
});

test("the scene gutter and the read time sit either side of the script and are read past", async () => {
  loadRoundTrip();
  const { body } = await parts(buildDocx(...liveWithAssets()));
  const trs = kids(kids(body, "tbl")[0], "tr");
  const cells = (tr) => kids(tr, "tc");
  assert.deepEqual(cells(trs[0]).map((tc) => tc.textContent), ["Scene", "Visual", "Audio", "Read"]);
  assert.ok(trs[0].getElementsByTagNameNS(W, "tblHeader").length, "the header repeats on every page");
  assert.equal(prop(cells(trs[0])[1].getElementsByTagNameNS(W, "r")[0], "color"), "2863AB");
  assert.equal(prop(cells(trs[0])[2].getElementsByTagNameNS(W, "r")[0], "color"), "9E5800");
  const gutter = kids(cells(trs[2])[0], "p").map((p) => p.textContent);
  assert.deepEqual(gutter, ["02", "00:07", "● Ready"]);
  assert.deepEqual(kids(cells(trs[1])[0], "p").map((p) => p.textContent)[2], "✓ Shot");
  assert.deepEqual(kids(cells(trs[3])[0], "p").map((p) => p.textContent)[2], "○ To do");
  const read = (tr) => cells(tr)[3].getElementsByTagNameNS(W, "r")[0];
  assert.equal(read(trs[2]).textContent.split(THIN).join(""), "0:12");
  assert.ok(read(trs[2]).getElementsByTagNameNS(W, "bdr").length);
  assert.equal(read(trs[1]).getElementsByTagNameNS(W, "bdr").length, 0);
  assert.ok(trs.slice(1).every((tr) => tr.getElementsByTagNameNS(W, "cantSplit").length));
});

test("the breakdown is grouped by category and no item's row splits across a page", async () => {
  loadRoundTrip();
  const { body } = await parts(buildDocx(...liveWithAssets()));
  const paras = kids(body, "p");
  const heading = paras.find((p) => p.textContent === "Production breakdown");
  assert.equal(paraStyle(heading), "Heading1");
  assert.ok(heading.getElementsByTagNameNS(W, "pageBreakBefore").length, "the appendix starts a page of its own");
  const trs = kids(kids(body, "tbl")[1], "tr");
  assert.deepEqual(kids(trs[0], "tc").map((tc) => tc.textContent), ["Item", "Status", "Scenes", "Assigned to", "Notes"]);
  assert.ok(trs.every((tr) => tr.getElementsByTagNameNS(W, "cantSplit").length), "a row that can split");
  const groups = trs.filter((tr) => tr.getElementsByTagNameNS(W, "gridSpan").length);
  assert.deepEqual(groups.map((tr) => tr.textContent), [
    "● Props & set dressing  1", "● Locations & shots  1", "● Cast & wardrobe  1", "● VFX & graphics  1", "● Music & SFX  1"
  ]);
  assert.equal(prop(groups[0].getElementsByTagNameNS(W, "r")[1], "color"), "764AA2");
  assert.ok(groups.every((tr) => tr.getElementsByTagNameNS(W, "keepNext").length));
  const pentax = trs.find((tr) => kids(tr, "tc")[0].textContent === "Pentax K1000");
  assert.deepEqual(kids(pentax, "tc").slice(1, 3).map((tc) => tc.textContent), ["○ Needed", "01"]);
});

test("the b-roll shot list, by scene, with a box for each shot", async () => {
  loadRoundTrip();
  S.state.brollShots = [{ id: "bs_1", name: "dust in the light", status: "shot", location: "Workbench", reshoot: true, notes: "Needs a haze.", props: [] }];
  loadTestDocument(migrateRows(S.state));
  const { body } = await parts(buildDocx(...liveWithAssets()));
  const paras = kids(body, "p").map((p) => p.textContent);
  const at = paras.indexOf("B-roll shot list");
  assert.ok(at > 0);
  assert.deepEqual(paras.slice(at + 1, at + 6), [
    "1 of 1 shot · 1 flagged", "Scene 01  00:001/1 shot", "☑dust in the light", "Workbench  ·  Flagged", "Needs a haze."
  ]);
  assert.deepEqual(plainRows((await docxToRows(asFile(buildDocx(...liveWithAssets())))).rows).map((r) => r.v),
    ["Wide on the workbench, the Pentax K1000 in frame.\nB-roll: dust in the light", "Title card over the montage.", "Close on the needle.", ""]);
});

test("the narration: its meta line and each scene's number in the margin, none of it read back", async () => {
  loadRoundTrip();
  const { body } = await parts(buildNarrationDocx(liveDoc(), { directions: true }));
  const paras = kids(body, "p");
  assert.equal(paraStyle(paras[1]), "SplitpageMeta");
  assert.match(paras[1].textContent, /^Narration · 3 scenes · \d+ words · about 0:\d\d at 150 wpm$/);
  const scenes = paras.slice(2);
  assert.ok(scenes.every((p) => paraStyle(p) === "SplitpageNarration"));
  assert.deepEqual(scenes.map((p) => {
    const r = p.getElementsByTagNameNS(W, "r")[0];
    return runStyle(r) + ":" + r.textContent;
  }), ["SplitpageSceneNo:01", "SplitpageSceneNo:02", "SplitpageSceneNo:04"]);
  assert.ok(scenes.every((p) => prop(p, "ind", "hanging") && p.getElementsByTagNameNS(W, "tab").length));
  assert.equal(body.getElementsByTagNameNS(W, "tbl").length, 0, "prose, not a table");
});

test("the package says what it is: a title Word shows, Splitpage, the day; page X of Y in the footer", async () => {
  loadRoundTrip();
  const { text, xml } = await parts(buildDocx(...liveWithAssets()));
  const core = xml(await text("docProps/core.xml"));
  const one = (ns, name) => core.getElementsByTagNameNS(ns, name)[0].textContent;
  assert.equal(one("http://purl.org/dc/elements/1.1/", "title"), "Round trip, then and now");
  assert.equal(one("http://purl.org/dc/elements/1.1/", "creator"), "Splitpage");
  assert.match(one("http://purl.org/dc/terms/", "created"), /^\d{4}-\d\d-\d\dT00:00:00Z$/);
  assert.match(await text("docProps/app.xml"), /<Application>Splitpage<\/Application>/);
  const types = await text("[Content_Types].xml");
  assert.ok(types.includes('PartName="/docProps/core.xml"') && types.includes('PartName="/docProps/app.xml"') && types.includes('PartName="/word/settings.xml"'));
  const rels = await text("_rels/.rels");
  assert.ok(rels.includes('Target="docProps/core.xml"') && rels.includes('Target="docProps/app.xml"'));
  assert.match(await text("word/settings.xml"), /compatibilityMode" w:uri="http:\/\/schemas.microsoft.com\/office\/word" w:val="15"/);
  const footer = xml(await text("word/footer1.xml"));
  assert.deepEqual(Array.from(footer.getElementsByTagNameNS(W, "instrText")).map((i) => i.textContent.trim()), ["PAGE", "NUMPAGES"]);
  assert.equal(Array.from(footer.getElementsByTagNameNS(W, "t")).map((t) => t.textContent).join(""), "Round trip, then and nowPage 1 of 1");
});

test("a title cut short in the footer never ends in half an emoji (#434)", async () => {
  const grin = String.fromCodePoint(0x1F600);
  loadTestDocument(migrateRows({ schema: 2, title: "x".repeat(88) + grin + "tail", rows: [{ id: "r0", visualText: "V", audioText: "A.", status: "todo" }], comments: [] }));
  const { text, xml } = await parts(buildDocx(...liveWithAssets()));
  assert.equal(xml(await text("word/footer1.xml")).getElementsByTagNameNS(W, "t")[0].textContent, "x".repeat(88) + "…");
});

test("a long title wraps on the page and is cut short in the footer; an empty script reopens empty", async () => {
  const long = "A title that goes on and on: " + "and on ".repeat(20).trim();
  loadTestDocument(migrateRows({ schema: 2, title: long, rows: [{ id: "r0", visualText: "V", audioText: "A.", status: "todo" }], comments: [] }));
  const { text, xml, body } = await parts(buildDocx(...liveWithAssets()));
  assert.equal(kids(body, "p")[0].textContent, long);
  const foot = xml(await text("word/footer1.xml")).getElementsByTagNameNS(W, "t")[0].textContent;
  assert.ok(foot.length <= 90 && foot.endsWith("…") && long.startsWith(foot.slice(0, -1)), foot);

  loadTestDocument(migrateRows({ schema: 2, title: "Empty", rows: [], comments: [] }));
  const empty = await parts(buildDocx(...liveWithAssets()));
  assert.match(kids(empty.body, "p")[1].textContent, /^0 scenes · 0:00 running time · /);
  const back = await docxToRows(asFile(buildDocx(...liveWithAssets())));
  assert.equal(back.title, "Empty");
  assert.deepEqual(back.rows, []);
});

test("a coloured underline is the export's drawing only in the export's own file; in anyone else's it is an underline", async () => {
  const run = '<w:r><w:rPr><w:u w:val="single" w:color="FF0000"/></w:rPr><w:t>red line</w:t></w:r>';
  const tableOf = (style) => "<w:tbl><w:tblPr>" + (style ? '<w:tblStyle w:val="' + style + '"/>' : "") + "</w:tblPr>" +
    "<w:tr>" + cell("Visual") + cell("Audio") + "</w:tr><w:tr>" + cell("Shot") + "<w:tc><w:p>" + run + "</w:p></w:tc></w:tr></w:tbl>";
  const mine = await docxToRows(asFile(foreignDocx(tableOf("TableGrid"))));
  assert.equal(mine.rows[0].audioText, "<u>red line</u>");
  const ours = await docxToRows(asFile(foreignDocx(tableOf("SplitpageTable"))));
  assert.equal(ours.rows[0].audioText, "red line");
});

test("the breakdown's heads, old and new, are never read as a scene", async () => {
  for (const head of [["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "Notes"], ["Item", "Status", "Scenes", "Assigned to", "Notes"]]) {
    const body = table(null, [["Visual", "Audio"], ["Shot", "Line."]]) + table(null, [head, head.map((h) => h + " value")]);
    assert.deepEqual(plainRows((await docxToRows(asFile(foreignDocx(body)))).rows), [{ v: "Shot", a: "Line." }], head.join("|"));
  }
});
