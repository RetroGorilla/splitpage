import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { TAG_PRINT_COLORS } from "../js/14-export.js";
import {
  PRINT_COLORS,
  commentNumbers,
  exportBrollScenes,
  exportComments,
  exportFacts,
  exportSummaryParts,
  sceneFacts
} from "../js/14b-export-kit.js";
import { buildPdf, pdfTextWidth } from "../js/17-pdf.js";
import { LONG_DEMO } from "../js/_starters.js";

initStatus();
initTags();

const M = 54, PW = 612;
const copy = (o) => JSON.parse(JSON.stringify(o));
const demo = () => { S.state = migrateRows(copy(LONG_DEMO.state)); };
const rgb = (hex) => [0, 2, 4].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");

function read(bytes) {
  const t = new TextDecoder("latin1").decode(bytes);
  const streams = [];
  const re = /obj\n<< \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(t))) streams.push(t.substr(re.lastIndex, +m[1]));
  const pages = streams.map((s) => {
    const texts = [], footer = [];
    let art = false;
    s.split("\n").forEach((op) => {
      if (/^\/Artifact .* BDC$/.test(op)) { art = true; return; }
      if (op === "EMC") { art = false; return; }
      const x = /^(?:q ([\d.]+ [\d.]+ [\d.]+) rg )?BT \/(F\d) ([\d.]+) Tf 1 0 0 1 ([\d.]+) ([-\d.]+) Tm \((.*)\) Tj ET(?: Q)?$/.exec(op);
      if (!x) return;
      (art ? footer : texts).push({ color: x[1] || null, font: x[2], size: +x[3], x: +x[4], y: +x[5], str: x[6] });
    });
    return { ops: s.split("\n"), texts, footer };
  });
  return { t, pages };
}
const words = (texts) => texts.map((o) => o.str).join(" ");
const pageWith = (doc, str, size) => doc.pages.findIndex((p) => p.texts.some((o) => o.str === str && (!size || o.size === size)));

test("the title block: the title, the facts and the date, the rundown and its legend", () => {
  demo();
  const doc = read(buildPdf(null));
  const p1 = doc.pages[0];
  const title = p1.texts.find((o) => o.size === 20);
  assert.equal(title.str, "I Fixed a $40 Film Camera \\(and Shot a Roll With It\\)");
  assert.equal(title.font, "F2");
  const facts = exportFacts();
  const meta = p1.texts.find((o) => o.size === 8.5 && o.y < title.y);
  assert.equal(meta.str, exportSummaryParts(facts).concat(facts.date).join(" · "));
  assert.equal(meta.color, rgb(PRINT_COLORS.dim));
  const strip = p1.texts.filter((o) => o.size === 6.5 && o.y > meta.y - 40);
  assert.ok(strip.length >= 10 && strip.length < 30, strip.length + " numbers in the strip");
  strip.forEach((o) => assert.match(o.str, /^\d\d$/));
  assert.ok(strip.every((o, i) => i === 0 || +o.str > +strip[i - 1].str), "in scene order");
  assert.ok(strip.every((o) => o.x >= M && o.x < PW - M));
  assert.ok(p1.texts.some((o) => o.str === "Target 9:00" && o.size === 7));
  const counts = sceneFacts().reduce((n, f) => { n[f.status.id]++; return n; }, { shot: 0, ready: 0, todo: 0 });
  for (const [label, id] of [["Shot", "shot"], ["Ready", "ready"], ["To do", "todo"]]) {
    assert.ok(p1.texts.some((o) => o.str === label + " " + counts[id] && o.size === 7.5), label + " " + counts[id]);
  }
  assert.equal(counts.shot, 13);
});

test("column heads in sentence case on every page of the script, and only there", () => {
  demo();
  const doc = read(buildPdf(null));
  const script = doc.pages.filter((p) => p.texts.some((o) => o.size === 12 && o.x === M));
  assert.ok(script.length >= 5);
  script.forEach((p) => {
    for (const head of ["Scene", "Visual", "Audio", "Read"]) {
      assert.ok(p.texts.some((o) => o.str === head && o.size === 8), head + " missing from a script page");
    }
  });
  assert.equal(/\((VISUAL|AUDIO|CATEGORY|STATUS|SCENES)\) Tj/.test(doc.t), false);
  const appendix = doc.pages.slice(pageWith(doc, "Production breakdown", 16));
  appendix.forEach((p) => assert.ok(!p.texts.some((o) => o.str === "Visual" && o.size === 8)));
});

