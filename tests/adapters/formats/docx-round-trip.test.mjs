import "../../../src/test/_dom.mjs";
import { liveDoc, liveWithAssets } from "../../../src/test/_export-now.mjs";
import test from "node:test";
import { File } from "node:buffer";
import assert from "node:assert/strict";
import { currentDocument } from "../../../src/bootstrap/wiring/session-owner.ts";
import { buildDocx, buildNarrationDocx, docxToRows } from "../../../src/adapters/formats/docx.ts";
import { zipRead } from "../../../src/adapters/formats/zip.ts";
import { LONG_AUDIO, LONG_VISUAL, PICTURES, TAGS, TITLE, UNICODE_LINE, isBlank, loadFixture, plainOf } from "./round-trip-fixture.mjs";

const asFile = (bytes) => new File([bytes], "script.docx");
const reread = (bytes) => docxToRows(asFile(bytes));
const scriptRows = () => currentDocument().rows;
const hasContent = (row) => !isBlank(plainOf(row)) || !!row.imageRef;
const idsOf = (rows) => rows.map((r) => r.id);
const sha = (row) => (row.imageRef ? row.imageRef.sha256 : null);
const firstLine = (text) => text.split("\n")[0];
const TAGGED_LINE = "Wide on the " + Object.values(TAGS).join(" · ");

test("the title, the text of every row, its line breaks and the row order come back exactly", async () => {
  loadFixture();
  const back = await reread(buildDocx(...liveWithAssets()));
  assert.equal(back.title, TITLE);
  assert.deepEqual(back.rows.map(plainOf), scriptRows().filter(hasContent).map(plainOf));
  assert.equal(back.rows.length, 7);
  assert.equal(back.looseText, "");
});

test("a row with no text and no picture is dropped wherever it sits; the others keep their order", async () => {
  loadFixture();
  const blank = scriptRows().filter((r) => !hasContent(r));
  assert.deepEqual(idsOf(blank), ["r1", "r6", "r9"], "the fixture has a blank row early, in the middle and last");
  const back = await reread(buildDocx(...liveWithAssets()));
  assert.equal(back.rows.length, scriptRows().length - blank.length);
  assert.deepEqual(back.rows.map((r) => (plainOf(r).visual || plainOf(r).audio).slice(0, 7)),
    ["Wide on", "Narrati", "", "Slow pa", "Opening", "שלום עו", "Last ro"]);
});

test("accents, curly quotes, emoji, right-to-left and CJK text survive the script and the narration", async () => {
  loadFixture();
  const script = await reread(buildDocx(...liveWithAssets()));
  assert.equal(script.title, TITLE);
  assert.equal(firstLine(plainOf(script.rows[0]).audio), UNICODE_LINE);
  assert.equal(plainOf(script.rows[5]).visual, "שלום עולם 你好 🎬");
  const narration = await reread(buildNarrationDocx(liveDoc(), { directions: true }));
  assert.equal(narration.title, TITLE);
  assert.equal(firstLine(plainOf(narration.rows[0]).audio), UNICODE_LINE);
  assert.equal(plainOf(narration.rows[1]).audio, "Narration only: “curly” ‘quotes’ and naïve café 😀.");
  assert.equal(plainOf(narration.rows[4]).audio, "Ünïcödé — ‘ﬁ’ ligature");
});

test("long rows come back whole", async () => {
  loadFixture();
  const back = await reread(buildDocx(...liveWithAssets()));
  const long = back.rows.map(plainOf).find((r) => r.visual.startsWith("Slow pan"));
  assert.ok(long.visual === LONG_VISUAL, "the long visual text");
  assert.ok(long.audio === LONG_AUDIO, "the long audio text");
  assert.ok(long.audio.length > 20000);
});

test("a line break and a blank line inside a cell come back as they were", async () => {
  loadFixture();
  const back = await reread(buildDocx(...liveWithAssets()));
  const broken = back.rows.map(plainOf).find((r) => r.visual.startsWith("Opening"));
  assert.equal(broken.visual, "Opening\n\nAfter a break");
  assert.equal(broken.audio, "Line one.\n\nLine two.\n\n\nLine three.");
  assert.equal(plainOf(back.rows[0]).visual.split("\n")[1], "second line of the shot");
});

test("all six tag kinds come back as their plain words, with no tag marking and no tag list", async () => {
  loadFixture();
  const back = await reread(buildDocx(...liveWithAssets()));
  assert.equal(firstLine(plainOf(back.rows[0]).visual), TAGGED_LINE);
  for (const name of Object.values(TAGS)) assert.ok(back.rows[0].visualText.includes(name), name);
  assert.doesNotMatch(JSON.stringify(back.rows), /tag-anchor|data-tag/);
  assert.deepEqual(Object.keys(back).sort(), ["looseText", "rows", "title"]);
});

test("comments are dropped: no comment word, author or reply comes back, and the anchored words stay plain", async () => {
  loadFixture();
  const back = await reread(buildDocx(...liveWithAssets()));
  const all = JSON.stringify(back);
  for (const word of ["Zoë", "Ünal", "Bjørn", "check", "Done", "Resolved note", "Comments"]) assert.equal(all.includes(word), false, word);
  assert.equal(plainOf(back.rows[0]).audio.split("\n")[1], "and anchored words follow.");
  assert.doesNotMatch(all, /cmt-anchor|data-cmt/);
});

test("the pictures come back as the same pictures on the same rows; picture-only rows stay; others have none", async () => {
  loadFixture();
  const back = await reread(buildDocx(...liveWithAssets()));
  const original = scriptRows().filter(hasContent);
  assert.deepEqual(back.rows.map(sha), original.map(sha));
  assert.equal(sha(back.rows[0]), PICTURES.first.sha256);
  assert.deepEqual([back.rows[0].imageRef.width, back.rows[0].imageRef.height], [300, 200]);
  const pictureOnly = back.rows.find((r) => sha(r) === PICTURES.second.sha256);
  assert.deepEqual(plainOf(pictureOnly), { visual: "", audio: "" });
  assert.equal(back.rows.filter((r) => r.imageRef).length, 3);
});

test("the narration keeps only the audio: no pictures, no visual text, and rows with no audio are dropped", async () => {
  loadFixture();
  const bytes = buildNarrationDocx(liveDoc(), { directions: true });
  const back = await reread(bytes);
  const audio = scriptRows().map(plainOf).filter((r) => r.audio);
  assert.deepEqual(back.rows.map(plainOf), audio.map((r) => ({ visual: "", audio: r.audio })));
  assert.ok(back.rows.every((r) => r.imageRef === null));
  const zip = await zipRead(bytes.buffer);
  assert.ok(!zip.names.some((n) => n.startsWith("word/media/")), "the narration carries no pictures");
});
