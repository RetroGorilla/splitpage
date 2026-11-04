import "../../../src/test/_dom.mjs";
import { liveDoc, liveWithAssets } from "../../../src/test/_export-now.mjs";
import { loadTestDocument } from "../../../src/test/_document.mjs";
import test from "node:test";
import { File } from "node:buffer";
import { TextDecoder, TextEncoder } from "node:util";
import assert from "node:assert/strict";
import { currentDocument } from "../../../src/bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { buildDocx, docxToRows } from "../../../src/adapters/formats/docx.ts";
import { buildBreakdownXlsx, buildBrollXlsx, buildScriptXlsx } from "../../../src/adapters/formats/xlsx.ts";
import { LONG_AUDIO, LONG_VISUAL, TAGS, TAG_LABELS, TITLE, UNICODE_LINE, loadFixture, plainOf } from "./round-trip-fixture.mjs";
import { readWorkbook, recordsOf, sheetNamed } from "./xlsx-reader.mjs";
import { zipRead, zipWrite } from "../../../src/adapters/formats/zip.ts";

const scriptRows = () => currentDocument().rows;
const openScript = async () => readWorkbook(buildScriptXlsx(liveDoc()));

test("new workbook headings and legacy headings read into the same beat records", async () => {
  loadFixture();
  const fixture = currentDocument();
  loadTestDocument(migrateRows({ ...fixture,
    rows: fixture.rows.map((row, i) => i ? row : { ...row, visualText: row.visualText + '<br><span class="broll-key" data-broll-id="bs_legacy" contenteditable="false">B-roll:</span> Harbour shot' }),
    brollShots: [{ id: "bs_legacy", name: "Harbour shot", status: "shot", props: [] }]
  }));
  for (const [build, names] of [[buildScriptXlsx, ["Script", "Breakdown", "B-roll"]], [buildBreakdownXlsx, ["Breakdown"]], [buildBrollXlsx, ["B-roll"]]]) {
    const bytes = build(liveDoc());
    const current = await readWorkbook(bytes);
    const zip = await zipRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const entries = [];
    for (const name of zip.names) {
      let data = await zip.get(name);
      if (name === "xl/sharedStrings.xml") {
        data = new TextEncoder().encode(new TextDecoder().decode(data).replace(/>Beat<\/t>/g, ">Scene</t>").replace(/>Beats<\/t>/g, ">Scenes</t>"));
      }
      entries.push({ name, data });
    }
    const legacy = await readWorkbook(zipWrite(entries));
    for (const name of names) {
      const now = sheetNamed(current, name), old = sheetNamed(legacy, name);
      const heading = name === "Breakdown" ? "Beats" : "Beat";
      assert.ok(now.rows[0].includes(heading));
      assert.ok(!now.rows[0].includes("Scene") && !now.rows[0].includes("Scenes"));
      assert.ok(old.rows[0].includes(name === "Breakdown" ? "Scenes" : "Scene"));
      assert.deepEqual(recordsOf(old), recordsOf(now));
      assert.ok(recordsOf(now).every(record => Object.hasOwn(record, heading)));
    }
  }
});

test("every row is a sheet row, in order, blank rows included, with its text, line breaks and status", async () => {
  loadFixture();
  const records = recordsOf(sheetNamed(await openScript(), "Script"));
  const beats = records.filter((r) => /^[A-Z]+\.\d+$/.test(r.Beat));
  assert.equal(beats.length, scriptRows().length);
  assert.deepEqual(beats.map((r) => r.Beat), scriptRows().map((_, i) => "A." + (i + 1)));
  scriptRows().forEach((row, i) => {
    const want = plainOf(row);
    assert.ok(beats[i].Visual === want.visual, "visual text of scene " + (i + 1));
    assert.ok(beats[i].Audio === want.audio, "audio text of scene " + (i + 1));
  });
  assert.deepEqual(beats.map((r) => r.Status), ["Filmed", "To do", "To do", "Ready", "To do", "To do", "To do", "To do", "To do", "To do"]);
  assert.deepEqual(records.slice(beats.length).map((r) => r.Beat), ["Total"]);
});

test("a row with nothing in it stays as a row with empty cells, so the numbering holds", async () => {
  loadFixture();
  const beats = recordsOf(sheetNamed(await openScript(), "Script")).filter((r) => /^[A-Z]+\.\d+$/.test(r.Beat));
  for (const i of [1, 6, 9]) {
    assert.deepEqual([beats[i].Visual, beats[i].Audio, beats[i].Tags, beats[i]["Open comments"]], ["", "", "", ""], "scene " + (i + 1));
  }
});

test("accents, curly quotes, emoji, right-to-left and CJK text, and the title, come through every sheet", async () => {
  loadFixture();
  const book = await openScript();
  const beats = recordsOf(sheetNamed(book, "Script"));
  assert.equal(beats[0].Audio.split("\n")[0], UNICODE_LINE);
  assert.equal(beats[2].Audio, "Narration only: “curly” ‘quotes’ and naïve café 😀.");
  assert.equal(beats[7].Visual, "שלום עולם 你好 🎬");
  assert.equal(beats[7].Audio, "Ünïcödé — ‘ﬁ’ ligature");
  assert.equal(book.xml("docProps/core.xml").getElementsByTagName("dc:title")[0].textContent, TITLE);
  const breakdown = recordsOf(sheetNamed(book, "Breakdown"));
  assert.ok(breakdown.some((r) => r.Item === "Rita 😀"));
  assert.ok(breakdown.some((r) => r.Item === "Café Pier"));
  const comments = recordsOf(sheetNamed(book, "Comments"));
  assert.deepEqual([comments[0].Author, comments[0].Comment, comments[0]["Assigned to"]], ["Zoë Ünal", "Café “check” 😀", "Bjørn"]);
  assert.ok(!book.text("xl/sharedStrings.xml").includes("�"));
});

