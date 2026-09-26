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
import { PRINT_COLORS, TAG_STATUS_PRINT, exportDateText, sceneFacts } from "../js/14b-export-kit.js";
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

/* nothing drawn left of the margin or past the right one */
function assertInsideMargins(pages) {
  pages.forEach((page, i) => {
    textsOf(page).forEach((t) => {
      const w = pdfTextWidth(t.str, t.font === "F2" || t.font === "F4", t.size);
      assert.ok(t.x >= M - 0.01, "page " + (i + 1) + ": " + t.str + " starts at " + t.x);
      assert.ok(t.x + w <= PW - M + 0.01, "page " + (i + 1) + ": " + t.str + " runs to " + (t.x + w).toFixed(2));
    });
  });
}

/* each page's running footer: the title at the left, "Page n of N" at the
   right, 7.5pt and faint, over a hairline */
function assertFooters(pages, titleStart) {
  pages.forEach((page, i) => {
    const texts = textsOf(page);
    const right = one(texts, "Page " + (i + 1) + " of " + pages.length);
    assert.equal(right.size, 7.5);
    assert.equal(right.rgb, rgb(C.faint));
    const left = texts.filter((t) => t.size === 7.5 && t.x === M && t.y === right.y);
    assert.equal(left.length, 1, "page " + (i + 1) + ": the footer's title");
    assert.ok(left[0].str.startsWith(titleStart.slice(0, 20)), left[0].str);
  });
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

  /* the column heads, in sentence case, on one line */
  const heads = ["Out", "Back", "Item", "Status", "Owner", "Scenes"].map((h) => one(texts, h));
  assert.ok(heads.every((h) => h.y === heads[0].y && h.size === 8.5 && h.rgb === rgb(C.dim)));
  assert.ok(heads.every((h, i) => !i || h.x > heads[i - 1].x), "left to right");
  assert.ok(!texts.some((t) => t.str === t.str.toUpperCase() && /[A-Z]{3}/.test(t.str)), "nothing uppercased");
});

