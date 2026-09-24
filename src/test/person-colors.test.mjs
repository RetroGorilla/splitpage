/* A person's colour (#192, #194): the eight colours, how a name gets one
 * (your pick, then presence, then the document's map, then the hash), and
 * the document's name → colour map through migrateRows, mergeStates and
 * both project formats — an older file without the map reading and saving
 * exactly as it did.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  PERSON_COLORS,
  PERSON_COLOR_NAMES,
  hashedPersonColor,
  mergePersonColors,
  normalizePersonColors,
  paletteColor,
  resolvePersonColor
} from "../js/00p-prefs.js";
import { S } from "../js/_state.js";
import { STATE_FIELDS, migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { buildSplitpageFile, parseSplitpageFile, buildMarkdownProject, parseMarkdownProject } from "../js/20d-formats.js";

const [BLUE, AMBER, VIOLET, GREEN] = PERSON_COLORS;

test("eight colours, each with a name", () => {
  assert.equal(PERSON_COLORS.length, 8);
  assert.equal(PERSON_COLOR_NAMES.length, 8);
  assert.equal(new Set(PERSON_COLORS).size, 8);
});

test("paletteColor takes the eight and nothing else", () => {
  assert.equal(paletteColor("#80bdfb"), BLUE);
  assert.equal(paletteColor(" #80BDFB "), BLUE);
  assert.equal(paletteColor("#123456"), "");
  assert.equal(paletteColor("red"), "");
  assert.equal(paletteColor("var(--x)"), "");
  assert.equal(paletteColor({}), "");
  assert.equal(paletteColor(null), "");
});

test("the hash is today's colour: stable, and one of the eight", () => {
  assert.equal(hashedPersonColor("Adam"), hashedPersonColor("Adam"));
  assert.ok(PERSON_COLORS.includes(hashedPersonColor("Adam")));
  assert.ok(PERSON_COLORS.includes(hashedPersonColor("")));
  /* the exact function the app shipped before #194, so nobody who never
     picks changes colour */
  const old = (seed) => {
    seed = String(seed || "");
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    return PERSON_COLORS[Math.abs(h) % PERSON_COLORS.length];
  };
  for (const n of ["Adam", "Priya Malhotra", "Jordan", "", "Guest", "p1abc"]) assert.equal(hashedPersonColor(n), old(n));
});

test("resolution: your pick, then presence, then the document, then the hash", () => {
  const name = "Priya";
  const hashed = hashedPersonColor(name);
  const other = PERSON_COLORS.find((c) => c !== hashed);
  const third = PERSON_COLORS.find((c) => c !== hashed && c !== other);
  const fourth = PERSON_COLORS.find((c) => c !== hashed && c !== other && c !== third);
  /* nothing known: the hash */
  assert.equal(resolvePersonColor(name, {}), hashed);
  assert.equal(resolvePersonColor(name), hashed);
  /* the document's map */
  assert.equal(resolvePersonColor(name, { doc: { Priya: other } }), other);
  /* ...matched however the name is cased or padded */
  assert.equal(resolvePersonColor("  priya ", { doc: { Priya: other } }), other);
  /* presence beats the document */
  assert.equal(resolvePersonColor(name, { doc: { Priya: other }, live: { priya: third } }), third);
  /* your own pick beats both, for your name only */
  assert.equal(resolvePersonColor(name, { self: "PRIYA", selfColor: fourth, doc: { Priya: other }, live: { priya: third } }), fourth);
  assert.equal(resolvePersonColor("Sam", { self: "Priya", selfColor: fourth }), hashedPersonColor("Sam"));
  /* garbage anywhere is no colour, and falls through */
  assert.equal(resolvePersonColor(name, { self: name, selfColor: "#000000", live: { priya: "red" }, doc: { Priya: "x" } }), hashed);
  /* an empty name never takes anybody's pick */
  assert.equal(resolvePersonColor("", { self: "", selfColor: fourth }), hashedPersonColor(""));
});

test("normalizePersonColors: names and the eight colours only", () => {
  assert.equal(normalizePersonColors(null), null);
  assert.equal(normalizePersonColors([]), null);
  assert.equal(normalizePersonColors("Adam"), null);
  assert.equal(normalizePersonColors({}), null);
  assert.equal(normalizePersonColors({ Adam: "#000000" }), null);
  const raw = JSON.parse('{"Adam":"#80bdfb","  Priya  ":"#F9B64F","":"#CBA1FA","__proto__":"#80BDFB","adam":"#73D4AC","Bo":"nope"}');
  const out = normalizePersonColors(raw);
  assert.deepEqual(out, { Adam: BLUE, Priya: AMBER });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  /* long names cut, and at most 200 people */
  const long = normalizePersonColors({ ["x".repeat(200)]: BLUE });
  assert.equal(Object.keys(long)[0].length, 80);
  const many = {};
  for (let i = 0; i < 300; i++) many["p" + i] = BLUE;
  assert.equal(Object.keys(normalizePersonColors(many)).length, 200);
});

