import { mintTagId } from "../core/document/tags.ts";
import { DEFAULT_WPM } from "../core/document/timing.ts";
import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { legacyMdToHtml, mediaCommentId, migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { refsIn } from "../../shared/blob-policy.js";
import { dataUrlForSync } from "../adapters/storage/02c-blobs.js";
import { __init as initTags, collectTagsFromRows } from "../js/07-production-tags.js";

initTags();

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function doc(over) {
  return migrateRows(Object.assign({ schema: 2, title: "T", rows: [] }, over));
}

test("garbage in is a document out, never a throw", () => {
  for (const junk of [null, undefined, 42, "a string", []]) {
    const s = migrateRows(junk);
    assert.ok(Array.isArray(s.rows));
    assert.ok(Array.isArray(s.comments));
    assert.match(s.docId, /^d[0-9a-f]{32}$/);
  }
});

test("a stray non-object in a list never takes the whole load down", () => {
  const s = migrateRows({
    schema: 2, title: "T",
    rows: [null, 7, { id: "r1", audioText: "one" }, "x"],
    comments: [null, { id: "c1", rowId: "r1" }],
    people: [null, { id: "p1", name: "Sam" }],
    productionTags: [null, { cat: "prop", name: "Kettle" }],
    brollShots: [null, { id: "b1", name: "Rooftop" }]
  });
  assert.deepEqual(s.rows.map((r) => r.id), ["r1"]);
  assert.equal(s.comments.length, 1);
  assert.equal(s.people.length, 1);
  assert.equal(s.productionTags.length, 1);
  assert.equal(s.brollShots.length, 1);
});

test("rows: script, iframe and event handlers never survive", () => {
  const s = doc({ rows: [{
    id: "r1",
    audioText: '<b>keep</b><script>alert(1)</script><img src=x onerror="alert(1)">',
    visualText: '<iframe src="https://evil.test"></iframe><em>fine</em>'
  }] });
  const row = s.rows[0];
  assert.ok(!/script|onerror|iframe/i.test(row.audioText + row.visualText), row.audioText + " | " + row.visualText);
  assert.ok(row.audioText.includes("keep"));
  assert.ok(row.visualText.includes("<em>fine</em>"));
});

const PNG_BYTES = Buffer.from(PNG.slice(PNG.indexOf(",") + 1), "base64");
const PNG_SHA = createHash("sha256").update(PNG_BYTES).digest("hex");
const PNG_REF = { sha256: PNG_SHA, width: 1, height: 1, mime: "image/png" };
const STORED_PNG = '<img class="comment-img" data-blob="' + PNG_SHA + '" data-w="1" data-h="1" data-mime="image/png">';

test("rows: a legacy inline image becomes an imageRef, content-addressed (#82)", () => {
  const row = doc({ rows: [{ id: "r1", visualImage: PNG }] }).rows[0];
  assert.deepEqual(row.imageRef, PNG_REF);
  assert.equal("visualImage" in row, false, "the data: URI is gone from the row");
  assert.equal(dataUrlForSync(PNG_SHA), PNG);
});

test("rows: the migration is deterministic, and migrating twice changes nothing", () => {
  const a = doc({ rows: [{ id: "r1", visualImage: PNG }] });
  const b = doc({ rows: [{ id: "r1", visualImage: "data:image/png;base64," + PNG.slice(22).replace(/(.{20})/g, "$1\n") }] });
  assert.deepEqual(a.rows[0].imageRef, b.rows[0].imageRef, "however the base64 was wrapped");
  const again = migrateRows(JSON.parse(JSON.stringify(a)));
  assert.deepEqual(again.rows[0], a.rows[0]);
});

test("rows: only an inline data: image or a valid imageRef is a visual", () => {
  for (const bad of ["https://evil.test/x.png", "javascript:alert(1)", "data:text/html;base64,AAA", 42,
    "data:image/png;base64,AAAA" ]) {
    const row = doc({ rows: [{ id: "r1", visualImage: bad }] }).rows[0];
    assert.equal(row.imageRef, null, "rejected " + JSON.stringify(bad));
    assert.equal("visualImage" in row, false);
  }
  for (const bad of [{ ...PNG_REF, sha256: PNG_SHA.toUpperCase() }, { ...PNG_REF, mime: "image/svg+xml" },
    { ...PNG_REF, width: 0 }, "a string", [PNG_REF]]) {
    assert.equal(doc({ rows: [{ id: "r1", imageRef: bad }] }).rows[0].imageRef, null, "rejected " + JSON.stringify(bad));
  }
  assert.deepEqual(doc({ rows: [{ id: "r1", imageRef: { ...PNG_REF, extra: "x" } }] }).rows[0].imageRef, PNG_REF);
  const other = { sha256: "a".repeat(64), width: 5, height: 5, mime: "image/jpeg" };
  assert.deepEqual(doc({ rows: [{ id: "r1", visualImage: PNG, imageRef: other }] }).rows[0].imageRef, PNG_REF);
  assert.deepEqual(doc({ rows: [{ id: "r1", visualImage: "data:image/png;base64,AAAA", imageRef: other }] }).rows[0].imageRef, other);
});

test("comments: an image conflict card holds its picture as imageValue, its body the stored form", () => {
  const legacy = doc({ rows: [{ id: "r1" }], comments: [{
    id: "c1", rowId: "r1", field: "visualImage", kind: "conflict",
    body: '<img class="comment-img" src="' + PNG + '">', conflictField: "Visual image"
  }] }).comments[0];
  assert.deepEqual(legacy.imageValue, PNG_REF);
  assert.equal(legacy.body, STORED_PNG);
  const kept = doc({ rows: [{ id: "r1" }], comments: [{
    id: "c1", rowId: "r1", field: "visualImage", kind: "conflict", body: "", imageValue: { ...PNG_REF, x: 1 }
  }] }).comments[0];
  assert.deepEqual(kept.imageValue, PNG_REF);
  assert.equal(kept.body, STORED_PNG, "a body drawn from the record");
  const ghost = "e".repeat(64);
  const stale = doc({ rows: [{ id: "r1" }], comments: [{
    id: "c1", rowId: "r1", field: "visualImage", kind: "conflict",
    body: '<img class="comment-img" data-blob="' + ghost + '">', imageValue: PNG_REF
  }] }).comments[0];
  assert.deepEqual(stale.imageValue, PNG_REF);
  assert.equal(stale.body, STORED_PNG);
  const emptied = doc({ rows: [{ id: "r1" }], comments: [{
    id: "c1", rowId: "r1", field: "visualImage", kind: "conflict", body: "", imageValue: null, emptyValue: true
  }] }).comments[0];
  assert.equal(emptied.imageValue, null);
  assert.equal(emptied.body, "");
  const ordinary = doc({ rows: [{ id: "r1" }], comments: [{
    id: "c2", rowId: "r1", field: "audioText", body: "hi", imageValue: PNG_REF
  }] }).comments[0];
  assert.equal("imageValue" in ordinary, false, "only an image conflict card has one");
});

test("rows: an unknown status falls back to todo, a known one is kept", () => {
  assert.equal(doc({ rows: [{ id: "r1", status: "shot" }] }).rows[0].status, "shot");
  assert.equal(doc({ rows: [{ id: "r1", status: "ready" }] }).rows[0].status, "ready");
  assert.equal(doc({ rows: [{ id: "r1", status: "nonsense" }] }).rows[0].status, "todo");
  assert.equal(doc({ rows: [{ id: "r1" }] }).rows[0].status, "todo");
});

test("rows: an id that could escape a selector is replaced", () => {
  const s = doc({ rows: [{ id: '" ] , #rows *', audioText: "x" }] });
  assert.match(s.rows[0].id, /^[A-Za-z0-9_-]+$/);
});

test("rows: updatedAt is '' rather than null when nothing ever stamped it", () => {
  assert.equal(doc({ rows: [{ id: "r1" }] }).rows[0].updatedAt, "");
  assert.equal(doc({ rows: [{ id: "r1", updatedAt: null }] }).rows[0].updatedAt, "");
});

test("legacy rows are converted once, and a stray '<' survives as text", () => {
  const s = migrateRows({ title: "T", rows: [{ id: "r1", audioText: "Bring the **tape** <insert B-roll here>" }] });
  assert.ok(s.rows[0].audioText.includes("<strong>tape</strong>"));
  assert.ok(s.rows[0].audioText.includes("insert B-roll here"), s.rows[0].audioText);
});

test("legacyMdToHtml round-trips everything htmlToMarkdown can emit", () => {
  assert.equal(legacyMdToHtml("~~gone~~"), "<s>gone</s>");
  assert.equal(legacyMdToHtml("<u>under</u>"), "<u>under</u>");
  assert.equal(legacyMdToHtml("<mark>lit</mark>"), "<mark>lit</mark>");
  assert.equal(legacyMdToHtml("a<br>b"), "a<br>b");
  assert.equal(legacyMdToHtml("a\nb"), "a<br>b");
  assert.equal(legacyMdToHtml("**b** and *i*"), "<strong>b</strong> and <em>i</em>");
});

test("legacyMdToHtml reads the elements the model's toMarkdown falls back to", () => {
  assert.equal(legacyMdToHtml('a<strong>"q"</strong>b'), "a<strong>&quot;q&quot;</strong>b");
  assert.equal(legacyMdToHtml("*de* <em>fgh</em> <strong>a <em>b</em></strong>"), "<em>de</em> <em>fgh</em> <strong>a <em>b</em></strong>");
  assert.equal(legacyMdToHtml("x<S>y</S>"), "x<s>y</s>");
  assert.equal(legacyMdToHtml("<em>open"), "&lt;em&gt;open");
  assert.equal(legacyMdToHtml("<strong>a</em>"), "&lt;strong&gt;a&lt;/em&gt;");
});

test("legacyMdToHtml does not double-encode a link's query string", () => {
  const out = legacyMdToHtml("[go](https://x.test/?a=1&b=2)");
  assert.ok(out.includes('href="https://x.test/?a=1&amp;b=2"'), out);
  assert.ok(!legacyMdToHtml("[x](javascript:alert(1))").includes("<a "));
});

test("comments: a document-level conflict card is never given a fake row", () => {
  const c = doc({ comments: [{ id: "c1", field: "title", kind: "conflict", body: "mine" }] }).comments[0];
  assert.equal(c.rowId, null);
  assert.equal(c.anchorId, null);
  assert.equal(c.field, "title");
});

test("comments: anchorId falls back to the comment's own id, never to null", () => {
  const c = doc({ comments: [{ id: "c1", rowId: "r1", field: "audioText" }] }).comments[0];
  assert.equal(c.anchorId, "c1");
});

test("comments: an unknown field folds to audioText", () => {
  const f = (v) => doc({ comments: [{ id: "c1", rowId: "r1", field: v }] }).comments[0].field;
  assert.equal(f("visualText"), "visualText");
  assert.equal(f("visualImage"), "visualImage");
  assert.equal(f("whatever"), "audioText");
  assert.equal(f(undefined), "audioText");
});

test("comments: an unresolved comment never shows a resolver", () => {
  const c = doc({ comments: [{ id: "c1", rowId: "r1", resolved: false, resolvedBy: "Sam", resolvedAt: "2026-01-01" }] }).comments[0];
  assert.equal(c.resolvedBy, null);
  assert.equal(c.resolvedAt, null);
  const d = doc({ comments: [{ id: "c1", rowId: "r1", resolved: true, resolvedAt: "2026-01-01" }] }).comments[0];
  assert.equal(d.resolvedBy, null);
  assert.equal(d.resolvedAt, null);
});

test("comments: bodies and replies are sanitised, authors are plain text", () => {
  const c = doc({ comments: [{
    id: "c1", rowId: "r1",
    body: '<b>hi</b><script>x</script>',
    author: "<b>Sam</b>",
    quotedText: "<i>quoted</i>",
    replies: [null, { id: "rp1", body: '<em>ok</em><img src=x onerror=y>', author: "" }]
  }] }).comments[0];
  assert.ok(!/script/i.test(c.body));
  assert.equal(c.author, "Sam");
  assert.equal(c.quotedText, "quoted");
  assert.equal(c.replies.length, 1);
  assert.ok(!/onerror/i.test(c.replies[0].body));
  assert.equal(c.replies[0].author, "Anonymous");
});

test("people: nameless entries are dropped, names are plain text", () => {
  const s = doc({ people: [{ id: "p1", name: "  <b>Sam</b>  " }, { id: "p2", name: "   " }, { id: "p3" }] });
  assert.deepEqual(s.people.map((p) => p.name), ["Sam"]);
});

test("productionTags: a dangling owner reads as unassigned", () => {
  const s = doc({
    people: [{ id: "p1", name: "Sam" }],
    productionTags: [
      { cat: "prop", name: "Kettle", owner: "p1" },
      { cat: "prop", name: "Ladder", owner: "p9" },
      { cat: "prop", name: "Rope", owner: "constructor" }
    ]
  });
  assert.deepEqual(s.productionTags.map((t) => t.owner), ["p1", "", ""]);
});

test("productionTags: an unknown category or status falls back, a nameless tag is dropped", () => {
  const s = doc({ productionTags: [
    { cat: "nonsense", name: "Kettle", status: "nonsense" },
    { cat: "prop", name: "   " }
  ] });
  assert.equal(s.productionTags.length, 1);
  assert.ok(s.productionTags[0].cat);
  assert.ok(s.productionTags[0].status);
});

test("productionTags: a file saved before the registry existed is back-filled from the script", () => {
  const s = migrateRows({
    schema: 2, title: "T",
    rows: [{ id: "r1", audioText: 'Bring the <span class="tag-anchor" data-tag-cat="prop" data-tag-name="gaffer tape">gaffer tape</span>.' }]
  });
  assert.ok(s.productionTags.some((t) => t.name === "gaffer tape"), JSON.stringify(s.productionTags));
});

test("productionTags: a live tag missing from an existing registry is healed in, once (#84)", () => {
  const s = doc({
    rows: [{ id: "r1", audioText: 'Bring the <span class="tag-anchor" data-tag-cat="prop" data-tag-name="gaffer tape">gaffer tape</span> and the <span class="tag-anchor" data-tag-cat="location" data-tag-name="Roof">Roof</span>.' }],
    productionTags: [{ cat: "prop", name: "Kettle", owner: "", notes: "", status: "have" }, { cat: "location", name: "roof" }]
  });
  assert.deepEqual(s.productionTags.map((t) => t.cat + ":" + t.name), ["prop:Kettle", "location:roof", "prop:gaffer tape"]);
  assert.deepEqual(s.productionTags[2], { cat: "prop", name: "gaffer tape", owner: "", notes: "", status: "needed",
                                          id: mintTagId("prop", "gaffer tape") });
  const twice = migrateRows(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(twice.productionTags, s.productionTags);
});

test("productionTags: an emptied registry stays empty when nothing is tagged live", () => {
  const s = doc({ rows: [{ id: "r1", audioText: "No tags here." }], productionTags: [] });
  assert.deepEqual(s.productionTags, []);
});

test("productionTags: the collector the back-fill was meant to use still reads the script", () => {
  const rows = [{ id: "r1", audioText: 'Bring the <span class="tag-anchor" data-tag-cat="prop" data-tag-name="gaffer tape">gaffer tape</span>.' }];
  assert.deepEqual(collectTagsFromRows(rows).map((t) => t.name), ["gaffer tape"]);
});

test("brollShots: nameless entries go, origin and reshoot are booleans of one shape", () => {
  const s = doc({ brollShots: [
    { id: "b1", name: "Rooftop", origin: "list", reshoot: "yes" },
    { id: "b2", name: "Alley" },
    { id: "b3", name: "" }
  ] });
  assert.deepEqual(s.brollShots.map((b) => b.name), ["Rooftop", "Alley"]);
  assert.equal(s.brollShots[0].origin, "list");
  assert.equal(s.brollShots[0].reshoot, false, "only a real true is true");
  assert.equal(s.brollShots[1].origin, "script");
});

test("wordsPerMinute is clamped to something a human can read at", () => {
  assert.equal(doc({ wordsPerMinute: 175 }).wordsPerMinute, 175);
  assert.equal(doc({ wordsPerMinute: "175" }).wordsPerMinute, 175);
  assert.equal(doc({ wordsPerMinute: 175.4 }).wordsPerMinute, 175);
  for (const bad of [0, 59, 401, -1, NaN, Infinity, "fast", null]) {
    assert.equal(doc({ wordsPerMinute: bad }).wordsPerMinute, DEFAULT_WPM, "rejected " + String(bad));
  }
});

test("the title is plain text, and bounded", () => {
  assert.equal(doc({ title: "<b>Hi</b>" }).title, "Hi");
  assert.equal(doc({ title: "x".repeat(500) }).title.length, 300);
});

test("migrating twice changes nothing the second time", () => {
  const once = migrateRows({
    title: "T", schema: 2,
    rows: [{ id: "r1", audioText: "<strong>bold</strong> &amp; <em>it</em>", visualImage: PNG, status: "shot" }],
    comments: [{ id: "c1", rowId: "r1", body: "<b>note</b>", author: "Sam", createdAt: "2026-01-01T00:00:00.000Z" }],
    people: [{ id: "p1", name: "Sam" }],
    productionTags: [{ cat: "prop", name: "Kettle", owner: "p1" }],
    brollShots: [{ id: "b1", name: "Rooftop" }],
    wordsPerMinute: 175
  });
  const twice = migrateRows(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

const SHA_X = "ab".repeat(32);
const cellPic = (sha) => '<img class="comment-img" data-blob="' + sha + '" data-w="4" data-h="3" data-mime="image/png">';
const VIDEO = "https://www.youtube.com/watch?v=abc";
const videoCard = '<a class="video-embed-card" href="' + VIDEO + '" target="_blank" rel="noopener"><span class="vec-play">▶</span>' +
  '<span>Watch video</span><span class="vec-host">· youtube.com</span></a>';

function withPictureInCell() {
  return {
    schema: 2, title: "T",
    rows: [
      { id: "r1", visualText: "wide " + cellPic(SHA_X) + " shot", audioText: "hello", updatedAt: "2026-05-01T10:00:00.000Z" },
      { id: "r2", visualText: "close", audioText: "watch " + videoCard + " this", updatedAt: "" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", body: "a note", author: "Sam" }]
  };
}

test("a picture in a script cell becomes one comment on that scene holding it", () => {
  const s = migrateRows(withPictureInCell());
  assert.equal(s.rows[0].visualText, "wide  shot", "the words stay, the picture goes");
  const moved = s.comments.filter((c) => c.rowId === "r1" && c.field === "visualText");
  assert.equal(moved.length, 1);
  const c = moved[0];
  assert.equal(c.id, mediaCommentId("r1", "visualText", "img:" + SHA_X));
  assert.ok(c.body.endsWith("<br>" + cellPic(SHA_X)), c.body);
  assert.equal(c.author, "Splitpage");
  assert.equal(c.quotedText, "");
  assert.equal(c.kind, "anchor");
  assert.equal(c.resolved, false);
  assert.equal(c.createdAt, "2026-05-01T10:00:00.000Z", "when the row last changed, not now");
  assert.ok(!s.rows.some((r) => (r.visualText + r.audioText).indexOf('data-cmt="' + c.anchorId + '"') !== -1));
  assert.deepEqual(refsIn(s), [SHA_X]);
  assert.equal(s.comments[0].id, "c1");
  assert.equal(s.comments[0].body, "a note");
});

test("a video card in a script cell becomes a comment holding the card", () => {
  const s = migrateRows(withPictureInCell());
  assert.equal(s.rows[1].audioText, "watch  this");
  const moved = s.comments.filter((c) => c.rowId === "r2" && c.field === "audioText");
  assert.equal(moved.length, 1);
  assert.equal(moved[0].id, mediaCommentId("r2", "audioText", "video:" + VIDEO));
  assert.ok(moved[0].body.endsWith("<br>" + videoCard), moved[0].body);
});

test("moving pictures out of cells is idempotent", () => {
  const once = migrateRows(withPictureInCell());
  assert.equal(once.comments.length, 3);
  const twice = migrateRows(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  const dup = migrateRows({ schema: 2, title: "T", rows: [{ id: "r1", visualText: cellPic(SHA_X) + " and " + cellPic(SHA_X), audioText: "" }] });
  assert.equal(dup.comments.length, 1);
  assert.deepEqual(migrateRows(withPictureInCell()).comments.map((c) => c.id), once.comments.map((c) => c.id));
});

test("a picture two copies both moved merges into one comment", () => {
  const base = migrateRows(withPictureInCell());
  const mine = migrateRows(withPictureInCell());
  const theirs = migrateRows(withPictureInCell());
  mine.rows[0].audioText = "hello there";
  theirs.rows[1].visualText = "close up";
  const merged = migrateRows(mergeStates(base, mine, theirs).merged);
  assert.equal(merged.comments.filter((c) => c.rowId === "r1" && c.field === "visualText").length, 1);
  assert.equal(merged.comments.filter((c) => c.rowId === "r2" && c.field === "audioText").length, 1);
  assert.equal(merged.comments.length, 3);
  assert.equal(merged.rows[0].audioText, "hello there");
  assert.equal(merged.rows[1].visualText, "close up");
  const old = withPictureInCell();
  const half = migrateRows(mergeStates(old, mine, old).merged);
  assert.equal(half.comments.filter((c) => c.rowId === "r1" && c.field === "visualText").length, 1);
  assert.equal(half.rows[0].visualText.indexOf("<img"), -1);
});

test("brollShots props: every shot has a list, and garbage is tolerated rather than thrown on", () => {
  const junk = [null, 42, "Ladder", { name: "" }, { id: "not an id", name: "Rope" }, [], { name: { x: 1 } },
    { id: "t_zzzz", name: "<b>Tarp</b>" }];
  const s = doc({ brollShots: [{ id: "b1", name: "Rooftop" }, { id: "b2", name: "Alley", props: junk },
    { id: "b3", name: "Pier", props: "Kettle" }] });
  assert.deepEqual(s.brollShots[0].props, [], "a shot from before props gets an empty list");
  assert.deepEqual(s.brollShots[1].props, [
    { id: "", name: "Ladder" }, { id: "", name: "Rope" }, { id: "t_zzzz", name: "Tarp" }
  ]);
  assert.deepEqual(s.brollShots[2].props, [], "a list that is not a list is none");
});

test("brollShots props: a name the registry does not know is kept, by name", () => {
  const s = doc({ productionTags: [{ cat: "prop", name: "Kettle" }],
    brollShots: [{ id: "b1", name: "Rooftop", props: [{ name: "Drone spare batteries" }] }] });
  assert.deepEqual(s.brollShots[0].props, [{ id: "", name: "Drone spare batteries" }]);
});

test("brollShots props: an id takes its entry's current name; a known name takes its entry's id", () => {
  const s = doc({ productionTags: [{ cat: "prop", name: "Kettle" }, { cat: "gear", name: "Tripod" }] });
  const kettle = s.productionTags[0].id, tripod = s.productionTags[1].id;
  const t = doc({ productionTags: s.productionTags, brollShots: [{ id: "b1", name: "Rooftop", props: [
    { id: kettle, name: "old kettle name" }, { name: "KETTLE" }, { name: "tripod" }
  ] }] });
  assert.deepEqual(t.brollShots[0].props, [{ id: kettle, name: "Kettle" }, { id: "", name: "tripod" }]);
  assert.notEqual(tripod, "");
});

test("brollShots props: duplicates go, names are bounded, the list is capped", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ name: "Prop " + (i % 60) }));
  many.unshift({ name: "x".repeat(300) });
  const s = doc({ brollShots: [{ id: "b1", name: "Rooftop", props: many }] });
  const props = s.brollShots[0].props;
  assert.equal(props[0].name.length, 80);
  assert.equal(props.length, 40);
  assert.equal(new Set(props.map((p) => p.name)).size, props.length);
});

test("brollShots props: migrating twice changes nothing the second time", () => {
  const once = doc({ productionTags: [{ cat: "prop", name: "Kettle" }],
    brollShots: [{ id: "b1", name: "Rooftop", props: [{ name: "kettle" }, { name: "Rope" }, null] }] });
  assert.deepEqual(migrateRows(JSON.parse(JSON.stringify(once))), once);
});
