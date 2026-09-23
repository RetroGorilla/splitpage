/* migrateRows (02-state.js) — the ONE door (HANDOFF §3.2).
 *
 * Everything that arrives from outside the page goes through here: a file
 * on disk, a version somebody else published, a restored snapshot, a
 * paste, a merge result. It is the only place untrusted content is
 * normalised and sanitised, and it is the last thing that runs before a
 * document becomes `state`. If it drops a field, the field is gone from
 * the document for good.
 *
 * There was no unit test over it before #67 — it was reachable only as
 * window.__splitpageFormats.migrate from a booted browser. These cases are
 * what tests/17-formats.txt, tests/22-doc-id.txt and tests/51-merge-fields
 * .txt asserted through that hook, plus the per-field normalisation rules
 * that were carrying nothing but a comment.
 *
 * This file needs a DOM because sanitizeHtml does (see _dom.mjs); it needs
 * no page.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { legacyMdToHtml, migrateRows } from "../js/02-state.js";
import { dataUrlForSync } from "../js/02c-blobs.js";
import { DEFAULT_WPM } from "../js/01-scene-status.js";
import { __init as initTags, collectTagsFromRows, mintTagId } from "../js/07-production-tags.js";

/* One of migrateRows' branches — back-filling the production registry out
   of a script that predates it — reads the tags in a cell through
   `tagsInField`, and that is a memoised closure 07-production-tags.js
   builds in its own __init(). Calling it is not booting the app: this
   __init() only assigns two module-scope values and touches nothing
   outside itself. Without it that one branch throws, which is worth
   knowing about rather than routing around. */
initTags();

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* schema: 2 is "already migrated once" — without it every cell goes
   through the legacy plain-text conversion, which is a different code
   path and the one the legacy cases below exercise deliberately. */
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
  /* A bad merge, a hand-edited save, a truncated file: one null must not
     throw on the field access that follows. */
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
  /* the bytes are in the page's registry, so everything that shows or
     writes the picture still can */
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
    "data:image/png;base64,AAAA" /* passes safeImageSrc, but is not a picture */]) {
    const row = doc({ rows: [{ id: "r1", visualImage: bad }] }).rows[0];
    assert.equal(row.imageRef, null, "rejected " + JSON.stringify(bad));
    assert.equal("visualImage" in row, false);
  }
  for (const bad of [{ ...PNG_REF, sha256: PNG_SHA.toUpperCase() }, { ...PNG_REF, mime: "image/svg+xml" },
    { ...PNG_REF, width: 0 }, "a string", [PNG_REF]]) {
    assert.equal(doc({ rows: [{ id: "r1", imageRef: bad }] }).rows[0].imageRef, null, "rejected " + JSON.stringify(bad));
  }
  /* a valid ref is kept, normalised to its four fields */
  assert.deepEqual(doc({ rows: [{ id: "r1", imageRef: { ...PNG_REF, extra: "x" } }] }).rows[0].imageRef, PNG_REF);
  /* a valid inline picture wins over a ref the row also carries */
  const other = { sha256: "a".repeat(64), width: 5, height: 5, mime: "image/jpeg" };
  assert.deepEqual(doc({ rows: [{ id: "r1", visualImage: PNG, imageRef: other }] }).rows[0].imageRef, PNG_REF);
  /* and an unreadable one does not wipe out a good ref */
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
  /* a body naming a picture the record does not: the record wins unless
     this page holds the body's bytes */
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
  /* new Date(null) is a VALID date (the epoch) while new Date("") is not,
     so null here rendered as a fabricated "Jan 1, 12:00 AM". */
  assert.equal(doc({ rows: [{ id: "r1" }] }).rows[0].updatedAt, "");
  assert.equal(doc({ rows: [{ id: "r1", updatedAt: null }] }).rows[0].updatedAt, "");
});

test("legacy rows are converted once, and a stray '<' survives as text", () => {
  /* There used to be an early return for text containing a '<'. A row
     older than the schema predates rich text by definition, so it can
     never legitimately contain markup — that check only ever fired on
     plain text with a bracketed note in it, and deleted it. */
  const s = migrateRows({ title: "T", rows: [{ id: "r1", audioText: "Bring the **tape** <insert B-roll here>" }] });
  assert.ok(s.rows[0].audioText.includes("<strong>tape</strong>"));
  assert.ok(s.rows[0].audioText.includes("insert B-roll here"), s.rows[0].audioText);
});

