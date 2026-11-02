import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDocId } from "../../src/core/document/ids.ts";
import { storedImageHtml } from "../../src/core/document/text-policy.ts";
import { migrateDocument, migrateRows } from "../../src/core/migrate.ts";
import type { MigratePorts } from "../../src/core/migrate.ts";
import { T } from "./text/cells.ts";
import { fakeMigration, pngDataUrl } from "./migrate-ports.ts";

type Doc = Record<string, unknown>;
type Item = Record<string, unknown>;

const MINTED_DOC_ID = "d" + "f".repeat(32);
const REF_A = { sha256: "a".repeat(64), width: 4, height: 4, mime: "image/png" };
const REF_B = { sha256: "b".repeat(64), width: 4, height: 4, mime: "image/png" };

function list(doc: Doc, key: string): Item[] {
  return doc[key] as Item[];
}

function only(items: Item[], key: string): unknown[] {
  return items.map((i) => i[key]);
}

function marked(sanitize: (html: unknown) => string, f = fakeMigration()): MigratePorts {
  return Object.assign({}, f.ports, { sanitize: sanitize });
}

test("a row's status is one of the known ones, else todo", () => {
  const out = migrateRows({ rows: [
    { id: "r1" }, { id: "r2", status: "bogus" }, { id: "r3", status: 5 }, { id: "r4", status: "shot" }, { id: "r5", status: "ready" }
  ] }, fakeMigration().ports);
  assert.deepEqual(only(list(out, "rows"), "status"), ["todo", "todo", "todo", "shot", "ready"]);
});

test("a row's length is a whole number of seconds within range, else none: the key is gone, not undefined", () => {
  const out = migrateRows({ rows: [
    { id: "r1", lengthSeconds: 12.4 }, { id: "r2", lengthSeconds: 0 }, { id: "r3", lengthSeconds: -1 },
    { id: "r4", lengthSeconds: "9" }, { id: "r5" }, { id: "r6", lengthSeconds: Infinity }
  ] }, fakeMigration().ports);
  const rows = list(out, "rows");
  assert.deepEqual(only(rows, "lengthSeconds"), [12, 0, undefined, undefined, undefined, undefined]);
  assert.deepEqual(rows.map((r) => "lengthSeconds" in r), [true, true, false, false, false, false]);
});

test("scene text, comment bodies and replies each go through the sanitiser, after Markdown conversion for a schema 1 file", () => {
  const seen: string[] = [];
  const ports = marked((html) => { seen.push(String(html)); return "S:" + String(html); });
  const out = migrateRows({
    schema: 1, rows: [{ id: "r1", visualText: "**v**", audioText: "a" }],
    comments: [{ id: "c1", rowId: "r1", body: "b", replies: [{ id: "rp1", body: "p" }] }]
  }, ports);
  const row = list(out, "rows")[0] as Item;
  assert.equal(row.visualText, "S:<strong>v</strong>");
  assert.equal(row.audioText, "S:a");
  const c = list(out, "comments")[0] as Item;
  assert.equal(c.body, "S:b");
  assert.equal(((c.replies as Item[])[0] as Item).body, "S:p");
  assert.ok(seen.includes("<strong>v</strong>") && !seen.includes("**v**"), "Markdown is converted before the sanitiser sees it");
});

test("a row's picture: an old inline one is stored and wins over a stored reference, a stored reference is cleaned, anything else is none", () => {
  const f = fakeMigration();
  const url = pngDataUrl(4, 4, 21);
  const out = migrateRows({ schema: 2, rows: [
    { id: "r1", visualImage: url, imageRef: REF_B },
    { id: "r2", imageRef: Object.assign({ extra: "dropped" }, REF_A) },
    { id: "r3", imageRef: { sha256: "not a hash" } },
    { id: "r4", visualImage: "https://example.test/x.png" },
    { id: "r5", visualImage: 7 }
  ] }, f.ports);
  const rows = list(out, "rows");
  const pending = f.images.pending();
  assert.equal(pending.length, 1);
  assert.deepEqual((rows[0] as Item).imageRef, (pending[0] as { ref: unknown }).ref);
  assert.notDeepEqual((rows[0] as Item).imageRef, REF_B);
  assert.deepEqual((rows[1] as Item).imageRef, REF_A);
  assert.deepEqual(rows.slice(2).map((r) => r.imageRef), [null, null, null]);
  assert.deepEqual(rows.map((r) => "visualImage" in r), [false, false, false, false, false], "the old inline picture is not kept");
});

test("a row's last editor is cleaned, and none stays none rather than becoming Anonymous", () => {
  const out = migrateRows({ rows: [{ id: "r1" }, { id: "r2", updatedBy: "" }, { id: "r3", updatedBy: "  Ann <b>B</b> " }, { id: "r4", updatedBy: "\u0001" }] }, fakeMigration().ports);
  assert.deepEqual(only(list(out, "rows"), "updatedBy"), [null, null, "Ann B", "Anonymous"]);
});

