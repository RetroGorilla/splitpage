/* The two sheets people print and carry on a shoot day (17-pdf.js): a
 * category's packing list (buildPackingListPdf) and the b-roll page's
 * shot list (buildShotListPdf over brollShotListForPrint). Read back the
 * way the other PDF tests read them — the uncompressed content streams as
 * text, one operator a line — off the long demo (#215) for what the sheets
 * say about a real script, and off small made-up scripts for the edges: a
 * long title, long names and notes, an item no longer in the script, an
 * empty category, a list long enough to run onto more pages.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { __init as initBroll } from "../js/08c-broll.js";
import { __init as initBrollPanel, brollShotListForPrint } from "../js/08d-broll-panel.js";
import { TAG_PRINT_COLORS } from "../js/14-export.js";
import { PRINT_COLORS, exportDateText, sceneFacts } from "../js/14b-export-kit.js";
import { buildPackingListPdf, buildShotListPdf, pdfTextWidth } from "../js/17-pdf.js";
import { LONG_DEMO } from "../js/_starters.js";

initStatus();
initTags();
initBroll();

const PW = 612, M = 54;
const copy = (o) => JSON.parse(JSON.stringify(o));
const demo = () => { S.state = migrateRows(copy(LONG_DEMO.state)); };

/* PDF colour operands for "RRGGBB", as 17-pdf.js writes them */
const rgb = (hex) => [0, 2, 4].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
const C = PRINT_COLORS;

function pagesOf(bytes) {
  const t = new TextDecoder("latin1").decode(bytes);
  const out = [];
  const re = /obj\n<< \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(t))) out.push(t.substr(re.lastIndex, +m[1]));
  return out;
}

/* Every string drawn on a page: its face, size, place, words (unescaped;
   TextDecoder's "latin1" is windows-1252, so WinAnsi's curly quotes and
   dashes come back as themselves) and colour, when one was set. */
const TEXT_RE = /^(?:q ([\d.]+ [\d.]+ [\d.]+) rg )?BT \/(F\d) ([\d.]+) Tf 1 0 0 1 ([-\d.]+) ([-\d.]+) Tm \((.*)\) Tj ET(?: Q)?$/;
function textsOf(page) {
  return page.split("\n").map((op) => {
    const m = TEXT_RE.exec(op);
    return m && { rgb: m[1] || null, font: m[2], size: +m[3], x: +m[4], y: +m[5], str: m[6].replace(/\\([()\\])/g, "$1") };
  }).filter(Boolean);
}
const find = (texts, str) => texts.filter((t) => t.str === str);
const one = (texts, str) => {
  const all = find(texts, str);
  assert.equal(all.length, 1, JSON.stringify(str) + " drawn " + all.length + " times");
  return all[0];
};

/* the shot list's landscape page and margin */
const SPW = 792, SM = 36;

/* nothing drawn left of the margin or past the right one — the packing
   list's portrait page unless told the shot list's */
function assertInsideMargins(pages, pw = PW, m = M) {
  pages.forEach((page, i) => {
    textsOf(page).forEach((t) => {
      const w = pdfTextWidth(t.str, t.font === "F2" || t.font === "F4", t.size);
      assert.ok(t.x >= m - 0.01, "page " + (i + 1) + ": " + t.str + " starts at " + t.x);
      assert.ok(t.x + w <= pw - m + 0.01, "page " + (i + 1) + ": " + t.str + " runs to " + (t.x + w).toFixed(2));
    });
  });
}

/* each page's running footer: the title at the left, "Page n of N" at the
   right, 7.5pt and faint, over a hairline */
function assertFooters(pages, titleStart, m = M) {
  pages.forEach((page, i) => {
    const texts = textsOf(page);
    const right = one(texts, "Page " + (i + 1) + " of " + pages.length);
    assert.equal(right.size, 7.5);
    assert.equal(right.rgb, rgb(C.faint));
    const left = texts.filter((t) => t.size === 7.5 && t.x === m && t.y === right.y);
    assert.equal(left.length, 1, "page " + (i + 1) + ": the footer's title");
    assert.ok(left[0].str.startsWith(titleStart.slice(0, 20)), left[0].str);
  });
}

/* Each status pill on a page (packingPillOp: one operator line of four
   segments, each a filled or an outlined path), top to bottom: its
   baseline-ish y (the first segment's start), how many segments are
   filled and in what colour, and how many are left empty to fill in. */
