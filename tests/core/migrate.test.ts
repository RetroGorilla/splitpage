import { test } from "node:test";
import assert from "node:assert/strict";
import { STATE_FIELDS } from "../../src/core/document/fields.ts";
import type { StateField } from "../../src/core/document/fields.ts";
import { deriveDocId, mediaCommentId } from "../../src/core/document/ids.ts";
import { storedImageHtml } from "../../src/core/document/text-policy.ts";
import { DEFAULT_WPM } from "../../src/core/document/timing.ts";
import { isDocumentObject, migrateDocument, migrateRows } from "../../src/core/migrate.ts";
import { T } from "./text/cells.ts";
import { fakeMigration, jsonCopy, pngDataUrl } from "./migrate-ports.ts";

type Doc = Record<string, unknown>;
type Item = Record<string, unknown>;

const MINTED_DOC_ID = "d" + "f".repeat(32);

function list(doc: Doc, key: string): Item[] {
  return doc[key] as Item[];
}

function tagged(cat: string, name: string) {
  return T(name, { tag: "t:" + cat + ":" + name });
}

test("a conflict card's picture, used nowhere else, is found in the same pass from an empty registry", () => {
  const f = fakeMigration();
  const url = pngDataUrl(640, 360, 1);
  const doc: Doc = { schema: 2, rows: [], comments: [{ id: "c1", kind: "conflict", field: "visualImage", rowId: "r1", body: '<img src="' + url + '">' }] };
  const out = migrateRows(doc, f.ports);
  const card = list(out, "comments")[0] as Item;
  const pending = f.images.pending();
  assert.equal(pending.length, 1);
  const ref = (pending[0] as { ref: { sha256: string } }).ref;
  assert.deepEqual(card.imageValue, ref);
  assert.equal(card.body, storedImageHtml(ref));
  const sha = ref.sha256.slice(0, 4);
  assert.ok(f.log.indexOf("fromDataUrl:" + sha) < f.log.indexOf("known:" + sha), "the body is sanitised before the card looks its picture up");
  assert.equal(f.log.includes("registry:" + sha), false, "the lookup is answered from the pending set");
});

test("a conflict card whose picture is in neither the pass nor the registry keeps a valid imageValue, else none", () => {
  const f = fakeMigration();
  const known = { sha256: "a".repeat(64), width: 3, height: 4, mime: "image/png" };
  const doc: Doc = {
    schema: 2, rows: [], comments: [
      { id: "c1", kind: "conflict", field: "visualImage", body: '<img class="comment-img" data-blob="' + "b".repeat(64) + '">', imageValue: known },
      { id: "c2", kind: "conflict", field: "visualImage", body: "", imageValue: { sha256: "nope" } },
      { id: "c3", kind: "anchor", field: "audioText", body: "x", imageValue: known }
    ]
  };
  const out = list(migrateRows(doc, f.ports), "comments");
  assert.deepEqual((out[0] as Item).imageValue, known);
  assert.equal((out[0] as Item).body, storedImageHtml(known));
  assert.equal((out[1] as Item).imageValue, null);
  assert.equal((out[1] as Item).body, "");
  assert.equal("imageValue" in (out[2] as Item), false);
});

test("a conflict card's body picture wins over a valid imageValue naming a different picture", () => {
  const f = fakeMigration();
  const other = { sha256: "b".repeat(64), width: 3, height: 4, mime: "image/png" };
  const url = pngDataUrl(640, 360, 7);
  const doc: Doc = {
    schema: 2, rows: [], comments: [
      { id: "c1", kind: "conflict", field: "visualImage", rowId: "r1", body: '<img src="' + url + '">', imageValue: other }
    ]
  };
  const card = list(migrateRows(doc, f.ports), "comments")[0] as Item;
  const pending = f.images.pending();
  assert.equal(pending.length, 1);
  const ref = (pending[0] as { ref: { sha256: string } }).ref;
  assert.notEqual(ref.sha256, other.sha256);
  assert.deepEqual(card.imageValue, ref, "imageValue is the body's picture, not the stored one");
  assert.equal(card.body, storedImageHtml(ref));
  assert.match(card.body as string, new RegExp('data-blob="' + ref.sha256 + '"'));
  assert.equal((card.body as string).includes(other.sha256), false);
});