test("long rows come back whole", async () => {
  loadFixture();
  const row = recordsOf(sheetNamed(await openScript(), "Script"))[4];
  assert.ok(row.Visual === LONG_VISUAL, "the long visual text");
  assert.ok(row.Audio === LONG_AUDIO, "the long audio text");
  assert.ok(row.Audio.length > 20000);
});

test("a line break and a blank line inside a cell come back as they were", async () => {
  loadFixture();
  const row = recordsOf(sheetNamed(await openScript(), "Script"))[5];
  assert.equal(row.Visual, "Opening\n\nAfter a break");
  assert.equal(row.Audio, "Line one.\n\nLine two.\n\n\nLine three.");
});

test("all six tag kinds come back as the scene's Tags and as Breakdown items with their category", async () => {
  loadFixture();
  const book = await openScript();
  const tags = recordsOf(sheetNamed(book, "Script"))[0].Tags.split("; ");
  assert.deepEqual([...tags].sort(), Object.keys(TAGS).map((cat) => TAG_LABELS[cat] + ": " + TAGS[cat]).sort());
  const items = recordsOf(sheetNamed(book, "Breakdown")).map((r) => [r.Category, r.Item, r.Beats, r["In script"]]);
  for (const cat of Object.keys(TAGS)) assert.deepEqual(items.find((i) => i[1] === TAGS[cat]), [TAG_LABELS[cat], TAGS[cat], "A.1", "yes"], cat);
  assert.equal(items.length, 6);
  const standalone = recordsOf(sheetNamed(await readWorkbook(buildBreakdownXlsx(liveDoc())), "Breakdown"));
  assert.deepEqual(standalone.map((r) => [r.Category, r.Item]), items.map((i) => i.slice(0, 2)));
});

test("comments: a row per comment and per reply, each with its author, quote, words and resolved state", async () => {
  loadFixture();
  const book = await openScript();
  const comments = recordsOf(sheetNamed(book, "Comments"));
  assert.equal(comments.length, 3);
  const [open, reply, resolved] = comments;
  assert.deepEqual([open["No."], open.Location, open.Status, open["Quoted text"]], [1, "Beat A.1 · Audio", "Open", "anchored words"]);
  assert.deepEqual([reply.Author, reply.Comment, reply["No."]], ["↳ Sam", "Done — ‘ok’.", ""]);
  assert.deepEqual([resolved.Location, resolved.Status, resolved.Author, resolved.Comment], ["Beat A.9 · Visual", "Resolved by Ann", "Ann", "Resolved note"]);
  assert.equal(recordsOf(sheetNamed(book, "Script"))[0]["Open comments"], "1");
});

test("pictures are dropped: no picture part in the file, and the text cells are the same with or without them", async () => {
  loadFixture();
  const withPictures = await openScript();
  assert.ok(scriptRows().some((r) => r.imageRef), "the fixture has pictures");
  assert.ok(!withPictures.names.some((n) => /media|drawing|\.(jpe?g|png)$/i.test(n)), withPictures.names.join(", "));
  const textOnly = migrateRows(JSON.parse(JSON.stringify({ ...currentDocument(), rows: scriptRows().map((r) => ({ ...r, imageRef: null })) })));
  loadTestDocument(textOnly);
  assert.deepEqual((await openScript()).sheets, withPictures.sheets);
});

test("the script's text in the workbook is the text a Word export of the same script reads back as", async () => {
  loadFixture();
  const sheet = recordsOf(sheetNamed(await openScript(), "Script")).filter((r) => /^[A-Z]+\.\d+$/.test(r.Beat));
  const word = await docxToRows(new File([buildDocx(...liveWithAssets())], "script.docx"));
  const fromSheet = sheet.filter((r) => r.Visual || r.Audio).map((r) => ({ visual: r.Visual, audio: r.Audio }));
  assert.deepEqual(word.rows.map(plainOf).filter((r) => r.visual || r.audio), fromSheet);
});

test("the b-roll sheet keeps each shot's scene, name, status, flag, location and note", async () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "Shots", comments: [],
    rows: [
      { id: "r0", status: "todo", visualText: "Open<br>" + '<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span> Café façade 😀', audioText: "Hello." },
      { id: "r1", status: "todo", visualText: "Next", audioText: "Bye." }
    ],
    brollShots: [{ id: "bs_1", name: "Café façade 😀", status: "shot", location: "Rue Saint-Honoré", reshoot: true, notes: "Needs a “warm” haze.", props: [] }]
  }));
  const sheet = sheetNamed(await readWorkbook(buildBrollXlsx(liveDoc())), "B-roll");
  const [shot] = recordsOf(sheet);
  assert.equal(sheet.rows.length, 2);
  assert.deepEqual([shot.Beat, shot.Shot, shot.Status, shot.Flagged, shot.Location, shot.Note],
    ["A.1", "A.1.1 Café façade 😀", "Filmed", "yes", "Rue Saint-Honoré", "Needs a “warm” haze."]);
});