test("mergePersonColors: per name, the side that changed it wins", () => {
  /* no map anywhere stays no map */
  assert.equal(mergePersonColors(null, null, null), null);
  assert.equal(mergePersonColors(undefined, {}, undefined), null);
  /* each side's own people kept */
  assert.deepEqual(mergePersonColors(null, { Adam: BLUE }, { Priya: AMBER }), { Adam: BLUE, Priya: AMBER });
  /* theirs changed Adam, mine did not: theirs */
  assert.deepEqual(mergePersonColors({ Adam: BLUE }, { Adam: BLUE }, { Adam: GREEN }), { Adam: GREEN });
  /* mine changed him, theirs did not: mine */
  assert.deepEqual(mergePersonColors({ Adam: BLUE }, { Adam: VIOLET }, { Adam: BLUE }), { Adam: VIOLET });
  /* both changed him: mine */
  assert.deepEqual(mergePersonColors({ Adam: BLUE }, { Adam: VIOLET }, { Adam: GREEN }), { Adam: VIOLET });
  /* no base: mine */
  assert.deepEqual(mergePersonColors(null, { Adam: VIOLET }, { Adam: GREEN }), { Adam: VIOLET });
  /* one name spelt two ways is one person */
  const m = mergePersonColors({ adam: BLUE }, { Adam: BLUE }, { ADAM: GREEN });
  assert.equal(Object.keys(m).length, 1);
  assert.equal(Object.values(m)[0], GREEN);
  /* nobody's colour is ever dropped by a merge */
  assert.deepEqual(mergePersonColors({ Adam: BLUE, Priya: AMBER }, { Adam: BLUE }, {}), { Adam: BLUE, Priya: AMBER });
});

test("the registry knows the field, with no default", () => {
  const f = STATE_FIELDS.find((x) => x.key === "personColors");
  assert.ok(f);
  assert.equal(f.merge, "person-colors");
  assert.equal(f.def, undefined);
});

test("migrateRows: an old document grows no key; a map is cleaned", () => {
  assert.equal("personColors" in migrateRows({ title: "Old", rows: [] }), false);
  assert.equal("personColors" in migrateRows({ title: "Old", rows: [], personColors: { Adam: "bad" } }), false);
  const s = migrateRows({ title: "New", rows: [], personColors: { Adam: "#80bdfb", Bo: "red" } });
  assert.deepEqual(s.personColors, { Adam: BLUE });
  /* twice changes nothing */
  assert.deepEqual(migrateRows(JSON.parse(JSON.stringify(s))).personColors, { Adam: BLUE });
});

test("mergeStates carries the map, and leaves it out when nobody picked", () => {
  const doc = (pc) => migrateRows({ title: "T", rows: [{ id: "r1", audioText: "a" }], personColors: pc });
  assert.equal("personColors" in mergeStates(doc(), doc(), doc()).merged, false);
  const merged = mergeStates(doc({ Adam: BLUE }), doc({ Adam: BLUE, Priya: AMBER }), doc({ Adam: GREEN })).merged;
  assert.deepEqual(merged.personColors, { Adam: GREEN, Priya: AMBER });
  /* a two-way merge with an older copy that has no map keeps ours */
  const two = mergeStates(null, doc({ Adam: VIOLET }), doc()).merged;
  assert.deepEqual(two.personColors, { Adam: VIOLET });
});

test("both project formats round-trip the map, and an old file still has none", () => {
  const withMap = migrateRows({ title: "T", rows: [{ id: "r1", audioText: "words" }], personColors: { Adam: BLUE, "Priya M": AMBER } });
  const back = migrateRows(parseSplitpageFile(buildSplitpageFile(withMap)));
  assert.deepEqual(back.personColors, { Adam: BLUE, "Priya M": AMBER });
  const without = migrateRows({ title: "T", rows: [{ id: "r1", audioText: "words" }] });
  const text = buildSplitpageFile(without);
  assert.equal(text.indexOf("personColors"), -1);
  assert.equal("personColors" in migrateRows(parseSplitpageFile(text)), false);
  /* the .md writer reads the document on screen for its table */
  const md = (s) => { const was = S.state; S.state = s; try { return buildMarkdownProject(s); } finally { S.state = was; } };
  const fromMd = parseMarkdownProject(md(withMap));
  assert.ok(fromMd);
  assert.deepEqual(fromMd.state.personColors, { Adam: BLUE, "Priya M": AMBER });
  const oldMd = parseMarkdownProject(md(without));
  assert.equal("personColors" in oldMd.state, false);
});