test("the document is changed in place and returned, with existing keys where they were and new ones after", () => {
  const f = fakeMigration();
  const row: Item = { audioText: "a", id: "r1", lengthSeconds: -1, visualImage: "not a picture" };
  const doc: Doc = { wordsPerMinute: 200, title: "T", rows: [row], extra: 1 };
  const out = migrateRows(doc, f.ports);
  assert.equal(out, doc);
  assert.equal(list(out, "rows")[0], row);
  assert.deepEqual(Object.keys(out), ["wordsPerMinute", "title", "rows", "extra", "comments", "people", "productionTags", "brollShots", "rev", "docId", "schema"]);
  assert.deepEqual(Object.keys(row), ["audioText", "id", "status", "visualText", "imageRef", "updatedAt", "updatedBy"]);
});

test("hadTagRegistry is read before defaults fill the registry in, so a file saved before it derives the registry", () => {
  const before = fakeMigration();
  const cell = before.cell([T("pick up the "), tagged("prop", "Kettle")]);
  const derived = list(migrateRows({ schema: 2, rows: [{ id: "r1", audioText: cell }] }, before.ports), "productionTags");
  assert.deepEqual(derived.map((t) => Object.keys(t)), [["cat", "name", "status", "owner", "notes", "id"]]);

  for (const registry of [[], undefined]) {
    const after = fakeMigration();
    const cell2 = after.cell([T("pick up the "), tagged("prop", "Kettle")]);
    const kept = list(migrateRows({ schema: 2, rows: [{ id: "r1", audioText: cell2 }], productionTags: registry }, after.ports), "productionTags");
    assert.deepEqual(kept.map((t) => Object.keys(t)), [["cat", "name", "owner", "notes", "status", "id"]]);
    assert.deepEqual({ cat: kept[0]?.cat, name: kept[0]?.name }, { cat: "prop", name: "Kettle" });
  }
});

test("normalize: wordsPerMinute falls back to the default, personColors goes on null, targetSeconds goes on undefined", () => {
  const cases: [Doc, Doc][] = [
    [{ wordsPerMinute: "180.4", personColors: { Ann: "#80bdfb" }, targetSeconds: 90.4 }, { wordsPerMinute: 180, personColors: { Ann: "#80BDFB" }, targetSeconds: 90 }],
    [{ wordsPerMinute: "abc", personColors: { Bo: "red" }, targetSeconds: 0 }, { wordsPerMinute: DEFAULT_WPM }],
    [{ wordsPerMinute: 59, personColors: null, targetSeconds: "60" }, { wordsPerMinute: DEFAULT_WPM }],
    [{ wordsPerMinute: 399.6 }, { wordsPerMinute: 400 }],
    [{ wordsPerMinute: 400.4 }, { wordsPerMinute: DEFAULT_WPM }],
    [{}, { wordsPerMinute: DEFAULT_WPM }]
  ];
  for (const [input, want] of cases) {
    const out = migrateRows(Object.assign({ schema: 2, rows: [] }, input), fakeMigration().ports);
    const got: Doc = {};
    for (const k of ["wordsPerMinute", "personColors", "targetSeconds"]) if (k in out) got[k] = out[k];
    assert.deepEqual(got, want, JSON.stringify(input));
  }
  const kept = migrateRows({ personColors: { Ann: "#80bdfb" }, title: "x", targetSeconds: 30 }, fakeMigration().ports);
  assert.deepEqual(Object.keys(kept).slice(0, 3), ["personColors", "title", "targetSeconds"], "a normalised field keeps its place");
});

test("normalize comes from the table: it runs on a field the document holds, and undefined removes the field", () => {
  const seen: unknown[] = [];
  const probe: StateField = {
    key: "probe", def: () => 1, merge: "constant", undo: false,
    normalize: (v) => { seen.push(v); return typeof v === "number" ? v * 2 : undefined; }
  };
  const loose: StateField = { key: "loose", merge: "constant", undo: false, normalize: () => { throw new Error("called on an absent field"); } };
  const fields = [...STATE_FIELDS, probe, loose];
  assert.equal(migrateRows({}, fakeMigration(undefined, fields).ports).probe, 2);
  assert.equal(migrateRows({ probe: 3 }, fakeMigration(undefined, fields).ports).probe, 6);
  assert.equal("probe" in migrateRows({ probe: "x" }, fakeMigration(undefined, fields).ports), false);
  assert.deepEqual(seen, [1, 3, "x"]);
  assert.equal("probe" in migrateRows({}, fakeMigration().ports), false, "the default table is core's");
});

