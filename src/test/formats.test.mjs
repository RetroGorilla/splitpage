/* The two document file formats (20d-formats.js): `.splitpage` and the
 * lossless Markdown project.
 *
 * Ported from the serializer half of tests/17-formats.txt, which reached
 * buildSplitpage/parseSplitpage/buildMarkdown/parseMarkdown through
 * window.__splitpageFormats because neither file picker can run headless
 * (#67). What stays in that browser suite is the half that needs a page:
 * openFile() running the real File ▸ Open path, the "scenes don't line up"
 * modal and its two buttons, the rendered tag anchors, and the legacy
 * `.html` project.
 *
 * Invariant #31: a `.splitpage` file IS the state object — no envelope, no
 * translation. Invariant #32: an `.md` file is a table a human can edit
 * plus the record the table cannot carry.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { htmlToMarkdown } from "../js/04-richtext.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { mdSceneCellSource } from "../js/14-export.js";
import {
  applyMarkdownProject,
  buildMarkdownProject,
  buildSplitpageFile,
  fileImagesMissing,
  parseMarkdownProject,
  parseSplitpageFile
} from "../js/20d-formats.js";
import { STORED } from "./_stored-cells.mjs";

/* See migrate-rows.test.mjs: this __init() only builds the memoised tag
   reader, and the Markdown writer's production breakdown needs it. */
initTags();

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG.slice(PNG.indexOf(",") + 1), "base64");
const PNG_REF = { sha256: createHash("sha256").update(PNG_BYTES).digest("hex"), width: 1, height: 1, mime: "image/png" };
const STORED_PNG = '<img class="comment-img" data-blob="' + PNG_REF.sha256 + '" data-w="1" data-h="1" data-mime="image/png">';
const TAG = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="gaffer tape">gaffer tape</span>';
const ANCHOR = '<span class="cmt-anchor" data-cmt="ctest1">Anchored</span>';

/* The document 17-formats.txt builds up by typing into the app: a tagged
   cell, a live comment anchor, an inline image, a scene status, a reading
   speed, a crew member, and a cell full of the characters a fence could
   collide with. */
function fixture() {
  return migrateRows({
    schema: 2,
    title: "Round Trip",
    rows: [
      {
        id: "r1",
        visualText: "Host on camera.",
        visualImage: PNG,
        audioText: ANCHOR + " Bring the " + TAG + " to the kitchen.",
        status: "shot"
      },
      { id: "r2", visualText: "a ~~~~ b | c `d` ~~~~~ and <u>underlined</u>", audioText: "Second scene." }
    ],
    comments: [{
      id: "ctest1", rowId: "r1", field: "audioText", anchorId: "ctest1",
      quotedText: "gaffer tape", author: "Tester", body: "look here",
      resolved: false, kind: "anchor",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", replies: []
    }],
    people: [{ id: "ptest1", name: "Jordan" }],
    productionTags: [{ cat: "prop", name: "gaffer tape", owner: "", notes: "", status: "needed" }],
    wordsPerMinute: 175,
    docId: "d" + "7".repeat(32)
  });
}

/* 17-formats.txt's __norm: drop the fields a save legitimately changes and
   sort every key, so "deep equals" is a comparison that cannot be fooled by
   property order. docId is checked separately wherever it matters. */
function norm(s) {
  const c = migrateRows(JSON.parse(JSON.stringify(s)));
  delete c.rev; delete c.lastEditedAt; delete c.lastEditedBy; delete c.docId;
  return JSON.stringify(sortAll(c));
}
function sortAll(v) {
  if (Array.isArray(v)) return v.map(sortAll);
  if (v && typeof v === "object") {
    const o = {};
    Object.keys(v).sort().forEach((k) => { o[k] = sortAll(v[k]); });
    return o;
  }
  return v;
}

/* buildMarkdownProject's production breakdown reads the live document
   through collectTags(), which is the app's one deliberate global. Point it
   at the fixture rather than leaving it undefined; nothing else here needs
   any app state at all. */
function withState(s, fn) {
  const was = S.state;
  S.state = s;
  try { return fn(s); } finally { S.state = was; }
}