test("legacyMdToHtml round-trips everything htmlToMarkdown can emit", () => {
  /* Without these, a Markdown cell edited outside Splitpage and reconciled
     back in lost every strikethrough, underline and highlight, and every
     line break came back as the literal text "<br>". */
  assert.equal(legacyMdToHtml("~~gone~~"), "<s>gone</s>");
  assert.equal(legacyMdToHtml("<u>under</u>"), "<u>under</u>");
  assert.equal(legacyMdToHtml("<mark>lit</mark>"), "<mark>lit</mark>");
  assert.equal(legacyMdToHtml("a<br>b"), "a<br>b");
  assert.equal(legacyMdToHtml("a\nb"), "a<br>b");
  assert.equal(legacyMdToHtml("**b** and *i*"), "<strong>b</strong> and <em>i</em>");
});

test("legacyMdToHtml does not double-encode a link's query string", () => {
  /* safeHref only validates a scheme prefix; escaping the already-escaped
     URL a second time turned "&" into "&amp;amp;" and corrupted the link. */
  const out = legacyMdToHtml("[go](https://x.test/?a=1&b=2)");
  assert.ok(out.includes('href="https://x.test/?a=1&amp;b=2"'), out);
  /* A hostile scheme is left as the literal Markdown, not turned into a link. */
  assert.ok(!legacyMdToHtml("[x](javascript:alert(1))").includes("<a "));
});

test("comments: a document-level conflict card is never given a fake row", () => {
  /* Forcing rowId through safeId would fabricate a row id out of null and
     quietly turn the card into an ordinary row comment pointing at it. */
  const c = doc({ comments: [{ id: "c1", field: "title", kind: "conflict", body: "mine" }] }).comments[0];
  assert.equal(c.rowId, null);
  assert.equal(c.anchorId, null);
  assert.equal(c.field, "title");
});

test("comments: anchorId falls back to the comment's own id, never to null", () => {
  /* deleteComment looks the anchor span up by anchorId; null never matches
     any real span, so deleting such a comment left a dangling wrapper in
     the row forever. */
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
  /* And a resolve with no recorded resolver has no timestamp to show either. */
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
  /* Including one that collides with an inherited Object.prototype member,
     which a plain {} lookup used to resolve truthy. */
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

/* KNOWN BROKEN, recorded rather than asserted away — the first thing this
   file found. migrateRows still carries the back-fill branch
   (`if (!Array.isArray(s.productionTags)) s.productionTags =
   collectTagsFromRows(...)`) whose comment promises that opening a file
   saved before the registry existed "doesn't just silently start tracking
   nothing". #60 then put the STATE_FIELDS defaults pass AHEAD of it, and
   that pass gives every document a `productionTags: []` — so the branch
   below it can never run again, and such a file now opens tracking
   nothing, exactly as the comment says it must not. Either the default
   goes or the back-fill moves in front of it; both are a behaviour change
   this issue (#67, tests only) must not make on its own. */
test("productionTags: a file saved before the registry existed is back-filled from the script", () => {
  const s = migrateRows({
    schema: 2, title: "T",
    rows: [{ id: "r1", audioText: 'Bring the <span class="tag-anchor" data-tag-cat="prop" data-tag-name="gaffer tape">gaffer tape</span>.' }]
  });
  assert.ok(s.productionTags.some((t) => t.name === "gaffer tape"), JSON.stringify(s.productionTags));
});

test("productionTags: a live tag missing from an existing registry is healed in, once (#84)", () => {
  /* The registry self-heal used to happen as a side effect of the first
     read of the breakdown after a load; it is a migration step now, so a
     document still looks the same the moment it is on screen. An orphaned
     entry (no live tag) is kept, and a second migration adds nothing. */
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
  /* So the todo above is a wiring failure in migrateRows, not a claim that
     tag collection itself is broken. */
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
  /* Every ingress path can run this over content that has already been
     through it — a merge result is migrated, then saved, then migrated
     again on open. A second pass that keeps escaping or re-converting
     would corrode a document a little on every round trip. */
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