test("ids and the docId come from the IdSource port, in today's order", () => {
  const f = fakeMigration();
  const out = migrateRows({
    schema: 2,
    rows: [{}],
    comments: [{ field: "audioText", replies: [{}] }],
    people: [{ name: "Ann" }],
    brollShots: [{ name: "Shot" }]
  }, f.ports);
  assert.deepEqual(f.ids.minted, ["r-fake-1", "c-fake-2", "r-fake-3", "rp-fake-4", "p-fake-5", "bs-fake-6"]);
  assert.equal(out.docId, MINTED_DOC_ID);
  const c = list(out, "comments")[0] as Item;
  assert.equal(c.anchorId, "c-fake-2");
  assert.equal(migrateRows({ docId: "d" + "1".repeat(32) }, fakeMigration().ports).docId, "d" + "1".repeat(32));
});

test("pictures and video cards leave a cell for comments, once, through the ports", () => {
  const f = fakeMigration();
  const url = pngDataUrl(20, 10, 2);
  const card = '<a class="video-embed-card" href="https://youtu.be/x">card</a>';
  const doc: Doc = { schema: 2, rows: [{ id: "r1", updatedAt: "2026-01-01T00:00:00.000Z", audioText: 'say <img src="' + url + '"> hi', visualText: "see " + card }] };
  const out = migrateRows(doc, f.ports);
  const row = list(out, "rows")[0] as Item;
  assert.equal(row.audioText, "say  hi");
  assert.equal(row.visualText, "see ");
  const ref = (f.images.pending()[0] as { ref: { sha256: string } }).ref;
  const comments = list(out, "comments");
  assert.deepEqual(comments.map((c) => c.id), [
    mediaCommentId("r1", "visualText", "video:https://youtu.be/x"),
    mediaCommentId("r1", "audioText", "img:" + ref.sha256)
  ]);
  assert.match(comments[0]?.body as string, /<br><a class="video-embed-card" href="https:\/\/youtu.be\/x">card<\/a>$/);
  assert.match(comments[1]?.body as string, new RegExp("<br>" + storedImageHtml(ref) + "$"));
  assert.ok(f.log.includes("videoCard"));
  const again = migrateRows(jsonCopy(out), fakeMigration().ports);
  assert.equal(list(again, "comments").length, 2, "a second pass adds nothing");
  doc.rows = [{ id: "r1", audioText: 'say <img src="' + url + '">' }];
  doc.comments = [{ id: comments[1]?.id, body: "kept" }];
  const held = list(migrateRows(doc, fakeMigration().ports), "comments");
  assert.deepEqual(held.map((c) => c.body), ["kept"], "a comment already holding that id keeps it");
});

test("a stored comment whose id only cleans to the media comment's id still holds it: no duplicate, and the id draws are pinned", () => {
  const url = pngDataUrl(20, 10, 2);
  const rows = (): Item[] => [{ id: "r1", audioText: 'say <img src="' + url + '">' }];
  const probe = fakeMigration();
  const mediaId = (list(migrateRows({ schema: 2, rows: rows() }, probe.ports), "comments")[0] as Item).id as string;
  assert.match(mediaId, /^cm[0-9a-f]{24}$/);
  assert.deepEqual(probe.ids.minted, []);

  const f = fakeMigration();
  const out = migrateRows({ schema: 2, rows: rows(), comments: [{ id: mediaId + "!", field: "audioText", body: "kept" }] }, f.ports);
  const comments = list(out, "comments");
  assert.deepEqual(comments.map((c) => [c.id, c.body]), [[mediaId, "kept"]], "the media comment is not added a second time");
  assert.deepEqual(f.ids.minted, ["r-fake-1"], "the dedupe pass draws nothing; only the stored comment's missing rowId does");
});

test("a schema 1 document's scene text is Markdown, converted before it is sanitised", () => {
  const f = fakeMigration();
  const out = migrateRows({ schema: 1, rows: [{ id: "r1", audioText: "**bold** & *it*" }] }, f.ports);
  assert.equal((list(out, "rows")[0] as Item).audioText, "<strong>bold</strong> &amp; <em>it</em>");
  const now = migrateRows({ schema: 2, rows: [{ id: "r1", audioText: "**bold**" }] }, fakeMigration().ports);
  assert.equal((list(now, "rows")[0] as Item).audioText, "**bold**");
});

