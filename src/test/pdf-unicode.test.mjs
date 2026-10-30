import "./_dom.mjs";
import "./_export-services-started.mjs";
import { liveDoc } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { mountProductionTagsFeature as initTags } from "../bootstrap/wiring/production-tags.ts";
import { buildPackingListPdf, buildPdf, pdfTextOp, pdfTextWidth, withUnshownCount } from "../adapters/formats/pdf.ts";
import { loadPdfFonts } from "../adapters/formats/pdf-unicode.ts";
import { parseTrueType } from "../adapters/formats/truetype.ts";
import { loadTestDocument } from "./_document.mjs";
import { wireRegistries } from "./_registries.mjs";

initTags();
const fonts = await loadPdfFonts();

const raw = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

function load(visual, audio, title) {
  loadTestDocument(migrateRows({
    schema: 2, title: title || "Text", comments: [],
    rows: [{ id: "r0", visualText: visual, audioText: audio, status: "todo" }]
  }));
}

function pdfFor(visual, audio, title, withFonts = fonts) {
  load(visual, audio, title);
  return withUnshownCount(() => buildPdf(liveDoc(), null), withFonts);
}

function gidHex(font, text) {
  return Array.from(text, (ch) => ("000" + font.font.glyphFor(ch.codePointAt(0)).toString(16).toUpperCase()).slice(-4)).join("");
}

function fontObjects(t) {
  return Array.from(t.matchAll(/<< \/Type \/Font \/Subtype \/Type0 \/BaseFont \/([A-Z]{6})\+([\w-]+) /g), (m) => m[2]);
}

function opsOf(str, font, withFonts = fonts) {
  return withUnshownCount(() => pdfTextOp(str, 10, 20, font, 10), withFonts);
}

test("the three fonts load and cover Latin, Greek, Cyrillic and emoji", () => {
  assert.ok(fonts, "fonts loaded");
  for (const ch of "ŁŐŘĞ") assert.ok(fonts.regular.font.glyphFor(ch.codePointAt(0)), "regular " + ch);
  for (const ch of "ΑΩαω") assert.ok(fonts.regular.font.glyphFor(ch.codePointAt(0)), "Greek " + ch);
  for (const ch of "ЖЯжя") assert.ok(fonts.bold.font.glyphFor(ch.codePointAt(0)), "bold Cyrillic " + ch);
  for (const ch of ["😀", "🎬", "👍"]) assert.ok(fonts.emoji.font.glyphFor(ch.codePointAt(0)), "emoji " + ch);
  assert.equal(fonts.regular.font.glyphFor(0x4F60), 0, "no CJK in the bundled fonts");
});

test("a Cyrillic line is written in an embedded Type0 font with ToUnicode and widths", () => {
  const made = pdfFor("Привет", "plain");
  const t = raw(made.value);
  assert.equal(made.unshown, 0);
  assert.deepEqual(fontObjects(t), ["NotoSans-Regular"]);
  assert.ok(t.includes("/Encoding /Identity-H"), "Identity-H");
  assert.ok(t.includes("/Subtype /CIDFontType2"), "CIDFontType2");
  assert.ok(t.includes("/CIDToGIDMap /Identity"), "CIDToGIDMap");
  assert.match(t, /\/FontFile2 \d+ 0 R/);
  assert.match(t, /\/U1 \d+ 0 R/, "page resource");
  assert.ok(t.includes("<" + gidHex(fonts.regular, "Привет") + "> Tj"), "glyph ids written");
  const pe = fonts.regular.font.glyphFor("П".codePointAt(0));
  assert.ok(t.includes(pe + " [" + fonts.regular.width(pe) + "]"), "width entry for П");
  const hex = ("000" + pe.toString(16).toUpperCase()).slice(-4);
  assert.ok(t.includes("<" + hex + "> <041F>"), "ToUnicode maps П back");
});

test("a Greek line in bold uses the bold font", () => {
  const made = pdfFor("<b>Καλημέρα</b>", "plain");
  const t = raw(made.value);
  assert.equal(made.unshown, 0);
  assert.deepEqual(fontObjects(t), ["NotoSans-Bold"]);
  assert.ok(t.includes("<" + gidHex(fonts.bold, "Καλημέρα") + "> Tj"));
});

test("italic text outside Windows-1252 is slanted like Helvetica-Oblique", () => {
  const op = opsOf("Курсив", "F3").value;
  assert.match(op, /^BT \/U1 10 Tf 1 0 0\.2126 1 10\.00 20\.00 Tm <[0-9A-F]+> Tj ET$/);
});