function pillsOf(page, withKey) {
  return page.split("\n").filter((op) => (op.match(/ h [fS] Q/g) || []).length === 4).map((op) => {
    const fills = [...op.matchAll(/q ([\d.]+ [\d.]+ [\d.]+) rg [^Q]*? h f Q/g)].map((m) => m[1]);
    return {
      y: +/ ([-\d.]+) m /.exec(op)[1],
      filled: fills.length,
      fill: fills[0] || null,
      empty: (op.match(/ h S Q/g) || []).length,
      /* the first segment's height: its bottom edge's end, then up its
         square right side */
      height: (function (m) { return +(m[3] - m[1]).toFixed(2); })(/ ([-\d.]+) m [-\d.]+ ([-\d.]+) l [-\d.]+ ([-\d.]+) l /.exec(op))
    };
  /* the key's pill, every segment empty, is nobody's row */
  }).filter((p) => withKey || p.filled > 0);
}

/* ---- the packing list ---- */

test("the packing list: a kicker, the category large after its dot, the script and the day, and what is in hand", () => {
  demo();
  const pages = pagesOf(buildPackingListPdf("prop"));
  assert.equal(pages.length, 1);
  const texts = textsOf(pages[0]);

  const kicker = one(texts, "Packing list");
  assert.deepEqual([kicker.font, kicker.size, kicker.rgb], ["F1", 9, rgb(C.faint)]);
  const heading = one(texts, "Props & set dressing");
  assert.deepEqual([heading.font, heading.size, heading.rgb], ["F2", 20, rgb(C.text)]);
  assert.ok(heading.y < kicker.y);
  /* the dot before it, filled in the category's colour — the one place it is used */
  const dots = pages[0].split("\n").filter((op) => op.includes(rgb(TAG_PRINT_COLORS.prop)));
  assert.equal(dots.length, 1);
  assert.match(dots[0], / f Q$/);

  const meta = one(texts, LONG_DEMO.state.title + " · " + exportDateText());
  assert.deepEqual([meta.font, meta.size, meta.rgb], ["F1", 10.5, rgb(C.dim)]);
  const summary = one(texts, "6 items · 5 have it · 1 sourcing");
  assert.ok(summary.y < meta.y && summary.rgb === rgb(C.faint));

  /* the status pill's key, once, under the heading: an empty pill at full
     size with each level's name under its segment, and how to use it */
  const key = ["Needed", "Sourcing", "Have it", "Returned"].map((h) => one(texts, h));
  assert.ok(key.every((k) => k.y === key[0].y && k.size === 7.5 && k.rgb === rgb(C.dim)));
  assert.ok(key.every((k, i) => !i || k.x > key[i - 1].x), "in the order a thing gets packed");
  assert.ok(key[0].y < summary.y);
  const keyPill = pillsOf(pages[0], true)[0];
  assert.deepEqual([keyPill.filled, keyPill.empty, keyPill.height], [0, 4, 9]);
  assert.ok(keyPill.y > key[0].y, "the names under it");
  const hint = one(texts, "Fill in each step as it happens");
  assert.equal(hint.font, "F3");

  /* the column heads, in sentence case, on one line, under the key */
  const statusHeads = find(texts, "Status");
  assert.equal(statusHeads.length, 2, "the key's label and the column's head");
  const heads = ["Out", "Back", "Item", "Owner", "Scenes"].map((h) => one(texts, h));
  heads.splice(3, 0, statusHeads[1]);
  assert.ok(heads.every((h) => h.y === heads[0].y && h.size === 8.5 && h.rgb === rgb(C.dim)));
  assert.ok(heads.every((h, i) => !i || h.x > heads[i - 1].x), "left to right");
  assert.ok(heads[0].y < key[0].y);
  assert.ok(!texts.some((t) => t.str === t.str.toUpperCase() && /[A-Z]{3}/.test(t.str)), "nothing uppercased");
});

