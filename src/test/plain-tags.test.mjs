import { TAG_CATEGORIES } from "../core/production/looks.ts";
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readBuiltCss } from "../../tools/css-colours.mjs";
import { fromHtml, namedTagId, projection, toHtml } from "../js/04c-doc-model.js";
import {
  PLAIN_TAG_KEYWORDS,
  applyPlainTag,
  matchPlainTagKeyword,
  plainTagPhrase
} from "../js/07b-plain-tags.js";

const cat = (s) => (matchPlainTagKeyword(s) || {}).cat || null;
const ZW = String.fromCharCode(0x200B), NB = String.fromCharCode(0xA0), OBJ = String.fromCharCode(0xFFFC);

test("every name, and only those names, is a keyword", () => {
  assert.deepEqual(PLAIN_TAG_KEYWORDS, {
    prop: "prop", location: "location", loc: "location", cast: "cast",
    vfx: "vfx", gear: "gear", sfx: "sound", music: "sound"
  });
  assert.equal(cat("Prop:"), "prop");
  assert.equal(cat("Location:"), "location");
  assert.equal(cat("Loc:"), "location");
  assert.equal(cat("Cast:"), "cast");
  assert.equal(cat("VFX:"), "vfx");
  assert.equal(cat("Gear:"), "gear");
  assert.equal(cat("SFX:"), "sound");
  assert.equal(cat("Music:"), "sound");
  const reached = new Set(Object.values(PLAIN_TAG_KEYWORDS));
  assert.deepEqual([...reached].sort(), TAG_CATEGORIES.map((c) => c.id).sort());
  for (const s of ["Sound:", "Props:", "Locat:", "Locations:", "L:", "V:", "FX:", "Visual:",
    "Audio:", "B-roll:", "Graphics:", "Wardrobe:", "Kit:", "Equipment:", "Actor:"]) {
    assert.equal(matchPlainTagKeyword(s), null, s);
  }
});

test("any case", () => {
  for (const s of ["vfx:", "Vfx:", "VFX:", "vFx:", "loc:", "LOC:", "Loc:", "PROP:", "prop:",
    "location:", "LOCATION:", "cast:", "CAST:", "gear:", "GEAR:", "sfx:", "Sfx:", "music:", "MUSIC:"]) {
    assert.ok(matchPlainTagKeyword(s), s);
  }
  assert.equal(matchPlainTagKeyword("vfx:").keyword, "vfx:");
  assert.equal(matchPlainTagKeyword("Shot VfX:").keyword, "VfX:");
  assert.equal(matchPlainTagKeyword("Shot VfX:").length, 4);
});

test("the colon is what triggers it, typed last, straight after the name", () => {
  assert.equal(matchPlainTagKeyword("VFX"), null);
  assert.equal(matchPlainTagKeyword("VFX :"), null);
  assert.equal(matchPlainTagKeyword("VFX: "), null);
  assert.equal(matchPlainTagKeyword("VFX: flare"), null);
  assert.equal(matchPlainTagKeyword("VFX;"), null);
  assert.equal(matchPlainTagKeyword(""), null);
  assert.equal(matchPlainTagKeyword(null), null);
});

test("a word of its own: never the end of a longer word", () => {
  for (const s of ["myVFX:", "2VFX:", "ÄVFX:", "propProp:", "Blocation:", "xloc:", "Podcast:", "broadcast:",
    "nomusic:", "résumévfx:", "日本vfx:"]) {
    assert.equal(matchPlainTagKeyword(s), null, s);
  }
  for (const s of ["VFX:", " VFX:", "Shot 4 VFX:", "(VFX:", "—VFX:", "\nVFX:", "a.VFX:", NB + "VFX:",
    OBJ + "VFX:", "-Prop:", "\"Cast:", "Music/SFX:"]) {
    assert.ok(matchPlainTagKeyword(s), JSON.stringify(s));
  }
  assert.equal(matchPlainTagKeyword("Location:").length, 9);
  assert.equal(matchPlainTagKeyword("Loc:").length, 4);
});

test("what Tab wraps: the words, the spaces either side left out", () => {
  assert.deepEqual(plainTagPhrase(" lens flare sweeps across the logo"),
    { lead: 1, text: "lens flare sweeps across the logo", trail: 0, name: "lens flare sweeps across the logo" });
  assert.deepEqual(plainTagPhrase(ZW + " lens flare  "), { lead: 1, text: "lens flare", trail: 2, name: "lens flare" });
  assert.deepEqual(plainTagPhrase("flare"), { lead: 0, text: "flare", trail: 0, name: "flare" });
  assert.deepEqual(plainTagPhrase(NB + "lens" + NB + " flare" + NB), { lead: 1, text: "lens" + NB + " flare", trail: 1, name: "lens flare" });
  assert.equal(plainTagPhrase(""), null);
  assert.equal(plainTagPhrase("   "), null);
  assert.equal(plainTagPhrase(ZW), null);
  assert.equal(plainTagPhrase(ZW + " " + NB), null);
  for (const invisible of ["‌", "‍", "⁠", "­", " ‍⁠­ "]) {
    assert.equal(plainTagPhrase(invisible), null, JSON.stringify(invisible) + " alone names nothing (#298)");
  }
  assert.equal(plainTagPhrase("!!").name, "!!");
  const long = "a".repeat(50) + " " + "b".repeat(50);
  const p = plainTagPhrase(" " + long);
  assert.equal(p.text, long);
  assert.equal(p.name.length, 80);
  assert.equal(p.name, long.slice(0, 80));
});

