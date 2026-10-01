import { test } from "node:test";
import assert from "node:assert/strict";
import { STATE_FIELDS } from "../../src/core/document/fields.ts";
import type { StateField } from "../../src/core/document/fields.ts";
import { deriveDocId, mediaCommentId } from "../../src/core/document/ids.ts";
import { storedImageHtml } from "../../src/core/document/text-policy.ts";
import { DEFAULT_WPM } from "../../src/core/document/timing.ts";
import { migrateDocument, migrateRows } from "../../src/core/migrate.ts";
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