test("#1041: the same picture in duplicate rows keeps a comment on each repaired scene", () => {
  const url = pngDataUrl(6, 6, 31);
  const out = migrateRows({ schema: 2, rows: [{ id: "r1", visualText: '<img src="' + url + '">' }, { id: "r1", visualText: 'again <img src="' + url + '">' }] }, fakeMigration().ports);
  assert.equal(list(out, "comments").length, 2);
  assert.deepEqual(only(list(out, "rows"), "id"), ["r1", "r1-1"]);
  assert.deepEqual(only(list(out, "comments"), "rowId"), ["r1", "r1-1"]);
  assert.equal(new Set(only(list(out, "comments"), "id")).size, 2);
  assert.deepEqual(only(list(out, "rows"), "visualText"), ["", "again "]);
});

test("a list that is not a list is an empty list, and a registry that is not a list is read from the rows", () => {
  const f = fakeMigration();
  const out = migrateRows({
    schema: 2, rows: [{ id: "r1", audioText: f.cell([T("a "), T("Roof", { tag: "t:location:Roof" })]) }],
    comments: "nope", people: 5, productionTags: "nope", brollShots: {}
  }, f.ports);
  assert.deepEqual(out.comments, []);
  assert.deepEqual(out.people, []);
  assert.deepEqual(out.brollShots, []);
  assert.deepEqual(list(out, "productionTags").map((t) => [t.cat, t.name]), [["location", "Roof"]]);
});

test("a comment on the title has no row and no anchor, however it was stored", () => {
  const out = migrateRows({ rows: [], comments: [{ id: "c1", field: "title", rowId: "r1", anchorId: "c9" }] }, fakeMigration().ports);
  const c = list(out, "comments")[0] as Item;
  assert.deepEqual([c.field, c.rowId, c.anchorId], ["title", null, null]);
});

test("a comment's row and anchor are cleaned ids, the anchor is its own id by default, and its field is one of the three", () => {
  const out = migrateRows({ rows: [], comments: [
    { id: "c1", rowId: "r 1!", anchorId: "a b!", field: "visualText" },
    { id: "c2", field: "visualImage" },
    { id: "c3", field: "audioText" },
    { id: "c4", field: "bogus" },
    { id: "c5" }
  ] }, fakeMigration().ports);
  const cs = list(out, "comments");
  assert.deepEqual(cs.slice(0, 2).map((c) => [c.rowId, c.anchorId]), [["r1", "ab"], ["r-orphan-1", "c2"]]);
  assert.deepEqual(only(cs, "field"), ["visualText", "visualImage", "audioText", "audioText", "audioText"]);
  assert.equal(cs[4]?.anchorId, "c5");
});

test("a comment on a row that the text moved to another cell follows its anchor", () => {
  const f = fakeMigration();
  const out = migrateRows({
    schema: 2,
    rows: [{ id: "r1", audioText: "", visualText: f.cell([T("hi", { cmt: ["c1"] })]) }],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", body: "x" }]
  }, f.ports);
  assert.equal((list(out, "comments")[0] as Item).field, "visualText");
});

test("a comment's kind is anchor unless it is a conflict, and its text is cleaned", () => {
  const out = migrateRows({ rows: [], comments: [
    { id: "c1" }, { id: "c2", kind: "bogus" }, { id: "c3", kind: "conflict" },
    { id: "c4", quotedText: "hi\uD83D there" }, { id: "c5", quotedText: "<b>bold</b>" }, { id: "c6", quotedText: 12 }
  ] }, fakeMigration().ports);
  const cs = list(out, "comments");
  assert.deepEqual(only(cs, "kind"), ["anchor", "anchor", "conflict", "anchor", "anchor", "anchor"]);
  assert.deepEqual(only(cs, "quotedText"), ["", "", "", "hi there", "bold", "12"]);
});

test("a comment is resolved only when it says true, and a time stays only with a resolver who is named", () => {
  const at = "2026-10-07T09:00:00.000Z";
  const out = migrateRows({ rows: [], comments: [
    { id: "c1", resolved: "yes", resolvedBy: "Ann", resolvedAt: at },
    { id: "c2", resolved: false, resolvedBy: "Ann", resolvedAt: at },
    { id: "c3", resolved: true, resolvedBy: "Ann", resolvedAt: at },
    { id: "c4", resolved: true, resolvedBy: "   ", resolvedAt: at },
    { id: "c5", resolved: true, resolvedAt: at },
    { id: "c6", resolved: true, resolvedBy: "Ann", resolvedAt: 5 },
    { id: "c7", resolved: true, resolvedBy: "Ann", resolvedAt: "" }
  ] }, fakeMigration().ports);
  const cs = list(out, "comments");
  assert.deepEqual(only(cs, "resolved"), [false, false, true, true, true, true, true]);
  assert.deepEqual(only(cs, "resolvedBy"), [null, null, "Ann", null, null, "Ann", "Ann"]);
  assert.deepEqual(only(cs, "resolvedAt"), [null, null, at, null, null, null, null]);
});