test("each scene's gutter: its number, its start, its status and its read time", () => {
  demo();
  const doc = read(buildPdf(null));
  const all = doc.pages.flatMap((p, i) => p.texts.map((o) => Object.assign({ page: i }, o)));
  const facts = sceneFacts();
  facts.forEach((f) => {
    const num = all.find((o) => o.str === f.number && o.size === 12 && o.x === M && !o.color);
    assert.ok(num, "scene " + f.number + " has no number");
    const same = all.filter((o) => o.page === num.page);
    assert.ok(same.some((o) => o.str === f.start && o.size === 7 && o.y === num.y && o.color === rgb(PRINT_COLORS.faint)), f.number + ": no " + f.start);
    assert.ok(same.some((o) => o.str === f.status.label && o.size === 7.5 && Math.abs(num.y - 12 - o.y) < 0.01), f.number + ": no status");
    const read = same.find((o) => o.str === f.read && o.size === 8.5 && o.y === num.y);
    assert.ok(read && read.x > 500, f.number + ": no read time " + f.read);
  });
  const boxes = doc.t.match(new RegExp("q " + rgb(PRINT_COLORS.borderStrong) + " RG 0.6 w [\\d.]+ [\\d.]+ m .* c h S Q", "g")) || [];
  assert.equal(boxes.length, facts.filter((f) => f.readSet).length);
});

test("a tag in its category's colour, underlined in it; the b-roll key a chip", () => {
  demo();
  const doc = read(buildPdf(null));
  const p1 = doc.pages[0];
  const pentax = p1.texts.find((o) => o.str === "Pentax");
  assert.equal(pentax.color, rgb(TAG_PRINT_COLORS.prop));
  const bar = p1.ops.find((op) => op.startsWith("q " + rgb(TAG_PRINT_COLORS.prop) + " rg " + pentax.x.toFixed(2) + " "));
  assert.match(bar, / 0\.60 re f Q$/);
  const keys = S.state.rows.reduce((n, r) => n + (r.visualText.match(/class="broll-key"/g) || []).length, 0);
  const script = doc.pages.slice(0, pageWith(doc, "Production breakdown", 16));
  const chips = script.flatMap((p) => p.texts).filter((o) => o.str === "B-roll" && o.size === 6.5 && o.color === rgb(PRINT_COLORS.broll));
  assert.ok(keys > 3);
  assert.equal(chips.length, keys);
  const outlines = script.flatMap((p) => p.ops).filter((op) => op.startsWith("q " + rgb(PRINT_COLORS.broll) + " RG 0.6 w ") && / c h S Q$/.test(op));
  assert.equal(outlines.length, keys);
  assert.equal(doc.t.indexOf("(B-roll:)"), -1);
});

test("each open thread's number after its words, in amber, as the appendix numbers it", () => {
  demo();
  const doc = read(buildPdf(null));
  const nums = Object.values(commentNumbers()).sort();
  const amber = rgb(PRINT_COLORS.audio);
  const markers = doc.pages.flatMap((p) => p.texts.filter((o) => o.size === 6 && o.color === amber)).map((o) => +o.str);
  assert.deepEqual(markers, nums);
  assert.ok((doc.t.match(new RegExp("q " + amber + " RG 0.9 w 1 J \\[0 1.8\\] 0 d", "g")) || []).length >= nums.length);
  assert.ok(new RegExp("q " + rgb(PRINT_COLORS.faint) + " RG 0.9 w 1 J \\[0 1.8\\] 0 d").test(doc.t));
  const at = pageWith(doc, "Comments", 16);
  const badges = doc.pages.slice(at).flatMap((p) => p.texts.filter((o) => o.size === 7 && o.font === "F2" && o.color === "1.000 1.000 1.000")).map((o) => +o.str);
  assert.deepEqual(badges, exportComments().filter((c) => c.number).map((c) => c.number));
  const comments = words(doc.pages[at].texts);
  assert.match(comments, /\b3 open · 1 resolved\b/);
  assert.match(comments, /Scene 03 · Audio Jo \\\(editor\\\) · /);
  assert.match(comments, /Resolved by Sam/);
  assert.equal(badges.length, 3);
});