test("odd shapes: no document, lists that are not lists, and members that are not objects", () => {
  for (const input of [null, undefined, 5, "x"]) {
    const out = migrateRows(input, fakeMigration().ports);
    assert.equal(out.title, "Untitled Script");
    assert.deepEqual(out.rows, []);
    assert.equal(out.schema, 2);
  }
  const out = migrateRows({
    rows: "nope", comments: [null, 1, { id: "c1", replies: [null, "r", { id: "rp1" }] }],
    people: [{ id: "p1", name: "  " }, 3], productionTags: [null, { cat: "nope", name: "X", status: "bad", owner: "p9" }],
    brollShots: [{ name: "" }, "s", { name: "Keep", status: "odd", reshoot: "true", origin: "elsewhere", owner: "p1" }]
  }, fakeMigration().ports);
  assert.deepEqual(out.rows, []);
  assert.deepEqual(list(out, "comments").map((c) => (c.replies as Item[]).map((r) => r.id)), [["rp1"]]);
  assert.deepEqual(out.people, []);
  assert.deepEqual(list(out, "productionTags").map((t) => [t.cat, t.name, t.status, t.owner]), [["prop", "X", "needed", ""]]);
  assert.deepEqual(list(out, "brollShots").map((b) => [b.name, b.status, b.reshoot, b.origin, b.owner]), [["Keep", "unshot", false, "script", ""]]);
});

test("migrateDocument: an embedded docId stays, a file derives one from its text, the server's comes from its id", () => {
  const embedded = "d" + "1".repeat(32);
  assert.equal(migrateDocument({ docId: embedded, rows: [] }, { kind: "file" }, fakeMigration().ports).docId, embedded);

  const raw = { title: "Saved", rows: [{ id: "r1", audioText: "x" }] };
  const seed = JSON.stringify(raw);
  assert.equal(migrateDocument(raw, { kind: "file" }, fakeMigration().ports).docId, deriveDocId("splitpage-file", seed));

  const fallback = "d" + "2".repeat(32);
  assert.equal(migrateDocument({ rows: [] }, { kind: "server", serverId: 42, fallbackId: fallback }, fakeMigration().ports).docId, fallback);
  assert.equal(migrateDocument({ rows: [] }, { kind: "server", serverId: 42, fallbackId: "bad" }, fakeMigration().ports).docId, deriveDocId("splitpage-server-doc", "42"));
  assert.equal(migrateDocument({ rows: [] }, { kind: "server" }, fakeMigration().ports).docId, MINTED_DOC_ID);
  assert.equal(migrateDocument({ rows: [] }, null, fakeMigration().ports).docId, MINTED_DOC_ID);
  assert.equal(migrateDocument({ rows: [] }, { kind: "fresh" }, fakeMigration().ports).docId, MINTED_DOC_ID);
});

function cutAt(cap: number): string {
  return "n".repeat(cap - 1) + " x";
}

function keptAt(cap: number): string {
  return "n".repeat(cap - 1);
}

const REF_A = { sha256: "a".repeat(64), width: 4, height: 4, mime: "image/png" };
const REF_B = { sha256: "b".repeat(64), width: 4, height: 4, mime: "image/png" };

function cappedDocument(f: ReturnType<typeof fakeMigration>, name: (cap: number) => string): Doc {
  return {
    schema: 2,
    rows: [{
      id: "r1", audioText: f.cell([T("the "), tagged("prop", name(80))]), updatedBy: name(80),
      imageRef: REF_A, imageName: name(200), imageLinks: [{ name: name(200) }],
      moreImages: [{ imageRef: REF_B, name: name(200), links: [{ name: name(200) }] }]
    }],
    comments: [{
      id: "c1", rowId: "r1", author: name(80), resolved: true, resolvedBy: name(80), assignee: name(80),
      replies: [{ id: "rp1", author: name(80) }]
    }],
    people: [{ id: "p1", name: name(60) }],
    productionTags: [{ cat: "location", name: name(80) }],
    brollShots: [{ id: "bs1", name: name(200), location: name(80), props: [name(80)] }]
  };
}