test("the packing list: a row per item, alphabetical, two boxes, the status as a lamp and a word, who has it, where", () => {
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
  /* status: Have it in the text colour, Sourcing — not in hand yet — in amber */
  const battery = row("button cell battery");
  assert.deepEqual(battery.map((t) => t.str), ["Sourcing", "Sam", "13"]);
  assert.equal(battery[0].rgb, rgb(C.audio));
  assert.equal(battery[1].rgb, rgb(C.text));
  assert.equal(battery[2].rgb, rgb(C.dim));
  assert.deepEqual(row("Pentax K1000").map((t) => t.str), ["Have it", "Sam", "01, 28"]);
  assert.equal(row("Pentax K1000")[0].rgb, rgb(C.text));
  /* nobody has it: nothing printed there, room to write a name in */
  assert.deepEqual(row("naphtha").map((t) => t.str), ["Have it", "05"]);
  /* a lamp a row: five lit (Have it), one half lit (Sourcing) */
  const lamps = ops.filter((op) => / f Q$/.test(op) && !/ l /.test(op) && !op.includes(" BT "));
  assert.equal(lamps.filter((op) => op.startsWith("q " + rgb(TAG_STATUS_PRINT.have.color) + " rg ")).length, 5);
  assert.equal(ops.filter((op) => op.startsWith("q " + rgb(TAG_STATUS_PRINT.sourcing.color) + " RG 0.9 w ")).length, 1);

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
  /* the gear list: its Returned item faint, word and lamp */
  const gear = textsOf(pagesOf(buildPackingListPdf("gear"))[0]);
  assert.equal(one(gear, "Returned").rgb, rgb(C.faint));
  one(gear, "3 items · 2 have it · 1 returned");
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
  one(texts, "The red one from the shop, not the steel one.");
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
  assert.equal(one(texts, "Returned").rgb, rgb(C.faint));
  assert.equal(one(texts, "Sourcing").rgb, rgb(C.audio));
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
  /* Needed is not in hand: amber */
  assert.ok(all.flat().filter((t) => t.str === "Needed").every((t) => t.rgb === rgb(C.audio)));
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

test("the shot list: the head, groups by location after a pin, done/total at the right, teal once all shot", () => {
  demo();
  groupBy("location");
  const pages = pagesOf(buildShotListPdf(brollShotListForPrint()));
  assert.equal(pages.length, 2);
  assertInsideMargins(pages);
  assertFooters(pages, LONG_DEMO.state.title);
  const texts = textsOf(pages[0]);
  const kicker = one(texts, "B-roll shot list");
  assert.deepEqual([kicker.size, kicker.rgb], [9, rgb(C.faint)]);
  const title = one(texts, LONG_DEMO.state.title);
  assert.deepEqual([title.font, title.size, title.rgb], ["F2", 20, rgb(C.text)]);
  one(texts, "3 of 9 shot · 1 flagged · by location · " + exportDateText());

  const all = pages.map(textsOf).flat();
  const heads = all.filter((t) => t.font === "F2" && t.size === 12).map((t) => t.str);
  assert.deepEqual(heads, ["Camera shop", "Riverside park", "workbench", "No location"]);
  const counts = all.filter((t) => / shot$/.test(t.str) && t.size === 9.5);
  assert.deepEqual(counts.map((t) => t.str), ["1/1 shot", "0/2 shot", "0/1 shot", "2/5 shot"]);
  assert.deepEqual(counts.map((t) => t.rgb), [rgb(C.broll), rgb(C.faint), rgb(C.faint), rgb(C.faint)]);
  counts.forEach((t) => assert.ok(Math.abs(t.x + pdfTextWidth(t.str, false, 9.5) - (PW - M)) < 0.01, "right-aligned"));
  /* a pin, in the location colour, before each place — not before "No location" */
  const pins = pages.join("\n").split("\n").filter((op) => op.startsWith("q " + rgb(TAG_PRINT_COLORS.location) + " rg "));
  assert.equal(pins.length, 3);
  assert.ok(pins.every((op) => / l h f 1 1 1 rg .* f Q$/.test(op)), "a head, a point and a hole");
});

test("the shot list: a box ticked in teal when shot, the name dimmed, what else there is to know in dim", () => {
  demo();
  groupBy("location");
  const pages = pagesOf(buildShotListPdf(brollShotListForPrint()));
  const joined = pages.join("\n").split("\n");
  /* three shot, three ticks, in the b-roll teal */
  assert.equal(joined.filter((op) => op.includes(" q " + rgb(C.broll) + " RG ")).length, 3);
  const all = pages.map(textsOf).flat();
  const shop = one(all, "shop sign and window display");
  assert.deepEqual([shop.font, shop.size, shop.rgb], ["F2", 11, rgb(C.faint)]);
  const heron = one(all, "the heron taking off");
  assert.equal(heron.rgb, rgb(C.text));
  /* grouped by location, a shot says its scene and where it starts, not its place again */
  const under = all.filter((t) => t.x === shop.x && t.y < shop.y && t.y > shop.y - 40);
  assert.equal(under[0].str, "Scene 16 · 05:11");
  assert.equal(under[0].rgb, rgb(C.dim));
  assert.ok(!all.some((t) => t.str.includes("Camera shop") && t.size === 9));
  /* the line it cuts against, in full, the words in italic */
  const label = under.find((t) => t.str === "Cuts against:");
  const quote = all.find((t) => t.y === label.y && t.x > label.x);
  assert.equal(quote.font, "F3");
  assert.equal(quote.str, "“Next stop: film.”");
  /* "Flagged" in sentence case, bold and red, the note after it */
  const flag = one(all, "Flagged");
  assert.deepEqual([flag.font, flag.size, flag.rgb], ["F2", 9, rgb("C4302A")]);
  const note = all.find((t) => t.y === flag.y && t.x > flag.x);
  assert.equal(note.str, " — Soft focus — grab it again on the macro day.");
  assert.equal(note.rgb, rgb(C.dim));
  assert.ok(!pages.join("").includes("FLAGGED"));
});

test("by scene: each head the scene and where it starts, which the shots under it do not repeat", () => {
  demo();
  groupBy("scene");
  const pages = pagesOf(buildShotListPdf(brollShotListForPrint()));
  assertInsideMargins(pages);
  const all = pages.map(textsOf).flat();
  const head = one(all, "Scene 04");
  assert.deepEqual([head.font, head.size], ["F2", 12]);
  const start = all.find((t) => t.y === head.y && t.str === "01:03");
  assert.ok(start && start.x > head.x && start.rgb === rgb(C.faint) && start.size === 10);
  assert.ok(!all.some((t) => /^Scene \d\d · /.test(t.str)), "no scene in a shot's details");
  one(all, "3 of 9 shot · 1 flagged · by scene · " + exportDateText());
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
  assertInsideMargins(pages);
  const all = pages.map(textsOf).flat();
  const gulls = one(all, "gulls over the nets");
  const below = all.filter((t) => t.x === gulls.x && t.y < gulls.y).sort((a, b) => b.y - a.y);
  assert.deepEqual(below.slice(0, 3).map((t) => [t.str, t.size]), [["wide first", 10], ["then tight on one bird", 10], ["Scene 01 · 00:00  ·  Harbour  ·  Props: Drone (needed), Fishing nets (have it)", 9]]);
  /* grouped by person, the person is the head's to say */
  assert.ok(!all.some((t) => /Assigned:/.test(t.str)));
  /* flagged with no note: the word alone */
  const flag = one(all, "Flagged");
  assert.ok(!all.some((t) => t.y === flag.y && t.x > flag.x));
  /* an unflagged note says what it is */
  one(all, "Note: Ask the harbourmaster first.");
  /* an added shot has no scene */
  const crowd = one(all, "Crowd at the auction");
  assert.ok(!all.some((t) => t.x === crowd.x && t.y < crowd.y && t.y > crowd.y - 20 && /^Scene/.test(t.str)));
  groupBy("location");
  const byPlace = pagesOf(buildShotListPdf(brollShotListForPrint())).map(textsOf).flat();
  one(byPlace, "Scene 02 · " + sceneFacts()[1].start + "  ·  Assigned: Ada Brenner");
});

test("a long shot list runs onto more pages: the group's head again, continued, and a footer on each", () => {
  shotsDoc(40);
  groupBy("location");
  const pages = pagesOf(buildShotListPdf(brollShotListForPrint()));
  assert.ok(pages.length >= 2);
  assertInsideMargins(pages);
  assertFooters(pages, LONG_TITLE);
  const second = textsOf(pages[1]);
  one(second, "Harbour");
  const cont = one(second, "(continued)");
  assert.equal(cont.y, one(second, "Harbour").y);
  /* the first page's head wrapped the long title rather than running off */
  assert.ok(textsOf(pages[0]).filter((t) => t.size === 20).length >= 2);
  pages.forEach((page) => textsOf(page).filter((t) => t.size !== 7.5).forEach((t) => assert.ok(t.y >= M, t.str + " at " + t.y)));
});

test("no shots to list: the head and one line", () => {
  demo();
  const pages = pagesOf(buildShotListPdf({ title: "Empty", summary: "0 of 0 shot", scope: "by location", groups: [] }));
  assert.equal(pages.length, 1);
  const texts = textsOf(pages[0]);
  one(texts, "No shots to list.");
  one(texts, "Empty");
  assertFooters(pages, "Empty");
});