/* ---- .splitpage --------------------------------------------------------- */

test(".splitpage has no envelope: the file IS the state object", () => {
  const s = fixture();
  const parsed = JSON.parse(buildSplitpageFile(s));
  assert.equal(parsed.schema, 2);
  assert.ok(Array.isArray(parsed.rows));
  assert.equal(parsed.rows.length, s.rows.length);
  assert.equal(parsed.title, "Round Trip");
  assert.equal(parsed.docId, s.docId);
});

test(".splitpage round-trips the whole document, byte for byte", () => {
  const s = fixture();
  const back = migrateRows(parseSplitpageFile(buildSplitpageFile(s)));
  assert.equal(norm(back), norm(s));
  assert.equal(back.docId, s.docId);
  assert.deepEqual(back.rows[0].imageRef, PNG_REF);
  assert.equal(back.rows[0].status, "shot");
  assert.ok(back.rows[0].audioText.includes('data-tag-name="gaffer tape"'));
  assert.ok(back.rows[0].audioText.includes('data-cmt="ctest1"'));
});

test("buildSplitpage never writes an unmigrated document", () => {
  /* It is a save path, and every save has to be openable — so it migrates
     on the way out as well as on the way in. */
  const raw = JSON.parse(buildSplitpageFile({ title: "<b>Raw</b>", rows: [{ id: "r1", audioText: "one" }] }));
  assert.equal(raw.title, "Raw");
  assert.equal(raw.schema, 2);
  assert.match(raw.docId, /^d[0-9a-f]{32}$/);
});

test("buildSplitpage does not mutate the document it is handed", () => {
  const s = fixture();
  const before = JSON.stringify(s);
  buildSplitpageFile(s);
  assert.equal(JSON.stringify(s), before);
});

test("parseSplitpage throws on anything that is not one of ours", () => {
  for (const bad of ["not json at all", "null", "[]", '{"rows":"nope"}', '{"title":"x"}', '"a string"']) {
    assert.throws(() => parseSplitpageFile(bad), "accepted " + bad);
  }
  /* Deliberately does NOT migrate: every entry point migrates at the one
     moment it is actually adopting the document, so there is never a
     half-trusted object in flight. */
  const raw = parseSplitpageFile('{"rows":[{"id":"r1"}],"title":"x"}');
  assert.equal(raw.schema, undefined);
  assert.equal(raw.docId, undefined);
});

/* ---- .md ---------------------------------------------------------------- */

test(".md carries the id exactly once, and only inside the data block", () => {
  const s = fixture();
  const md = withState(s, buildMarkdownProject);
  assert.equal((md.match(new RegExp(s.docId, "g")) || []).length, 1);
  assert.ok(md.indexOf(s.docId) > md.indexOf("leave this block alone"));
});

test(".md's human half is a table anyone can read", () => {
  const md = withState(fixture(), buildMarkdownProject);
  assert.ok(md.includes("| # | Visual | Audio | Status |"));
  assert.ok(md.includes("| shot |"));
  assert.ok(md.includes("## Production breakdown"));
  assert.ok(md.startsWith("# Round Trip"));
});

test(".md's fence outgrows any run of tildes in the script", () => {
  /* CommonMark closes a tilde fence on the first line of at least as many
     tildes as opened it, so a script with "~~~~~" typed into it must get a
     longer fence rather than a data block that ends mid-dialogue. */
  const md = withState(fixture(), buildMarkdownProject);
  assert.match(md, /\n~{6}splitpage\n/);
  assert.match(md.slice(md.indexOf("~~~~~~splitpage")), /\n~{6}\n/);

  /* And an ordinary script, with no tildes at all, gets the four-tilde floor. */
  const plain = migrateRows({ schema: 2, title: "P", rows: [{ id: "r1", audioText: "no tildes" }] });
  assert.match(withState(plain, buildMarkdownProject), /\n~{4}splitpage\n/);
});