function cappedNames(out: Doc): Record<string, unknown> {
  const row = list(out, "rows")[0] as Item;
  const more = (row.moreImages as Item[])[0] as Item;
  const c = list(out, "comments")[0] as Item;
  const shot = list(out, "brollShots")[0] as Item;
  return {
    updatedBy: row.updatedBy, imageName: row.imageName, imageLink: (row.imageLinks as Item[])[0]?.name,
    moreName: more.name, moreLink: (more.links as Item[])[0]?.name,
    author: c.author, resolvedBy: c.resolvedBy, assignee: c.assignee, replyAuthor: (c.replies as Item[])[0]?.author,
    person: (list(out, "people")[0] as Item).name,
    tags: list(out, "productionTags").map((t) => t.name),
    shot: shot.name, location: shot.location, prop: (shot.props as Item[])[0]?.name
  };
}

function cappedWant(name: (cap: number) => string): Record<string, unknown> {
  return {
    updatedBy: name(80), imageName: name(200), imageLink: name(200), moreName: name(200), moreLink: name(200),
    author: name(80), resolvedBy: name(80), assignee: name(80), replyAuthor: name(80),
    person: name(60), tags: [name(80), name(80)], shot: name(200), location: name(80), prop: name(80)
  };
}

test("a name cut at its cap loses the space the cut leaves it ending in, so migrating it again keeps it (#406)", () => {
  const f = fakeMigration();
  const once = migrateRows(cappedDocument(f, cutAt), f.ports);
  assert.deepEqual(cappedNames(once), cappedWant(keptAt));
  const again = fakeMigration();
  cappedDocument(again, cutAt);
  const text = JSON.stringify(once);
  assert.equal(JSON.stringify(migrateRows(jsonCopy(once), again.ports)), text);
});

test("a name is still trimmed before it is cut, so leading spaces don't count toward the cap (#406)", () => {
  const f = fakeMigration();
  const full = (cap: number): string => "n".repeat(cap);
  const out = migrateRows(cappedDocument(f, (cap) => "  " + full(cap) + " tail"), f.ports);
  assert.deepEqual(cappedNames(out), cappedWant(full));
});

test("a name is cut by code point, so an emoji across the cap stays whole, and migrating it again keeps it (#344)", () => {
  const grin = "\u{1F600}";
  const across = (cap: number): string => "a".repeat(cap - 1) + grin + " tail";
  const whole = (cap: number): string => "a".repeat(cap - 1) + grin;
  const f = fakeMigration();
  const once = migrateRows(cappedDocument(f, across), f.ports);
  assert.deepEqual(cappedNames(once), cappedWant(whole));
  const again = fakeMigration();
  cappedDocument(again, across);
  const text = JSON.stringify(once);
  assert.equal(JSON.stringify(migrateRows(jsonCopy(once), again.ports)), text);
});

test("a name left with half an emoji by an earlier cut loses the half (#344)", () => {
  const half = (cap: number): string => "a".repeat(cap - 1) + "\uD83D";
  const f = fakeMigration();
  const out = migrateRows(cappedDocument(f, half), f.ports);
  assert.deepEqual(cappedNames(out), cappedWant((cap) => "a".repeat(cap - 1)));
});

function namesOf(out: Doc, key: string): unknown[] {
  return list(out, key).map((it) => it.name);
}

function healOnce(doc: Doc): Doc {
  const f = fakeMigration();
  const out = migrateRows(doc, f.ports);
  const again = fakeMigration();
  assert.equal(JSON.stringify(migrateRows(jsonCopy(out), again.ports)), JSON.stringify(out), "a fixed point");
  return out;
}

test("a name made only of half an emoji keeps its record, stored as it was (#344)", () => {
  const out = healOnce({
    schema: 2, rows: [], comments: [],
    people: [{ id: "p1", name: "\uD83D" }, { id: "p2", name: " \uDE00 \uD83D " }],
    productionTags: [{ cat: "prop", name: "\uD83D", notes: "keep me" }],
    brollShots: [{ id: "bs1", name: "\uDE00", notes: "keep me", props: ["\uD83D", "mug"] }],
    personColors: { "\uD83D": "#80BDFB" }
  });
  assert.deepEqual(namesOf(out, "people"), ["\uD83D", "\uDE00 \uD83D"]);
  assert.deepEqual(list(out, "productionTags").map((t) => [t.name, t.notes]), [["\uD83D", "keep me"]]);
  assert.deepEqual(list(out, "brollShots").map((b) => [b.name, b.notes]), [["\uDE00", "keep me"]]);
  assert.deepEqual(((list(out, "brollShots")[0] as Item).props as Item[]).map((p) => p.name), ["\uD83D", "mug"]);
  assert.deepEqual(out.personColors, { "\uD83D": "#80BDFB" });
});