test("a comment with no createdAt gets none, so its updatedAt is null", () => {
  const out = migrateRows({ rows: [], comments: [{ id: "c1" }, { id: "c2", createdAt: "2026-10-07T09:00:00.000Z" }] }, fakeMigration().ports);
  const cs = list(out, "comments");
  assert.deepEqual(cs.map((c) => "createdAt" in c), [false, true]);
  assert.deepEqual(only(cs, "updatedAt"), [null, "2026-10-07T09:00:00.000Z"]);
});

test("only a conflict card on a picture is rebuilt from its picture: its body is the picture or nothing", () => {
  const out = migrateRows({ rows: [], comments: [
    { id: "c1", kind: "conflict", field: "visualImage", body: "stray text", imageValue: null },
    { id: "c2", kind: "anchor", field: "visualImage", body: "hi", imageValue: REF_A },
    { id: "c3", kind: "conflict", field: "audioText", body: "words", imageValue: REF_A },
    { id: "c4", kind: "conflict", field: "visualImage", body: "stray", imageValue: REF_A }
  ] }, fakeMigration().ports);
  const cs = list(out, "comments");
  assert.deepEqual(cs.map((c) => c.body), ["", "hi", "words", storedImageHtml(REF_A)]);
  assert.deepEqual(cs.map((c) => "imageValue" in c), [true, false, false, true]);
  assert.deepEqual(cs.map((c) => c.imageValue), [null, undefined, undefined, REF_A]);
});

test("a registry entry with no name is dropped, and a registry read from the rows keeps each tag's own category", () => {
  const f = fakeMigration();
  const out = migrateRows({ schema: 2, rows: [], productionTags: [{ cat: "prop", name: " " }, { cat: "prop", name: "Kettle" }, { cat: "prop" }] }, f.ports);
  assert.deepEqual(list(out, "productionTags").map((t) => t.name), ["Kettle"]);
  const g = fakeMigration();
  const read = migrateRows({ schema: 2, rows: [{ id: "r1", audioText: g.cell([T("Roof", { tag: "t:location:Roof" }), T("Boom", { tag: "t:sound:Boom" })]) }] }, g.ports);
  assert.deepEqual(list(read, "productionTags").map((t) => [t.cat, t.name]), [["location", "Roof"], ["sound", "Boom"]]);
});

test("a shot's props are matched to the registry's prop of that name", () => {
  const out = migrateRows({
    schema: 2, rows: [], productionTags: [{ cat: "prop", name: "Kettle" }, { cat: "location", name: "Spoon" }],
    brollShots: [{ id: "bs1", name: "S", props: ["kettle", "spoon"] }]
  }, fakeMigration().ports);
  const tag = list(out, "productionTags")[0] as Item;
  const props = ((list(out, "brollShots")[0] as Item).props as Item[]);
  assert.deepEqual(props, [{ id: tag.id, name: "Kettle" }, { id: "", name: "spoon" }]);
});

test("an unkeyed line takes the shot id the caller's line map holds for it, and records the one it drew", () => {
  const f = fakeMigration();
  const held = new Map<string, string>(), drawn = new Map<string, string>([["r1\u0000steam\u00001", "bs-shared"]]);
  const ports = Object.assign({}, f.ports, { brollLines: { held: held, drawn: drawn } });
  const out = migrateRows({ schema: 2, rows: [{ id: "r1", visualText: "B-roll: Steam", audioText: "" }, { id: "r2", visualText: "B-roll: Pour", audioText: "" }] }, ports);
  assert.deepEqual(list(out, "brollShots").map((b) => [b.id, b.name]), [["bs-shared", "Steam"], ["bs-23972978fd3b5c68ed82ff7a", "Pour"]]);
  assert.deepEqual([...drawn.entries()], [["r1\u0000steam\u00001", "bs-shared"], ["r2\u0000pour\u00001", "bs-23972978fd3b5c68ed82ff7a"]]);
});

test("migrateDocument: a docId that is not one is replaced, whatever the origin", () => {
  assert.equal(migrateDocument({ docId: "bad", rows: [] }, { kind: "fresh" }, fakeMigration().ports).docId, MINTED_DOC_ID);
  assert.equal(migrateRows({ docId: "bad", rows: [] }, fakeMigration().ports).docId, MINTED_DOC_ID);
});

test("migrateDocument: only a file or a server document gets a docId from where it came from", () => {
  const fallback = "d" + "2".repeat(32);
  for (const kind of ["fresh", "recovered", "paste"]) {
    assert.equal(migrateDocument({ rows: [] }, { kind: kind, serverId: 42, fallbackId: fallback }, fakeMigration().ports).docId, MINTED_DOC_ID, kind);
  }
  assert.equal(migrateDocument({ rows: [] }, { kind: "server", serverId: undefined }, fakeMigration().ports).docId, MINTED_DOC_ID);
  assert.equal(migrateDocument({ rows: [] }, { kind: "server", serverId: 0 }, fakeMigration().ports).docId, deriveDocId("splitpage-server-doc", "0"));
});

test("migrateDocument: a file that cannot be written out still gets a docId, from nothing", () => {
  const loop: Doc = { rows: [] };
  loop.self = loop;
  assert.equal(migrateDocument(loop, { kind: "file" }, fakeMigration().ports).docId, deriveDocId("splitpage-file", ""));
});