test(".md round-trips the whole document, including what the table cannot say", () => {
  const s = fixture();
  const md = withState(s, buildMarkdownProject);
  const proj = parseMarkdownProject(md);
  assert.ok(proj);
  assert.equal(proj.docIdEmbedded, true);
  assert.equal(proj.title, "Round Trip");
  assert.equal(proj.table.length, s.rows.length);

  return withState(proj.state, async () => {
    const back = await applyMarkdownProject(proj, { noAsk: true });
    assert.equal(norm(back), norm(s));
    assert.equal(back.docId, s.docId);
    assert.ok(back.rows[0].audioText.includes('data-tag-name="gaffer tape"'), "tags survived");
    assert.ok(back.rows[0].audioText.includes('data-cmt="ctest1"'), "comment anchors survived");
    assert.deepEqual(back.rows[0].imageRef, PNG_REF, "the image survived");
    assert.equal(back.rows[0].status, "shot");
    assert.equal(back.wordsPerMinute, 175);
    assert.ok(back.people.some((p) => p.name === "Jordan"));
  });
});

test("Markdown that is not one of ours parses as null, not as an error", () => {
  /* The caller then falls through to the ordinary lossy import. */
  assert.equal(parseMarkdownProject("# Just a document\n\nNo data block here.\n"), null);
  assert.equal(parseMarkdownProject(""), null);
  assert.equal(parseMarkdownProject(null), null);
  /* A block that is present but unreadable reads the same way: the table is
     still there and still worth importing. */
  assert.equal(parseMarkdownProject("# T\n\n~~~~splitpage\n{ not json\n~~~~\n"), null);
  assert.equal(parseMarkdownProject("# T\n\n~~~~splitpage\n{\"title\":\"x\"}\n~~~~\n"), null,
    "an object with no rows is not one of ours either");
});

test("the LAST opening fence wins", () => {
  /* A script that quotes this very block as an example earlier in its prose
     must not be able to shadow the real one. */
  const s = fixture();
  const real = withState(s, buildMarkdownProject);
  const decoy = "# Decoy\n\n~~~~splitpage\n" + JSON.stringify({ title: "Decoy", rows: [], docId: "d" + "0".repeat(32) }) + "\n~~~~\n\n";
  const proj = parseMarkdownProject(decoy + real);
  assert.ok(proj);
  assert.equal(proj.state.docId, s.docId);
  assert.equal(proj.state.title, "Round Trip");
});

test("only the scene table is read, never the breakdown below it", () => {
  /* The breakdown and the comments appendix are pipe tables too, and
     parseMarkdownTable reads every pipe line it is handed. */
  const s = fixture();
  const proj = parseMarkdownProject(withState(s, buildMarkdownProject));
  assert.equal(proj.table.length, s.rows.length);
});

test("a cell edited outside Splitpage: the table wins for that cell only", () => {
  const s = fixture();
  const md = withState(s, buildMarkdownProject);
  /* The same edit 17-formats.txt makes: append to scene 1's audio cell. */
  const edited = md.replace(/^(\| 01 \|.*)\| (todo|ready|shot) \|$/m, (m, head, st) => head + "right now | " + st + " |");
  assert.notEqual(edited, md);

  const proj = parseMarkdownProject(edited);
  return withState(proj.state, async () => {
    const back = await applyMarkdownProject(proj, { noAsk: true });
    assert.ok(back.rows[0].audioText.includes("right now"), back.rows[0].audioText);
    /* Rebuilt from plain Markdown, so the tag is re-attached by name from
       the registry — that is what keeping the registry as real storage
       buys (§3.4). */
    assert.ok(back.rows[0].audioText.includes('data-tag-name="gaffer tape"'), back.rows[0].audioText);
    /* The comment anchor on a rebuilt cell is gone for good, but the
       comment itself and its quote stay. */
    assert.ok(!back.rows[0].audioText.includes("cmt-anchor"));
    assert.ok(back.comments.some((c) => c.id === "ctest1" && c.quotedText === "gaffer tape"));
    /* Everything the table cannot show is untouched. */
    assert.deepEqual(back.rows[0].imageRef, PNG_REF);
    assert.equal(back.rows[0].status, "shot");
    assert.equal(back.wordsPerMinute, 175);
    assert.equal(back.rows.length, s.rows.length);
    /* And the cell nobody touched keeps the block's HTML exactly, rather
       than being rebuilt lossily from the table. */
    assert.equal(back.rows[1].visualText, s.rows[1].visualText);
  });
});