test("a name that would heal into another name of its kind keeps its record, stored as it was (#344)", () => {
  const out = healOnce({
    schema: 2, rows: [], comments: [],
    people: [{ id: "p1", name: "Ann\uD83D" }, { id: "p2", name: "Ann" }, { id: "p3", name: "Bo \uD83D" }, { id: "p4", name: "bo" }],
    productionTags: [
      { cat: "prop", name: "mug\uD83D", notes: "first" }, { cat: "prop", name: "mug", notes: "second" },
      { cat: "prop", name: "cup\uD83D" }, { cat: "prop", name: "cup\uDE00" }, { cat: "location", name: "mug\uD83D" }
    ],
    brollShots: [
      { id: "bs1", name: "Wide \uD83D", props: ["pan\uD83D", "pan", "pot\uD83D"] }, { id: "bs2", name: "Wide" }
    ],
    personColors: { "Ann\uD83D": "#80BDFB", "ann": "#F9B64F" }
  });
  assert.deepEqual(namesOf(out, "people"), ["Ann\uD83D", "Ann", "Bo \uD83D", "bo"]);
  assert.deepEqual(list(out, "productionTags").map((t) => [t.cat, t.name, t.notes]), [
    ["prop", "mug\uD83D", "first"], ["prop", "mug", "second"], ["prop", "cup", ""], ["prop", "cup\uDE00", ""], ["location", "mug", ""]
  ]);
  assert.deepEqual(namesOf(out, "brollShots"), ["Wide \uD83D", "Wide"]);
  assert.deepEqual(((list(out, "brollShots")[0] as Item).props as Item[]).map((p) => p.name), ["pan\uD83D", "pan", "pot"]);
  assert.deepEqual(out.personColors, { "Ann\uD83D": "#80BDFB", "ann": "#F9B64F" });
});

test("only a plain object is a document: an array, null and every primitive are refused like no document (#407)", () => {
  for (const raw of [[], [{ id: "r1", audioText: "x" }], null, undefined, 0, 1, "doc", true, false]) {
    assert.equal(isDocumentObject(raw), false, JSON.stringify(raw));
  }
  assert.equal(isDocumentObject({}), true);
  assert.equal(isDocumentObject({ rows: [] }), true);
  assert.equal(isDocumentObject(JSON.parse('{"__proto__":[]}')), true);
  const top = migrateRows([{ id: "r1", audioText: "x" }], fakeMigration().ports);
  assert.deepEqual([Array.isArray(top), top.title, top.rows], [false, "Untitled Script", []], "migrateRows itself stays total; the entries refuse before they call it");
});

test("an array is no object: an array in a list is dropped (#407)", () => {
  const out = migrateRows({
    rows: [[], { id: "r1" }],
    comments: [["c0"], { id: "c1", rowId: "r1", replies: [[], { id: "rp1" }] }],
    people: [["Ann"], { id: "p1", name: "Ann" }],
    productionTags: [[], { cat: "prop", name: "Kettle" }],
    brollShots: [["Shot"], { id: "bs1", name: "Shot" }]
  }, fakeMigration().ports);
  assert.deepEqual(list(out, "rows").map((r) => r.id), ["r1"]);
  assert.deepEqual(list(out, "comments").map((c) => [c.id, (c.replies as Item[]).map((r) => r.id)]), [["c1", ["rp1"]]]);
  assert.deepEqual(list(out, "people").map((p) => p.id), ["p1"]);
  assert.deepEqual(list(out, "productionTags").map((t) => t.name), ["Kettle"]);
  assert.deepEqual(list(out, "brollShots").map((b) => b.id), ["bs1"]);
});

