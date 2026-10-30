import "./_dom.mjs";
import "./_export-services-started.mjs";
import { liveDoc } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { mountProductionTagsFeature as initTags } from "../bootstrap/wiring/production-tags.ts";
import { buildPdf, pdfEscapeText, pdfTextWidth, withUnshownCount } from "../adapters/formats/pdf.ts";
import { loadTestDocument } from "./_document.mjs";
import { wireRegistries } from "./_registries.mjs";

initTags();

const BLOCK = [
  [128, "€", 556, 556], [130, "‚", 222, 278], [131, "ƒ", 556, 556], [132, "„", 333, 500],
  [133, "…", 1000, 1000], [134, "†", 556, 556], [135, "‡", 556, 556], [136, "ˆ", 333, 333],
  [137, "‰", 1000, 1000], [138, "Š", 667, 667], [139, "‹", 333, 333], [140, "Œ", 1000, 1000],
  [142, "Ž", 611, 611], [145, "‘", 222, 278], [146, "’", 222, 278], [147, "“", 333, 500],
  [148, "”", 333, 500], [149, "•", 350, 350], [150, "–", 556, 556], [151, "—", 1000, 1000],
  [152, "˜", 333, 333], [153, "™", 1000, 1000], [154, "š", 500, 556], [155, "›", 333, 333],
  [156, "œ", 944, 944], [158, "ž", 500, 500], [159, "Ÿ", 667, 667]
];

const bytesOf = (s) => Array.from(s, (c) => c.charCodeAt(0));
const raw = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

function pdfFor(visual, audio, title) {
  loadTestDocument(migrateRows({
    schema: 2, title: title || "Text", comments: [],
    rows: [{ id: "r0", visualText: visual, audioText: audio, status: "todo" }]
  }));
  return withUnshownCount(() => buildPdf(liveDoc(), null));
}

test("every Windows-1252 character in 0x80-0x9F is written as its own byte", () => {
  for (const [code, ch] of BLOCK) assert.deepEqual(bytesOf(pdfEscapeText(ch)), [code], ch);
});

test("every mapped character has the Adobe Helvetica width, regular and bold", () => {
  for (const [, ch, regular, bold] of BLOCK) {
    assert.equal(pdfTextWidth(ch, false, 1000), regular, "regular " + ch);
    assert.equal(pdfTextWidth(ch, true, 1000), bold, "bold " + ch);
  }
});

test("text width follows the bytes written", () => {
  const byWidth = new Map(BLOCK.map(([code, , regular, bold]) => [code, [regular, bold]]));
  const text = "Price €5 – “quoted” … ™";
  for (const bold of [false, true]) {
    const written = bytesOf(pdfEscapeText(text));
    let expected = 0;
    for (const code of written) {
      const known = byWidth.get(code);
      expected += known ? known[bold ? 1 : 0] : pdfTextWidth(String.fromCharCode(code), bold, 1000);
    }
    assert.equal(pdfTextWidth(text, bold, 1000), expected);
  }
  assert.equal(pdfTextWidth("€€", false, 10), 11.12);
});

test("the euro sign is encoded and not counted as unshown", () => {
  assert.equal(pdfEscapeText("€"), "\x80");
  assert.equal(withUnshownCount(() => pdfEscapeText("€ 5")).unshown, 0);
});

test("characters outside the encoding become ? and are counted once each", () => {
  const made = withUnshownCount(() => pdfEscapeText("Привет 你好 ł 😀 ? \t end"));
  assert.equal(made.value, "?????? ?? ? ?? ? ? end");
  assert.equal(made.unshown, 6 + 2 + 1 + 1);
});

test("the count starts again with each build", () => {
  assert.equal(withUnshownCount(() => pdfEscapeText("日本")).unshown, 2);
  assert.equal(withUnshownCount(() => pdfEscapeText("plain")).unshown, 0);
});

test("a script with a euro sign, Cyrillic and CJK writes bytes, ? and a count", () => {
  const made = pdfFor("Price €5", "Привет 你好");
  const t = raw(made.value);
  assert.ok(t.includes("(Price)"), "ascii word");
  assert.ok(t.includes("(\x805)"), "euro byte");
  assert.ok(t.includes("(??????)"), "Cyrillic as ?");
  assert.ok(t.includes("(??)"), "CJK as ?");
  assert.equal(made.unshown, 8);
});

test("a script in Latin alone reports nothing", () => {
  const made = pdfFor("Café “quoted” — fine", "Zoë’s €5");
  const t = raw(made.value);
  assert.equal(made.unshown, 0);
  assert.ok(t.includes("(Caf\xE9)"), "e acute");
  assert.ok(t.includes("(\x93quoted\x94)"), "curly quotes");
  assert.ok(t.includes("(\x805)"), "euro");
  assert.ok(!t.includes("(?"), "no substitute");
});

test("the PDF exporter hands the count on as a diagnostic, and none when it is zero", async () => {
  const registries = wireRegistries();
  try {
    const assets = { shas: [], missing: [], picture: () => null };
    const build = (visual, audio) => {
      pdfFor(visual, audio);
      return registries.exports.byId("pdf").build({ doc: liveDoc(), options: {}, assets, ports: {} }, "script");
    };
    const shown = await build("Price €5", "Привет 你好");
    assert.deepEqual(shown.diagnostics, { imagesLeftOut: 0, unshownCharacters: 8 });
    const plain = await build("Price €5", "Hello");
    assert.deepEqual(plain.diagnostics, { imagesLeftOut: 0, unshownCharacters: 0 });
  } finally { registries.dispose(); }
});