test("a mixed line switches fonts and places each piece by the widths it measured", () => {
  const op = opsOf("Hi Мир!", "F1").value;
  const parts = op.split(" ET").filter(Boolean).map((p) => p.trim());
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^BT \/F1 10 Tf 1 0 0 1 10\.00 20\.00 Tm \(Hi \) Tj$/);
  const x2 = (10 + pdfTextWidth("Hi ", false, 10)).toFixed(2);
  assert.ok(parts[1].startsWith("BT /U1 10 Tf 1 0 0 1 " + x2 + " 20.00 Tm <"), parts[1]);
  const x3 = (10 + withUnshownCount(() => pdfTextWidth("Hi Мир", false, 10), fonts).value).toFixed(2);
  assert.ok(parts[2].startsWith("BT /F1 10 Tf 1 0 0 1 " + x3 + " 20.00 Tm (!) Tj"), parts[2]);
});

test("widths outside Windows-1252 come from the font's advance widths", () => {
  const width = withUnshownCount(() => pdfTextWidth("Жж", false, 1000), fonts).value;
  const zh = fonts.regular.font.glyphFor(0x416), zl = fonts.regular.font.glyphFor(0x436);
  assert.equal(width, fonts.regular.width(zh) + fonts.regular.width(zl));
  assert.equal(pdfTextWidth("Жж", false, 1000), 1112, "without fonts each is a ? as before");
});

test("emoji are drawn from the emoji font; selectors, joiners and skin tones are dropped", () => {
  const made = opsOf("👍🏽 ❤️ 🎬", "F1");
  assert.equal(made.unshown, 0);
  assert.ok(made.value.includes("/U3 10 Tf"), "emoji font");
  assert.ok(made.value.includes("<" + gidHex(fonts.emoji, "👍") + ">"), "thumbs up without its skin tone");
  assert.ok(made.value.includes("<" + gidHex(fonts.emoji, "❤") + ">"), "heart without VS16");
  const pdf = raw(pdfFor("Shoot 🎬 today", "😀").value);
  assert.deepEqual(fontObjects(pdf).sort(), ["NotoEmoji-Regular"]);
});

test("the euro sign and other Windows-1252 text stay on Helvetica", () => {
  const op = opsOf("Price €5 – “quoted”", "F1").value;
  assert.equal(op, "BT /F1 10 Tf 1 0 0 1 10.00 20.00 Tm (Price \x805 \x96 \x93quoted\x94) Tj ET");
});

test("a Latin-only PDF is byte for byte the same with and without the fonts", () => {
  const visual = "Café “quoted” — fine, Zoë’s €5", audio = "<b>Bold</b> <i>italic</i> plain ½ ©";
  const withFonts = pdfFor(visual, audio, "Title €");
  const without = pdfFor(visual, audio, "Title €", null);
  assert.deepEqual(Array.from(withFonts.value), Array.from(without.value));
  assert.deepEqual(fontObjects(raw(withFonts.value)), []);
});

test("CJK is still shown as ? and counted, next to embedded Cyrillic", () => {
  const made = pdfFor("Привет 你好", "日本");
  const t = raw(made.value);
  assert.equal(made.unshown, 4);
  assert.ok(t.includes("(??)"), "CJK as ?");
  assert.deepEqual(fontObjects(t), ["NotoSans-Regular"]);
});

test("a character no font has falls back to ? and the diagnostic, even inside a covered run", () => {
  const made = opsOf("Ж你Ж", "F1");
  assert.equal(made.unshown, 1);
  assert.ok(made.value.includes("Tm (?) Tj"), made.value);
});

test("each subset holds only the glyphs used", () => {
  const t = raw(pdfFor("Да", "plain").value);
  const m = /\/Length (\d+) \/Length1 \d+ >>\nstream\n/.exec(t);
  assert.ok(m, "font file stream");
  const start = m.index + m[0].length;
  const file = Uint8Array.from(t.slice(start, start + Number(m[1])), (c) => c.charCodeAt(0));
  const sub = parseTrueType(file);
  const used = ["Д", "а"].map((ch) => fonts.regular.font.glyphFor(ch.codePointAt(0)));
  assert.equal(sub.numGlyphs, Math.max(...used) + 1);
  assert.ok(file.length < 20000, "subset is small: " + file.length);
});

test("packing lists embed fonts too", () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "Съёмка", comments: [],
    rows: [{ id: "r0", visualText: "Камера", audioText: "", status: "todo" }]
  }));
  const made = withUnshownCount(() => buildPackingListPdf(liveDoc(), "gear"), fonts);
  assert.equal(made.unshown, 0);
  assert.ok(fontObjects(raw(made.value)).includes("NotoSans-Regular") || fontObjects(raw(made.value)).includes("NotoSans-Bold"));
});

test("the PDF exporter loads the fonts and reports only what is still not shown", async () => {
  const registries = wireRegistries();
  try {
    const assets = { shas: [], missing: [], picture: () => null };
    load("Привет Ελληνικά 😀", "你好");
    const built = await registries.exports.byId("pdf").build({ doc: liveDoc(), options: {}, assets, ports: {} }, "script");
    assert.deepEqual(built.diagnostics, { imagesLeftOut: 0, unshownCharacters: 2 });
    assert.deepEqual(fontObjects(raw(built.data)).sort(), ["NotoEmoji-Regular", "NotoSans-Regular"]);
  } finally { registries.dispose(); }
});