test("a value whose toString or valueOf is not a function is no text: it migrates as empty text and nothing throws (#408)", () => {
  const raw: unknown = JSON.parse('{"schema":2,"title":{"toString":1},"rows":[{"id":{"toString":"r1"},"updatedBy":{"valueOf":null,"toString":null},' +
    '"audioText":{"toString":1},"visualText":{"valueOf":null,"toString":null}}],' +
    '"comments":[{"id":"c1","rowId":{"valueOf":null,"toString":null},"author":{"toString":1},"quotedText":{"toString":1},"body":{"toString":1},' +
    '"replies":[{"id":{"toString":1},"author":{"toString":1},"body":{"toString":1}}]}],"people":[{"id":"p1","name":{"toString":1}},{"id":{"toString":1},"name":"Ann"}],' +
    '"productionTags":[{"cat":"prop","name":"Kettle","notes":{"toString":1},"owner":{"toString":1},"id":{"toString":1}}],' +
    '"brollShots":[{"id":"bs1","name":"Shot","location":{"toString":1},"owner":{"valueOf":null,"toString":null}}],"wordsPerMinute":{"toString":1}}');
  const f = fakeMigration();
  const out = migrateRows(raw, f.ports);
  const row = list(out, "rows")[0] as Item;
  const c = list(out, "comments")[0] as Item;
  assert.equal(out.title, "");
  assert.deepEqual([row.id, row.updatedBy, row.audioText, row.visualText], ["r-fake-1", "Anonymous", "", ""]);
  assert.deepEqual([c.rowId, c.author, c.quotedText, c.body], ["r-fake-2", "Anonymous", "", ""]);
  assert.deepEqual((c.replies as Item[]).map((r) => [r.id, r.author, r.body]), [["rp-fake-3", "Anonymous", ""]]);
  assert.deepEqual(list(out, "people").map((p) => [p.id, p.name]), [["p-fake-4", "Ann"]]);
  const tag = list(out, "productionTags")[0] as Item;
  assert.deepEqual([tag.notes, tag.owner], ["", ""]);
  assert.match(tag.id as string, /^t_[0-9a-z]+$/);
  const shot = list(out, "brollShots")[0] as Item;
  assert.deepEqual([shot.location, shot.owner], ["", ""]);
  assert.equal(out.wordsPerMinute, DEFAULT_WPM);
});

test("a comment's and a reply's createdAt that is not a string becomes null, and updatedAt follows it (#409)", () => {
  const out = migrateRows({
    comments: [
      { id: "c1", rowId: "r1", createdAt: 5, updatedAt: { toString: 1 }, replies: [
        { id: "rp1", createdAt: "2026-10-07T09:00:00.000Z" }, { id: "rp2", createdAt: 5 }, { id: "rp3", createdAt: [] }, { id: "rp4" }, { id: "rp5", createdAt: null }
      ] },
      { id: "c2", rowId: "r1", createdAt: "2026-10-07T09:00:00.000Z", updatedAt: 7 },
      { id: "c3", rowId: "r1", createdAt: "2026-10-07T09:00:00.000Z", updatedAt: "2026-10-08T09:00:00.000Z" }
    ]
  }, fakeMigration().ports);
  const comments = list(out, "comments");
  assert.deepEqual(comments.map((c) => [c.createdAt, c.updatedAt]), [
    [null, null], ["2026-10-07T09:00:00.000Z", "2026-10-07T09:00:00.000Z"], ["2026-10-07T09:00:00.000Z", "2026-10-08T09:00:00.000Z"]
  ]);
  const replies = (comments[0] as Item).replies as Item[];
  assert.deepEqual(replies.map((r) => r.createdAt), ["2026-10-07T09:00:00.000Z", null, null, undefined, null]);
  assert.equal("createdAt" in (replies[3] as Item), false, "a reply with no createdAt gets none");
});

test("a rev that is not a finite number becomes 0 (#412)", () => {
  for (const rev of [NaN, Infinity, -Infinity, "7", null, { valueOf: 7 }]) {
    assert.equal(migrateRows({ rev: rev }, fakeMigration().ports).rev, 0, String(rev));
  }
  assert.equal(migrateRows({ rev: 7 }, fakeMigration().ports).rev, 7);
});

test("a migrated document is a fixed point: migrating it again changes nothing", () => {
  const f = fakeMigration();
  const cell = f.cell([T("a "), tagged("location", "Roof")]);
  const once = migrateRows({
    schema: 2, title: "<b>T</b>", rows: [{ audioText: cell, visualImage: pngDataUrl(4, 4, 3) }],
    comments: [{ body: '<img src="' + pngDataUrl(5, 5, 4) + '">', kind: "conflict", field: "visualImage", resolved: true, resolvedBy: "Ann" }],
    people: [{ name: "Ann" }], brollShots: [{ name: "S", props: ["Kettle"] }], personColors: { Ann: "#80BDFB" }, targetSeconds: 60
  }, f.ports);
  const text = JSON.stringify(once);
  const again = fakeMigration();
  again.cell([T("a "), tagged("location", "Roof")]);
  assert.equal(JSON.stringify(migrateRows(jsonCopy(once), again.ports)), text);
});