test("a scene's video link and a link in its words are blue, and can be clicked", () => {
  S.state = migrateRows({ schema: 2, title: "Links", comments: [], rows: [
    { id: "r0", visualText: 'See <a href="https://example.com/ref">the reference clip</a> for the look.', audioText: "Hello.", status: "todo",
      imageLinks: [{ href: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", poster: true }] },
    { id: "r1", visualText: "", audioText: "No visual here.", status: "todo" }
  ] });
  const doc = read(buildPdf(null));
  const p1 = doc.pages[0];
  const blue = rgb(PRINT_COLORS.visual);
  const addr = p1.texts.find((o) => o.str === "youtube.com/watch?v=aqz-KE-bpKQ");
  assert.ok(addr && addr.color === blue && addr.x === 100);
  assert.ok(["the", "reference", "clip"].every((w) => p1.texts.some((o) => o.str === w && o.color === blue)));
  const links = [...doc.t.matchAll(/\/Subtype \/Link \/Rect \[([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)\] \/Border \[0 0 0\] \/A << \/S \/URI \/URI \(([^)]*)\) >>/g)];
  assert.deepEqual(links.map((l) => l[5]).sort(), ["https://example.com/ref", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"]);
  const yt = links.find((l) => /youtube/.test(l[5]));
  assert.ok(+yt[1] <= addr.x + 0.01 && +yt[2] < addr.y && +yt[4] > addr.y, "the link's rectangle is not over the address");
  const ref = links.find((l) => /example/.test(l[5]));
  assert.ok(+ref[3] - +ref[1] > 60, "the link covers all three words");
  assert.match(doc.t, /\/Type \/Page [^\n]*\/Annots \[\d+ 0 R \d+ 0 R\]/);
});

test("a running footer on every page, bookmarks to each part, and the title the viewer shows", () => {
  demo();
  const doc = read(buildPdf(null));
  const n = doc.pages.length;
  doc.pages.forEach((p, i) => {
    assert.deepEqual(p.footer.map((o) => o.str), [LONG_DEMO.state.title.replace(/[()]/g, "\\$&"), "Page " + (i + 1) + " of " + n]);
    assert.ok(p.footer.every((o) => o.size === 7.5 && o.color === rgb(PRINT_COLORS.faint)));
  });
  const outline = [...doc.t.matchAll(/\/Title \(([^)]*)\) \/Parent \d+ 0 R[^\n]*\/Dest \[(\d+) 0 R/g)].map((m) => m[1]);
  assert.deepEqual(outline, ["Script", "Production breakdown", "B-roll shot list", "Comments"]);
  const pageObjs = [...doc.t.matchAll(/(\d+) 0 obj\n<< \/Type \/Page \/Parent/g)].map((m) => +m[1]);
  const dests = [...doc.t.matchAll(/\/Dest \[(\d+) 0 R/g)].map((m) => pageObjs.indexOf(+m[1]));
  assert.deepEqual(dests, [0, pageWith(doc, "Production breakdown", 16), pageWith(doc, "B-roll shot list", 16), pageWith(doc, "Comments", 16)]);
  assert.match(doc.t, /\/Info 7 0 R/);
  assert.ok(doc.t.indexOf("/Title (I Fixed a $40 Film Camera \\(and Shot a Roll With It\\))") > 0);
  assert.deepEqual(buildPdf(null), buildPdf(null));
});

test("the appendix: the breakdown by category, the b-roll by scene, a summary line each", () => {
  demo();
  const doc = read(buildPdf(null));
  const at = pageWith(doc, "Production breakdown", 16);
  const bd = doc.pages.slice(at, pageWith(doc, "B-roll shot list", 16));
  const bdWords = bd.flatMap((p) => p.texts);
  assert.match(words(doc.pages[at].texts), /\b31 items\b/);
  for (const head of ["Item", "Status", "Scenes", "Assigned to"]) assert.ok(bdWords.some((o) => o.str === head && o.size === 8));
  for (const [id, label] of [["prop", "Props & set dressing"], ["location", "Locations & shots"], ["gear", "Gear"]]) {
    assert.ok(bdWords.some((o) => o.str === label && o.font === "F2" && o.size === 10), label);
    assert.ok(bd.some((p) => p.ops.some((op) => op.startsWith("q " + rgb(TAG_PRINT_COLORS[id]) + " rg ") && / c h f Q$/.test(op))), id + "'s dot");
  }
  const bat = pageWith(doc, "B-roll shot list", 16);
  assert.equal((doc.t.match(/\/MediaBox \[0 0 792 612\]/g) || []).length, 1, "one landscape page, the shot list's");
  const groups = exportBrollScenes();
  const brollWords = doc.pages.slice(bat, pageWith(doc, "Comments", 16)).flatMap((p) => p.texts);
  groups.forEach((g) => assert.ok(brollWords.some((o) => o.str === g.scene && o.font === "F2"), g.label));
  assert.ok(brollWords.some((o) => o.str === "3 of 9 shot \xB7 1 flagged \xB7 by scene"));
  for (const head of ["Done", "Scene", "B-roll shot", "Location", "Props", "Assigned", "Flagged", "Notes"]) {
    assert.ok(brollWords.some((o) => o.str === head && o.size === 7.5), head);
  }
  assert.equal(brollWords.filter((o) => o.str === "Flagged" && o.color === rgb("C4302A")).length, 1);
  const boxes = doc.pages.slice(bat).flatMap((p) => p.ops).filter((op) => op.startsWith("q " + rgb(PRINT_COLORS.faint) + " RG 0.9 w "));
  assert.equal(boxes.length, 9);
  assert.equal(boxes.filter((op) => op.includes(" q " + rgb(PRINT_COLORS.broll) + " RG ")).length, 3);
});

test("an empty script is one page: its title, its facts, and no more", () => {
  S.state = migrateRows({ schema: 2, title: "Nothing yet", comments: [], rows: [] });
  const doc = read(buildPdf(null));
  assert.equal(doc.pages.length, 1);
  const w = words(doc.pages[0].texts);
  assert.match(w, /^Nothing yet 0 scenes \xB7 0:00 running time \xB7 .*2\d\d\d No scenes yet\.$/);
  assert.deepEqual(doc.pages[0].footer.map((o) => o.str), ["Nothing yet", "Page 1 of 1"]);
});

test("a long title of emoji is shortened by whole characters, never half of one (#434)", () => {
  const grin = String.fromCodePoint(0x1F600);
  for (let lead = 0; lead < 4; lead++) {
    S.state = migrateRows({ schema: 2, title: "Title " + "i".repeat(lead) + grin.repeat(30) + " end i" + grin.repeat(60), comments: [],
      rows: [{ id: "r0", visualText: "Wide.", audioText: "Hello.", status: "shot" }] });
    const lines = read(buildPdf(null)).pages[0].texts.filter((o) => o.size === 20);
    assert.equal(lines.length, 2);
    lines.forEach((l) => assert.equal((l.str.match(/\?/g) || []).length % 2, 0, lead + ": " + l.str));
  }
});

test("the footer's shortened title never ends in half an emoji (#434)", () => {
  const grin = String.fromCodePoint(0x1F600);
  for (let lead = 0; lead < 8; lead++) {
    S.state = migrateRows({ schema: 2, title: "i".repeat(lead) + grin.repeat(120), comments: [],
      rows: [{ id: "r0", visualText: "Wide.", audioText: "Hello.", status: "shot" }] });
    const foot = read(buildPdf(null)).pages[0].footer[0].str;
    assert.ok(foot.length > 20 && foot.length < 240, lead + ": " + foot.length);
    assert.equal((foot.match(/\?/g) || []).length % 2, 0, lead + ": " + foot);
  }
});

test("a script with no tags, b-roll or comments has no appendix, and a long title never runs off the page", () => {
  S.state = migrateRows({ schema: 2, title: "A title so long that it could never fit on one line of the page, nor on two lines of it, however small the words are set and however wide the page is", comments: [],
    rows: [{ id: "r0", visualText: "Wide.", audioText: "Hello.", status: "shot" }] });
  const doc = read(buildPdf(null));
  assert.equal(doc.pages.length, 1);
  assert.doesNotMatch(doc.t, /\/Outlines/);
  const lines = doc.pages[0].texts.filter((o) => o.size === 20);
  assert.equal(lines.length, 2);
  assert.match(lines[1].str, / [a-z]+…$/);
  lines.forEach((l) => assert.ok(l.x + pdfTextWidth(l.str, true, 20) <= PW - M + 0.01, l.str));
  assert.ok(!doc.pages[0].texts.some((o) => /^Target/.test(o.str)));
});