test("a Visual cell's inline image travels in the table and comes back", () => {
  const s = fixture();
  const md = withState(s, buildMarkdownProject);
  assert.ok(md.includes("![visual for scene 01](" + PNG + ")"), "the image is in the human half too");
  const proj = parseMarkdownProject(md);
  return withState(proj.state, async () => {
    const back = await applyMarkdownProject(proj, { noAsk: true });
    assert.deepEqual(back.rows[0].imageRef, PNG_REF);
  });
});

/* ---- pictures (#82): inline in the file, a ref in the page ------------- */

test(".splitpage carries its pictures inline; the page names them by imageRef", () => {
  const s = fixture();
  assert.deepEqual(s.rows[0].imageRef, PNG_REF, "the migrated document holds a ref");
  assert.equal("visualImage" in s.rows[0], false);
  const text = buildSplitpageFile(s);
  assert.ok(text.includes('"visualImage": "' + PNG + '"'), "the file holds the picture itself");
  assert.ok(!text.includes('"imageRef"'), "and no ref an older client would not understand");
  const parsed = parseSplitpageFile(text);
  assert.equal(parsed.rows[0].visualImage, PNG, "parse does not migrate");
  assert.deepEqual(migrateRows(parsed).rows[0].imageRef, PNG_REF, "opening it gives the ref back");
});