function tagAt(html, word, catId) {
  const cell = fromHtml(html);
  const text = projection(cell);
  const from = text.indexOf(word);
  return { cell, from, to: text.length, res: applyPlainTag(cell, from, text.length, catId) };
}

test("the Tab edit: keyword gone, the words one tag, caret after it", () => {
  const { res } = tagAt("Shot 4 VFX: lens flare sweeps across the logo", "VFX:", "vfx");
  assert.equal(toHtml(res.cell),
    'Shot 4 <span class="tag-anchor" data-tag-cat="vfx" data-tag-name="lens flare sweeps across the logo" contenteditable="false">lens flare sweeps across the logo</span>');
  assert.equal(res.name, "lens flare sweeps across the logo");
  assert.equal(res.caret, projection(res.cell).length);
});

test("a space typed before Tab stays after the tag, the caret after it", () => {
  const { res } = tagAt("VFX: flare ", "VFX:", "vfx");
  assert.equal(projection(res.cell), "flare" + NB);
  assert.equal(res.caret, 6);
  assert.match(toHtml(res.cell), /<\/span>&nbsp;$/);
  const nb = tagAt("VFX: flare&nbsp;", "VFX:", "vfx").res;
  assert.match(toHtml(nb.cell), /<\/span>&nbsp;$/);
  const cell = fromHtml("VFX: flare more");
  const mid = applyPlainTag(cell, 0, 11, "vfx");
  assert.equal(projection(mid.cell), "flare more");
  assert.equal(mid.caret, 6);
});

test("the same mark the other routes put on, for every category and name", () => {
  const names = { Prop: "prop", Location: "location", Loc: "location", Cast: "cast", VFX: "vfx",
    Gear: "gear", SFX: "sound", Music: "sound", music: "sound", loc: "location" };
  for (const [kw, id] of Object.entries(names)) {
    const { res } = tagAt("x " + kw + ": red mug", kw + ":", id);
    assert.ok(res, kw);
    const expected = fromHtml("x red mug");
    const run = res.cell.find((r) => r.marks && r.marks.tag);
    assert.equal(run.text, "red mug", kw);
    assert.equal(run.marks.tag, namedTagId(id, "red mug"), kw);
    assert.equal(projection(res.cell), projection(expected), kw);
    assert.match(toHtml(res.cell), new RegExp('data-tag-cat="' + id + '"'), kw);
  }
});

test("formatting the words were typed in stays on the tag", () => {
  const cell = fromHtml("<strong>VFX: big flare</strong> after");
  const res = applyPlainTag(cell, 0, projection(cell).indexOf(" after"), "vfx");
  assert.equal(toHtml(res.cell),
    '<span class="tag-anchor" data-tag-cat="vfx" data-tag-name="big flare" contenteditable="false"><strong>big flare</strong></span> after');
});

test("a name given (an item already tracked) is used, the words keep their casing", () => {
  const cell = fromHtml("Prop: Red Mug");
  const res = applyPlainTag(cell, 0, 13, "prop", "red mug");
  assert.match(toHtml(res.cell), /data-tag-name="red mug"[^>]*>Red Mug</);
  assert.equal(res.name, "red mug");
});

test("refused when the words there are not a keyword of that category and something after it", () => {
  assert.equal(tagAt("VFX:", "VFX:", "vfx").res, null);
  assert.equal(tagAt("VFX:   ", "VFX:", "vfx").res, null);
  assert.equal(tagAt("VFX: flare", "VFX:", "prop").res, null);
  assert.equal(tagAt("myVFX: flare", "myVFX:", "vfx").res, null);
  assert.equal(tagAt("Sound: boom", "Sound:", "sound").res, null);
  assert.equal(tagAt("lens flare", "lens", "vfx").res, null);
  const { res } = tagAt("VFX: title: Intro", "VFX:", "vfx");
  assert.equal(res.cell.find((r) => r.marks && r.marks.tag).text, "title: Intro");
});

test("the open tag is painted for every category (app.css)", () => {
  const { css } = readBuiltCss();
  assert.match(css, /\.plain-tag-keyword\s*\{\s*display:\s*none;/);
  for (const c of TAG_CATEGORIES) {
    const at = css.indexOf("::highlight(splitpage-open-tag-" + c.id + ")");
    assert.notEqual(at, -1, "no open-tag highlight for " + c.id);
    const body = css.slice(at, css.indexOf("}", at));
    assert.ok(body.includes("var(--tag-" + c.id + "-tint)") && body.includes("var(--tag-" + c.id + ")"), c.id);
  }
});