test("the packing list: a row per item, alphabetical, two boxes, the status as a pill to fill in, who has it, where", () => {
  demo();
  const page = pagesOf(buildPackingListPdf("prop"))[0];
  const texts = textsOf(page);
  const names = texts.filter((t) => t.font === "F2" && t.size === 11).map((t) => t.str);
  assert.deepEqual(names, ["button cell battery", "light seal kit", "naphtha", "Pentax K1000", "Portra 400", "toothpick"]);

  /* two boxes a row, "Out" and "Back", unticked, in the faint grey */
  const ops = page.split("\n");
  const boxes = ops.filter((op) => op.startsWith("q " + rgb(C.faint) + " RG 0.9 w ") && / l /.test(op));
  assert.equal(boxes.length, 12);
  assert.ok(!ops.some((op) => op.includes(rgb(C.broll) + " RG")), "no box is ticked");

  const row = (name) => {
    const n = one(texts, name);
    return texts.filter((t) => t.y === n.y && t.str !== name);
  };
  /* no status word — it would go stale the moment the sheet is in a hand */
  const battery = row("button cell battery");
  assert.deepEqual(battery.map((t) => t.str), ["Sam", "13"]);
  assert.equal(battery[0].rgb, rgb(C.text));
  assert.equal(battery[1].rgb, rgb(C.dim));
  assert.deepEqual(row("Pentax K1000").map((t) => t.str), ["Sam", "01, 28"]);
  /* nobody has it: nothing printed there, room to write a name in */
  assert.deepEqual(row("naphtha").map((t) => t.str), ["05"]);
  /* a pill a row, half the key's size, filled up to its level: Sourcing
     two segments in amber (not in hand yet), Have it three in the dim
     text colour, the rest outlined to fill in by hand */
  const pills = pillsOf(page);
  assert.equal(pills.length, 6);
  assert.deepEqual([pills[0].filled, pills[0].fill, pills[0].empty], [2, rgb(C.audio), 2]);
  pills.slice(1).forEach((p) => assert.deepEqual([p.filled, p.fill, p.empty], [3, rgb(C.dim), 1]));
  assert.ok(pills.every((p) => p.height === 5));
  /* each on its row */
  assert.ok(Math.abs(pills[0].y - (one(texts, "button cell battery").y + 1.5)) < 0.01);

  /* the notes under the name, small and dim */
  const note = one(texts, "SR44 silver oxide.");
  assert.deepEqual([note.font, note.size, note.rgb], ["F1", 9, rgb(C.dim)]);
  assert.equal(note.x, one(texts, "button cell battery").x);
  assert.ok(note.y < one(texts, "button cell battery").y);
});

test("the packing list ends with lines to sign, and a footer; the gear list is the same sheet", () => {
  demo();
  for (const [id, plural] of [["prop", "Props & set dressing"], ["gear", "Gear"]]) {
    const pages = pagesOf(buildPackingListPdf(id));
    const texts = textsOf(pages[pages.length - 1]);
    const packed = one(texts, "Packed by"), back = one(texts, "Returned by");
    assert.ok(back.y < packed.y);
    assert.equal(find(texts, "Date").length, 2);
    /* the lines to write on, not underscores */
    assert.ok(!texts.some((t) => /__/.test(t.str)));
    const rules = pages[pages.length - 1].split("\n").filter((op) => op.startsWith("q " + rgb(C.borderStrong) + " RG 0.75 w ") &&
      (op.includes(" " + (packed.y - 2).toFixed(2) + " m ") || op.includes(" " + (back.y - 2).toFixed(2) + " m ")));
    assert.equal(rules.length, 4, id + ": a line after each label");
    /* under the last row */
    const lowestName = Math.min(...texts.filter((t) => t.font === "F2" && t.size === 11).map((t) => t.y));
    assert.ok(packed.y < lowestName);
    assertFooters(pages, LONG_DEMO.state.title);
    one(textsOf(pages[0]), plural);
  }
  /* the gear list: its Returned item (the gimbal, first) all four
     segments, faint — done with */
  const gearPage = pagesOf(buildPackingListPdf("gear"))[0];
  const gearPills = pillsOf(gearPage);
  assert.deepEqual([gearPills[0].filled, gearPills[0].fill, gearPills[0].empty], [4, rgb(C.faint), 0]);
  one(textsOf(gearPage), "3 items · 2 have it · 1 returned");
});