test("three pictures: the state stays small, the file carries all three", () => {
  const big = (n) => {
    /* a real PNG header, padded out to ~200 KB of IDAT-shaped filler */
    const b = Buffer.alloc(200000 + n);
    Buffer.from(PNG_BYTES).copy(b, 0, 0, 33);
    b.write("IDAT", 37, "latin1");
    for (let i = 41; i < b.length; i++) b[i] = (i * 31 + n) & 255;
    return "data:image/png;base64," + b.toString("base64");
  };
  const s = migrateRows({ schema: 2, title: "Pictures", rows: [0, 1, 2].map((n) => ({ id: "p" + n, visualImage: big(n), audioText: "x" })) });
  const shas = s.rows.map((r) => r.imageRef && r.imageRef.sha256);
  assert.equal(new Set(shas).size, 3);
  assert.ok(JSON.stringify(s).length < 10240, "state is " + JSON.stringify(s).length + " bytes");
  const file = buildSplitpageFile(s);
  assert.ok(file.length > 600000, "the file carries the bytes: " + file.length);
  assert.equal((file.match(/"visualImage": "data:image\/png;base64,/g) || []).length, 3);
});

test("a picture whose bytes are nowhere stays a ref in the file, with no picture", () => {
  const ghost = { sha256: "b".repeat(64), width: 4, height: 3, mime: "image/png" };
  const s = migrateRows({ schema: 2, title: "Ghost", rows: [{ id: "g1", imageRef: ghost, audioText: "x" }] });
  const parsed = JSON.parse(buildSplitpageFile(s));
  assert.deepEqual(parsed.rows[0].imageRef, ghost);
  assert.equal("visualImage" in parsed.rows[0], false);
  assert.deepEqual(fileImagesMissing(s), [ghost.sha256]);
  assert.deepEqual(fileImagesMissing(fixture()), []);
});

test("an image conflict card goes into the file with its picture in the body", () => {
  const s = fixture();
  s.comments.push({ id: "cimg", rowId: "r1", field: "visualImage", kind: "conflict", body: "", imageValue: PNG_REF, conflictField: "Visual image" });
  const parsed = JSON.parse(buildSplitpageFile(s));
  const card = parsed.comments.find((c) => c.id === "cimg");
  assert.ok(card.body.includes('src="' + PNG + '"'), card.body);
  const back = migrateRows(parsed).comments.find((c) => c.id === "cimg");
  assert.deepEqual(back.imageValue, PNG_REF);
  assert.equal(back.body, STORED_PNG, "back to the stored form, no data: in it");
});

test(".md: a cell an older client wrote with the picture spelled differently is unchanged", () => {
  const s = fixture();
  const md = withState(s, buildMarkdownProject);
  /* the same picture, its base64 without its padding and the type
     written as "image/jpg": what matters is the bytes */
  const respelled = "data:image/jpg;base64," + PNG.slice(PNG.indexOf(",") + 1).replace(/=+$/, "");
  const older = md.split(PNG).join(respelled);
  assert.notEqual(older, md);
  const proj = parseMarkdownProject(older);
  return withState(proj.state, async () => {
    const back = await applyMarkdownProject(proj, { noAsk: true });
    assert.deepEqual(back.rows[0].imageRef, PNG_REF);
    assert.equal(back.rows[0].visualText, s.rows[0].visualText, "not rebuilt from the table");
  });
});

test("a scene added by hand is never adopted silently", () => {
  /* noAsk is the merge review's probe, not a choice made on the user's
     behalf: it takes "keep the record", exactly what Esc means, and the
     file is never adopted from that read. The modal itself is UI and stays
     in tests/17-formats.txt. */
  const s = fixture();
  const md = withState(s, buildMarkdownProject);
  const added = md.replace(/^\| 01 \|.*$/m, (l) => l + "\n| 01b | extra visual | extra audio | todo |");
  const proj = parseMarkdownProject(added);
  assert.equal(proj.table.length, s.rows.length + 1);
  return withState(proj.state, async () => {
    const back = await applyMarkdownProject(proj, { noAsk: true });
    assert.equal(back.rows.length, s.rows.length);
    assert.equal(norm(back), norm(s));
  });
});

test("a blank scene is still a row of the table", () => {
  /* keepEmpty: dropping it would misread every later row as shifted and pop
     the "scenes were added or removed" question on every open of a document
     with one empty scene in it. */
  const s = migrateRows({
    schema: 2, title: "Blank",
    rows: [{ id: "r1", audioText: "one" }, { id: "r2" }, { id: "r3", audioText: "three" }]
  });
  const proj = parseMarkdownProject(withState(s, buildMarkdownProject));
  assert.equal(proj.table.length, 3);
});

test("the .md title heading beats the block's title", () => {
  /* The heading is the half a human edits. */
  const s = fixture();
  const md = withState(s, buildMarkdownProject).replace("# Round Trip", "# Renamed Elsewhere");
  const proj = parseMarkdownProject(md);
  return withState(proj.state, async () => {
    const back = await applyMarkdownProject(proj, { noAsk: true });
    assert.equal(back.title, "Renamed Elsewhere");
  });
});

/* ---- the table and the document model (#85 step 3) ----

   The table's cells stay htmlToMarkdown() of the block's HTML: every copy
   of the app, older ones included, reads a cell that differs from its own
   rendering of the block as edited by hand, and rebuilds it (see
   mdSceneCellSource, 14-export.js). These pin the round trip on cells as
   they are really stored, and the one thing reading does for a later
   switch: a cell in the model's Markdown is unchanged as well. */

function storedDocument() {
  const rows = [];
  for (let k = 0; k + 1 < STORED.length; k += 2) {
    rows.push({ id: "r" + k, visualText: STORED[k], audioText: STORED[k + 1], status: "todo" });
  }
  const comments = ["c0", "c1", "c2"].map((id) => ({
    id, rowId: "r0", field: "audioText", anchorId: id, quotedText: "", author: "Tester", body: "note",
    resolved: false, kind: "anchor", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", replies: []
  }));
  return migrateRows({ schema: 2, title: "Stored", rows, comments, docId: "d" + "8".repeat(32) });
}

test(".md: stored-shape cells come back byte for byte, and a second save writes the same file", async () => {
  const s = storedDocument();
  const html = s.rows.map((r) => [r.visualText, r.audioText]);
  const md = withState(s, buildMarkdownProject);
  const proj = parseMarkdownProject(md);
  await withState(proj.state, async () => {
    const back = await applyMarkdownProject(proj, { noAsk: true });
    assert.deepEqual(back.rows.map((r) => [r.visualText, r.audioText]), html, "no cell rebuilt from the table");
    assert.equal(withState(back, buildMarkdownProject), md);
  });
});

test(".md: the table is htmlToMarkdown of the stored HTML, which is not the model's Markdown", () => {
  let differs = 0;
  for (let i = 0; i < STORED.length; i++) {
    const row = { id: "r", visualText: "", audioText: STORED[i], imageRef: null };
    const table = mdSceneCellSource(row, 0).audio;
    assert.equal(table, htmlToMarkdown(STORED[i]).replace(/\n/g, "<br>").trim());
    if (mdSceneCellSource(row, 0, true).audio !== table) differs++;
  }
  /* writing these any other way would make every copy that reads with
     htmlToMarkdown rebuild them from the table */
  assert.ok(differs > 100, "cells whose two renderings differ: " + differs);
});

test(".md: a table cell in the model's Markdown reads as unchanged", async () => {
  const s = migrateRows({
    schema: 2, title: "Model",
    rows: [{ id: "r1", visualText: "", audioText: '<strong>bo</strong><span class="cmt-anchor" data-cmt="c1"><strong>ld</strong></span> <em>x </em>' + TAG }],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "ld", author: "T", body: "b",
      resolved: false, kind: "anchor", createdAt: "", updatedAt: "", replies: [] }],
    productionTags: [{ cat: "prop", name: "gaffer tape" }]
  });
  const md = withState(s, buildMarkdownProject);
  const was = mdSceneCellSource(s.rows[0], 0).audio, model = mdSceneCellSource(s.rows[0], 0, true).audio;
  assert.equal(was, "**bo****ld** *x *gaffer tape");
  assert.equal(model, "**bold** *x* gaffer tape");
  const proj = parseMarkdownProject(md.replace("| " + was + " |", "| " + model + " |"));
  await withState(proj.state, async () => {
    const back = await applyMarkdownProject(proj, { noAsk: true });
    assert.equal(back.rows[0].audioText, s.rows[0].audioText, "kept, anchor and tag and all");
  });
  /* and a real edit is still an edit */
  const edited = parseMarkdownProject(md.replace("| " + was + " |", "| " + model + " now |"));
  await withState(edited.state, async () => {
    const back = await applyMarkdownProject(edited, { noAsk: true });
    assert.match(back.rows[0].audioText, /now/);
    assert.doesNotMatch(back.rows[0].audioText, /cmt-anchor/);
  });
});

/* ---- a b-roll shot's hand-added props (#149) ---- */

function withBrollProps() {
  const s = fixture();
  s.productionTags.push({ cat: "prop", name: "Drone", owner: "", notes: "", status: "have" });
  s.rows[1].visualText = '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> gulls over the pier';
  s.brollShots = [{ id: "bs1", name: "gulls over the pier", status: "shot", props: [{ name: "Drone" }, { name: "Bird seed" }] }];
  return migrateRows(s);
}

test(".splitpage carries a shot's props, id and name, and they come back the same", () => {
  const s = withBrollProps();
  const drone = s.productionTags.find((t) => t.name === "Drone").id;
  assert.deepEqual(s.brollShots[0].props, [{ id: drone, name: "Drone" }, { id: "", name: "Bird seed" }]);
  const back = migrateRows(parseSplitpageFile(buildSplitpageFile(s)));
  assert.equal(norm(back), norm(s));
  assert.deepEqual(back.brollShots[0].props, s.brollShots[0].props);
});

test(".md carries a shot's props in its data block, and they come back the same", () => {
  const s = withBrollProps();
  const md = withState(s, buildMarkdownProject);
  const proj = parseMarkdownProject(md);
  return withState(proj.state, async () => {
    const back = await applyMarkdownProject(proj, { noAsk: true });
    assert.equal(norm(back), norm(s));
    assert.deepEqual(back.brollShots[0].props, s.brollShots[0].props);
  });
});

test("writing a .md lists shots without adding any to the list", () => {
  /* the breakdown under the table asks which shots need each prop; a line
     with no record yet must not get one because a file was written */
  const s = withBrollProps();
  s.rows[0].visualText = "B-roll: a line nobody has opened the panel for";
  const before = JSON.stringify(s.brollShots);
  withState(s, buildMarkdownProject);
  assert.equal(JSON.stringify(s.brollShots), before);
});