test("the packing list's file: its title for a viewer, and the same bytes built twice", () => {
  demo();
  const a = buildPackingListPdf("gear"), b = buildPackingListPdf("gear");
  assert.ok(Buffer.from(a).equals(Buffer.from(b)), "the same list twice is the same file");
  const t = new TextDecoder("latin1").decode(a);
  const title = LONG_DEMO.state.title + " — Gear packing list";
  const hex = "FEFF" + Array.from(title).map((ch) => ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")).join("");
  assert.ok(t.includes("/Title <" + hex + ">"), "the Info title");
  assert.ok(t.includes("/DisplayDocTitle true"));
});

/* a script of its own: a long title, a prop a b-roll shot needs, an item
   the script no longer mentions, notes over two lines, and `n` more */
const tag = (cat, name) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;
const key = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const LONG_TITLE = "A Very Long Script Title That Goes On and On: How We Rebuilt a 1970s Film Camera From Parts, and What It Taught Us";

function edgeDoc(n) {
  const extra = [];
  for (let i = 0; i < n; i++) extra.push({ cat: "prop", name: "Spare part " + String(i + 1).padStart(2, "0"), status: "needed" });
  S.state = migrateRows({
    schema: 2, title: LONG_TITLE, comments: [],
    people: [{ id: "p1", name: "Jordan Sato" }],
    rows: [
      { id: "r0", visualText: "The " + tag("prop", "Kettle") + " on the hob.<br>" + key("s1") + " steam off the kettle<br>tight, then wider",
        audioText: "Every morning starts the same way.", status: "todo" },
      { id: "r1", visualText: tag("prop", "Mug") + " and " + extra.map((p) => tag("prop", p.name)).join(", "), audioText: "", status: "todo" }
    ],
    productionTags: [
      { cat: "prop", name: "Kettle", status: "sourcing", owner: "p1", notes: "The red one from the shop,\nnot the steel one." },
      { cat: "prop", name: "Mug", status: "have" },
      { cat: "prop", name: "Teapot", status: "returned" }
    ].concat(extra),
    brollShots: [{ id: "s1", name: "steam off the kettle", status: "unshot", props: [{ name: "Kettle" }] }]
  });
}

test("the packing list: a long title wraps, notes and the b-roll shots under the name, an item no longer in the script", () => {
  edgeDoc(0);
  const pages = pagesOf(buildPackingListPdf("prop"));
  assertInsideMargins(pages);
  const texts = textsOf(pages[0]);
  /* the title and the day wrap onto a second line rather than off the page */
  const metas = texts.filter((t) => t.size === 10.5 && t.rgb === rgb(C.dim));
  assert.ok(metas.length >= 2, "wrapped");
  assert.equal(metas.map((t) => t.str).join(" "), LONG_TITLE + " · " + exportDateText());
  /* a line break in a note is a space, never a "?" */
  assert.ok(!texts.some((t) => t.str.includes("?")));
  /* (over two lines: the note's lines between the name and the b-roll line) */
  const kettle = one(texts, "Kettle"), brollLine = one(texts, "B-roll:");
  const noteLines = texts.filter((t) => t.x === kettle.x && t.font === "F1" && t.size === 9 && t.y < kettle.y && t.y > brollLine.y);
  assert.equal(noteLines.map((t) => t.str).join(" "), "The red one from the shop, not the steel one.");
  /* the b-roll shot that needs it, after its label in the b-roll teal */
  const label = one(texts, "B-roll:");
  assert.deepEqual([label.font, label.size, label.rgb], ["F2", 9, rgb(C.broll)]);
  const shot = one(texts, "steam off the kettle");
  assert.ok(shot.y === label.y && shot.x > label.x && shot.rgb === rgb(C.dim));
  /* the teapot is tracked but the script no longer has it */
  const teapot = one(texts, "Teapot");
  const gone = one(texts, "Not in script");
  assert.ok(gone.y === teapot.y && gone.rgb === rgb(C.faint));
  one(texts, "3 items · 1 have it · 1 sourcing · 1 returned");
  /* Kettle (sourcing), Mug (have), Teapot (returned), alphabetical */
  assert.deepEqual(pillsOf(pages[0]).map((p) => [p.filled, p.fill]),
    [[2, rgb(C.audio)], [3, rgb(C.dim)], [4, rgb(C.faint)]]);
});

test("the packing list runs onto more pages: the heads again, a footer on every page, the lines to sign once, at the end", () => {
  edgeDoc(60);
  const pages = pagesOf(buildPackingListPdf("prop"));
  assert.ok(pages.length >= 3, pages.length + " pages");
  assertInsideMargins(pages);
  assertFooters(pages, LONG_TITLE);
  pages.forEach((page, i) => {
    const texts = textsOf(page);
    one(texts, "Out");
    one(texts, "Back");
    if (i) {
      const cont = one(texts, "Props & set dressing (continued)");
      assert.equal(cont.rgb, rgb(C.faint));
      assert.equal(find(texts, "Packing list").length, 0, "the kicker is the first page's");
    }
    /* nothing below the bottom margin but the footer */
    texts.filter((t) => t.size !== 7.5).forEach((t) => assert.ok(t.y >= M, t.str + " at " + t.y));
  });
  const all = pages.map(textsOf);
  assert.equal(all.flat().filter((t) => t.str === "Packed by").length, 1);
  one(all[all.length - 1], "Returned by");
  /* every item once, and in order */
  const names = all.flat().filter((t) => t.font === "F2" && t.size === 11).map((t) => t.str);
  assert.equal(names.length, 63);
  assert.deepEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
  /* a pill for every item, the 60 spares Needed: one segment, amber */
  const pills = pages.map(pillsOf).flat();
  assert.equal(pills.length, 63);
  assert.equal(pills.filter((p) => p.filled === 1 && p.fill === rgb(C.audio) && p.empty === 3).length, 60);
});

test("an empty category keeps its one line, under the new head", () => {
  edgeDoc(0);
  const pages = pagesOf(buildPackingListPdf("cast"));
  assert.equal(pages.length, 1);
  const texts = textsOf(pages[0]);
  one(texts, "Packing list");
  one(texts, "Cast & wardrobe");
  const line = one(texts, "Nothing tagged Cast yet.");
  assert.equal(line.rgb, rgb(C.dim));
  assert.equal(find(texts, "Out").length, 0, "no table");
  assert.equal(find(texts, "Packed by").length, 0, "nothing to sign for");
  assert.ok(!texts.some((t) => / items? · /.test(t.str)));
  assertFooters(pages, LONG_TITLE);
  assertInsideMargins(pages);
});

/* ---- the b-roll shot list ---- */

/* the full page's grouping, as the reader left it (per device) */
function groupBy(pageGroup, filter) {
  localStorage.setItem("splitpage-broll-view", JSON.stringify({ filter: filter || "all", group: "scene", pageGroup }));
  initBrollPanel();
}

test("the print data says what each group is and where each scene starts", () => {
  demo();
  groupBy("scene");
  const data = brollShotListForPrint();
  const g = data.groups[0];
  assert.deepEqual([g.label, g.kind, g.start, g.none], ["Scene 04", "scene", "01:03", false]);
  assert.equal(g.items[0].start, "01:03");
  groupBy("location");
  const byPlace = brollShotListForPrint().groups;
  assert.deepEqual(byPlace.map((x) => [x.label, x.kind, x.none]),
    [["Camera shop", "location", false], ["Riverside park", "location", false], ["workbench", "location", false], ["No location", "location", true]]);
  assert.ok(byPlace.every((x) => x.start === ""), "only a scene group starts somewhere");
  assert.equal(byPlace[0].items[0].start, "05:11");
});

/* The shot list's table (drawShotTable, 17-pdf.js): where each column
   starts, from the margin. */
const COL = { done: 0, scene: 22, shot: 66, location: 258, props: 338, owner: 448, flag: 514, notes: 602 };
const HEADS = ["Done", "Scene", "B-roll shot", "Location", "Props", "Assigned", "Flagged", "Notes"];
/* what a column holds — its head (7.5pt and dim) left out */
const at = (texts, col) => texts.filter((t) => Math.abs(t.x - (SM + COL[col])) < 0.01 && !(t.size === 7.5 && t.rgb === rgb(C.dim)));
/* the texts in one row, by the row's shot name: everything from its
   baseline down to the next row's */
function rowTexts(all, name) {
  const n = one(all, name);
  const names = all.filter((t) => t.x === n.x && t.font === "F2" && t.size === 9.5 && t.y < n.y).map((t) => t.y);
  const next = names.length ? Math.max(...names) : -Infinity;
  return all.filter((t) => t.y <= n.y + 0.01 && t.y > next + 0.01);
}

test("the shot list: a landscape table under the head, its columns on every page, a band per place", () => {
  demo();
  groupBy("location");
  const bytes = buildShotListPdf(brollShotListForPrint());
  const raw = new TextDecoder("latin1").decode(bytes);
  const pages = pagesOf(bytes);
  assert.equal((raw.match(/\/MediaBox \[0 0 792 612\]/g) || []).length, pages.length, "every page landscape");
  assertInsideMargins(pages, SPW, SM);
  assertFooters(pages, LONG_DEMO.state.title, SM);
  const texts = textsOf(pages[0]);
  const kicker = one(texts, "B-roll shot list");
  assert.deepEqual([kicker.size, kicker.rgb], [9, rgb(C.faint)]);
  const title = one(texts, LONG_DEMO.state.title);
  assert.deepEqual([title.font, title.size, title.rgb], ["F2", 20, rgb(C.text)]);
  one(texts, "3 of 9 shot · 1 flagged · by location · " + exportDateText());

  /* the column heads, small and dim, left to right, on every page */
  pages.map(textsOf).forEach((pt) => {
    const heads = HEADS.map((h) => one(pt.filter((t) => t.size === 7.5), h));
    assert.ok(heads.every((h) => h.y === heads[0].y && h.rgb === rgb(C.dim)));
    assert.ok(heads.every((h, i) => !i || h.x > heads[i - 1].x));
  });

  const all = pages.map(textsOf).flat();
  /* a band per place: its name in bold at the left (after a pin), a group
     that runs over a page break banded again, "(continued)" for its count */
  const bands = all.filter((t) => t.font === "F2" && t.size === 9.5 && t.x < SM + 20).map((t) => t.str);
  assert.deepEqual(bands.filter((h, i) => bands.indexOf(h) === i), ["Camera shop", "Riverside park", "workbench", "No location"]);
  assert.equal(all.filter((t) => t.str === "(continued)" && t.size === 8.5).length, bands.length - 4);
  const counts = all.filter((t) => / shot$/.test(t.str) && t.size === 8.5);
  assert.deepEqual(counts.map((t) => t.str), ["1/1 shot", "0/2 shot", "0/1 shot", "2/5 shot"]);
  assert.deepEqual(counts.map((t) => t.rgb), [rgb(C.broll), rgb(C.faint), rgb(C.faint), rgb(C.faint)]);
  counts.forEach((t) => assert.ok(Math.abs(t.x + pdfTextWidth(t.str, false, 8.5) - (SPW - SM)) < 0.01, "right-aligned"));
  /* the band says the place, so no row repeats it */
  assert.equal(at(all, "location").length, 0);
  /* a pin, in the location colour, before each place — not before "No location" */
  const pins = pages.join("\n").split("\n").filter((op) => op.startsWith("q " + rgb(TAG_PRINT_COLORS.location) + " rg "));
  assert.equal(pins.length, 3);
  assert.ok(pins.every((op) => / l h f 1 1 1 rg .* f Q$/.test(op)), "a head, a point and a hole");
});

test("the shot list's rows: done, the scene, the shot, its props, the flag and why, a note, and lines to write on", () => {
  demo();
  /* props on one shot, and a note that is not a flag's reason on another */
  const shot = (name) => S.state.brollShots.find((r) => r.name === name);
  shot("slow-motion shutter firing at one second").props = [{ name: "button cell battery" }, { name: "naphtha" }];
  shot("battery dropping into the base plate").notes = "Ask the shop first.";
  const pages = pagesOf(buildShotListPdf(brollShotListForPrint({ filter: "all", group: "scene" })));
  assert.equal(pages.length, 1, "nine shots, one page");
  assertInsideMargins(pages, SPW, SM);
  const ops = pages[0].split("\n");
  const all = textsOf(pages[0]);

  /* three shot, three ticks, in the b-roll teal */
  assert.equal(ops.filter((op) => op.includes(" q " + rgb(C.broll) + " RG ")).length, 3);
  /* the shot in bold, faint once it is shot */
  const shop = one(all, "shop sign and window display");
  assert.deepEqual([shop.font, shop.size, shop.rgb, shop.x], ["F2", 9.5, rgb(C.faint), SM + COL.shot]);
  assert.equal(one(all, "the heron taking off").rgb, rgb(C.text));
  /* its scene and where that starts */
  const row = rowTexts(all, "shop sign and window display");
  const sc = at(row, "scene");
  assert.deepEqual(sc.map((t) => [t.str, t.font, t.size]), [["16", "F2", 9.5], ["05:11", "F1", 7.5]]);
  assert.equal(sc[1].rgb, rgb(C.faint));
  assert.deepEqual(at(row, "location").map((t) => t.str), ["Camera shop"]);
  /* the line it cuts against, in italic — a short one whole */
  const quote = row.find((t) => t.font === "F3");
  assert.deepEqual([quote.str, quote.size, quote.x], ["“Next stop: film.”", 7.5, SM + COL.shot]);
  /* a long one (the heron's is its scene's whole Audio): its opening, cut
     at a word end, in two lines at most */
  const heronQuote = rowTexts(all, "the heron taking off").filter((t) => t.font === "F3");
  assert.ok(heronQuote.length >= 1 && heronQuote.length <= 2, heronQuote.length + " lines");
  assert.match(heronQuote[heronQuote.length - 1].str, /\w…”$/);

  /* props, each starting a line of its own, each with its status */
  const props = at(rowTexts(all, "slow-motion shutter firing at one second"), "props").map((t) => t.str);
  assert.equal(props.join(" "), "button cell battery (sourcing) naphtha (have it)");
  assert.equal(props[0], "button cell battery");
  assert.ok(props.includes("naphtha (have it)"));
  /* "Flagged", bold and red, and under it why — the note */
  const flagRow = rowTexts(all, "the toothpick lifting a long strand of goo");
  const flag = at(flagRow, "flag");
  assert.deepEqual([flag[0].str, flag[0].font, flag[0].size, flag[0].rgb], ["Flagged", "F2", 8.5, rgb("C4302A")]);
  assert.equal(flag.slice(1).map((t) => t.str).join(" "), "Soft focus — grab it again on the macro day.");
  assert.ok(flag.slice(1).every((t) => t.rgb === rgb(C.dim)));
  assert.equal(at(flagRow, "notes").length, 0, "the reason is not a note too");
  assert.ok(!pages[0].includes("FLAGGED"));
  /* a note that is no flag's reason, in Notes */
  assert.deepEqual(at(rowTexts(all, "battery dropping into the base plate"), "notes").map((t) => t.str), ["Ask the shop first."]);
  /* and every row keeps lines to write on in Notes */
  const writing = ops.filter((op) => op.startsWith("q " + rgb(C.borderStrong) + " RG 0.5 w " + (SM + COL.notes).toFixed(2) + " "));
  assert.ok(writing.length >= 9 * 2 - 1, writing.length + " lines to write on");
});

test("by scene: no bands — the Scene column groups the rows, a scene named on its first shot only", () => {
  shotsDoc(0);
  groupBy("scene");
  const pages = pagesOf(buildShotListPdf(brollShotListForPrint()));
  assertInsideMargins(pages, SPW, SM);
  const all = pages.map(textsOf).flat();
  /* a scene has no band; the shots added by hand, with no scene, do */
  assert.deepEqual(all.filter((t) => t.font === "F2" && t.size === 9.5 && t.x < SM + 20).map((t) => t.str), ["Added here"]);
  assert.deepEqual(all.filter((t) => / shot$/.test(t.str) && t.size === 8.5).map((t) => t.str), ["0/1 shot"]);
  /* scene 01's number and start once, on its first shot; scene 02's on its */
  const numbers = at(all, "scene").filter((t) => t.font === "F2").map((t) => t.str);
  assert.deepEqual(numbers, ["01", "02"]);
  assert.deepEqual(at(all, "scene").filter((t) => t.font === "F1" && t.rgb === rgb(C.faint)).map((t) => t.str), sceneFacts().slice(0, 2).map((f) => f.start));
  one(all, "1 of 3 shot · 1 flagged · by scene · " + exportDateText());
});

/* shots with everything a shot can have, `n` more in one place to run
   the list onto a second page */
function shotsDoc(n) {
  const more = [];
  for (let i = 0; i < n; i++) more.push({ id: "m" + i, name: "Extra shot " + (i + 1), status: "unshot", origin: "list", location: "Harbour", notes: "Any time." });
  S.state = migrateRows({
    schema: 2, title: LONG_TITLE, comments: [],
    people: [{ id: "p1", name: "Jordan Sato" }, { id: "p2", name: "Ada Brenner" }],
    rows: [
      { id: "r0", visualText: "Host at the wall.<br>" + key("s1") + " gulls over the nets<br>wide first<br>then tight on one bird",
        audioText: "Every morning the town wakes to the same sound.", status: "todo" },
      { id: "r1", visualText: key("s2") + " boats at dawn", audioText: "", status: "todo" }
    ],
    productionTags: [{ cat: "prop", name: "Drone", status: "needed" }, { cat: "prop", name: "Fishing nets", status: "have" }],
    brollShots: [
      { id: "s1", name: "gulls over the nets", status: "shot", location: "Harbour", owner: "p1", props: [{ name: "Drone" }, { name: "Fishing nets" }], audioRef: "Every morning the town wakes to the same sound." },
      { id: "s2", name: "boats at dawn", status: "unshot", reshoot: true, owner: "p2" },
      { id: "s3", name: "Crowd at the auction", status: "unshot", origin: "list", notes: "Ask the harbourmaster first." }
    ].concat(more)
  });
}

test("by person: a shot's description on its own lines, its props with their status, a note, and Flagged with none", () => {
  shotsDoc(0);
  groupBy("person");
  const data = brollShotListForPrint();
  assert.deepEqual(data.groups.map((g) => g.label), ["Ada Brenner", "Jordan Sato", "Unassigned"]);
  const pages = pagesOf(buildShotListPdf(data));
  assertInsideMargins(pages, SPW, SM);
  const all = pages.map(textsOf).flat();
  /* the lines under the shot's marker, under its name */
  const gulls = rowTexts(all, "gulls over the nets");
  assert.deepEqual(at(gulls, "shot").filter((t) => t.font === "F1").map((t) => [t.str, t.size]), [["wide first", 8], ["then tight on one bird", 8]]);
  assert.deepEqual(at(gulls, "scene").map((t) => t.str), ["01", "00:00"]);
  assert.deepEqual(at(gulls, "location").map((t) => t.str), ["Harbour"]);
  assert.deepEqual(at(gulls, "props").map((t) => t.str), ["Drone (needed)", "Fishing nets (have it)"]);
  /* grouped by person, the person is the band's to say */
  assert.equal(at(all, "owner").length, 0);
  /* flagged with no note: the word alone */
  assert.deepEqual(at(rowTexts(all, "boats at dawn"), "flag").map((t) => t.str), ["Flagged"]);
  /* a note that is no flag's reason, in Notes */
  assert.deepEqual(at(rowTexts(all, "Crowd at the auction"), "notes").map((t) => t.str), ["Ask the harbourmaster first."]);
  /* an added shot has no scene */
  assert.equal(at(rowTexts(all, "Crowd at the auction"), "scene").length, 0);
  groupBy("location");
  const byPlace = pagesOf(buildShotListPdf(brollShotListForPrint())).map(textsOf).flat();
  const boats = rowTexts(byPlace, "boats at dawn");
  assert.deepEqual(at(boats, "scene").map((t) => t.str), ["02", sceneFacts()[1].start]);
  assert.deepEqual(at(boats, "owner").map((t) => t.str), ["Ada Brenner"]);
});

test("a long shot list runs onto more pages: the group's head again, continued, and a footer on each", () => {
  shotsDoc(40);
  groupBy("location");
  const pages = pagesOf(buildShotListPdf(brollShotListForPrint()));
  assert.ok(pages.length >= 2);
  assertInsideMargins(pages, SPW, SM);
  assertFooters(pages, LONG_TITLE, SM);
  const second = textsOf(pages[1]);
  /* the page says it goes on, the heads again, and the band again */
  assert.equal(one(second, "B-roll shot list (continued)").rgb, rgb(C.faint));
  HEADS.forEach((h) => one(second, h));
  const cont = one(second, "(continued)");
  assert.equal(cont.y, one(second, "Harbour").y);
  /* the first page's head wrapped the long title rather than running off */
  assert.ok(textsOf(pages[0]).filter((t) => t.size === 20).length >= 2);
  /* nothing below the bottom but the footer */
  pages.forEach((page) => textsOf(page).filter((t) => t.size !== 7.5).forEach((t) => assert.ok(t.y >= 54, t.str + " at " + t.y)));
  /* every shot once */
  assert.equal(pages.map(textsOf).flat().filter((t) => /^Extra shot \d+$/.test(t.str)).length, 40);
});

test("no shots to list: the head and one line", () => {
  demo();
  const pages = pagesOf(buildShotListPdf({ title: "Empty", summary: "0 of 0 shot", scope: "by location", groups: [] }));
  assert.equal(pages.length, 1);
  const texts = textsOf(pages[0]);
  one(texts, "No shots to list.");
  one(texts, "Empty");
  assert.equal(find(texts, "Notes").length, 0, "no table");
  assertFooters(pages, "Empty", SM);
});
