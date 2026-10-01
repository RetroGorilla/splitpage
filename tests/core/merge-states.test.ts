import { test } from "node:test";
import assert from "node:assert/strict";
import { STATE_FIELDS } from "../../src/core/document/fields.ts";
import type { StateField } from "../../src/core/document/fields.ts";
import { mergeStates } from "../../src/core/merge-states.ts";
import type { MergeStatesPorts } from "../../src/core/merge-states.ts";
import type { MergeDoc } from "../../src/core/merge/states.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { T } from "./text/cells.ts";
import { fakeDecoder, fixedClock, EDITOR } from "./merge/fakes.ts";
import { fakeMigration, jsonCopy, pngDataUrl } from "./migrate-ports.ts";

type Doc = Record<string, unknown>;
type Item = Record<string, unknown>;

const PROBE: StateField = {
  key: "probe",
  def: () => "start",
  normalize: (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined),
  merge: "changed-side-wins",
  undo: true
};

const WITH_PROBE: readonly StateField[] = [...STATE_FIELDS, PROBE];

function portsFor(fields?: readonly StateField[]): MergeStatesPorts & { migration: ReturnType<typeof fakeMigration> } {
  const migration = fakeMigration();
  const { decode } = fakeDecoder([[T("hello")], [T("hello there")], [T("hello you")]]);
  return {
    decode: decode,
    ids: migration.ids,
    clock: fixedClock,
    editor: () => EDITOR,
    fields: fields,
    migrate: migration.ports,
    migration: migration
  };
}

function migrated(doc: Doc, fields?: readonly StateField[]): MergeDoc {
  return migrateRows(doc, fakeMigration(undefined, fields).ports) as MergeDoc;
}

test("INV-04: a field added to the table survives migrateRows, mergeStates and a .splitpage round trip, with no other edit", () => {
  const base = migrated({ docId: "d" + "1".repeat(32), rows: [] }, WITH_PROBE);
  assert.equal(base.probe, "start");
  const mine = jsonCopy(base);
  mine.probe = "  mine  ";
  const theirs = jsonCopy(base);
  theirs.title = "Their title";

  const r = mergeStates(base, mine, theirs, portsFor(WITH_PROBE));
  assert.equal(r.merged.probe, "mine", "merged by its strategy, then normalised by migrateRows");
  assert.equal(r.merged.title, "Their title");
  const keys = Object.keys(r.merged);
  assert.deepEqual(keys, WITH_PROBE.map((f) => f.key).filter((k) => k in r.merged));
  assert.ok(keys.includes("probe"));

  const saved = JSON.stringify(r.merged, null, 2);
  const reopened = migrateRows(JSON.parse(saved), fakeMigration(undefined, WITH_PROBE).ports);
  assert.equal(JSON.stringify(reopened, null, 2), saved, "a .splitpage file is the migrated document, read back unchanged");

  const plain = mergeStates(migrated({ rows: [] }), migrated({ rows: [] }), migrated({ rows: [] }), portsFor());
  assert.equal("probe" in plain.merged, false, "core's own table has no such field");
});

test("the merged document is migrated with the merge's own table, whatever the migrate ports carry", () => {
  const ports = portsFor(WITH_PROBE);
  const withOther = Object.assign({}, ports, { migrate: Object.assign({}, ports.migrate, { fields: [] }) });
  const doc = migrated({ rows: [] });
  const r = mergeStates(jsonCopy(doc), jsonCopy(doc), jsonCopy(doc), withOther);
  assert.equal(r.merged.probe, "start");
  assert.equal(r.merged.wordsPerMinute, 150);
});

test("a field with no strategy throws before anything is migrated", () => {
  const ports = portsFor([...STATE_FIELDS, { key: "probe", merge: "no-such-strategy" as StateField["merge"], undo: false }]);
  const theirs: Doc = { rows: [], comments: [{ id: "c1", body: '<img src="' + pngDataUrl(3, 3, 9) + '">' }] };
  assert.throws(() => mergeStates(null, { rows: [] }, theirs as MergeDoc, ports), /^Error: no merge strategy for state field probe$/);
  assert.deepEqual(ports.migration.log, []);
  assert.equal(ports.migration.images.pending().length, 0);
});

test("the merge's conflict cards and pictures are migrated in the same pass, ids from the one IdSource", () => {
  const ports = portsFor();
  const base = migrated({ docId: "d" + "1".repeat(32), rows: [{ id: "r1", audioText: "hello" }] });
  const mine = jsonCopy(base);
  const theirs = jsonCopy(base);
  ((mine.rows as Item[])[0] as Item).audioText = "hello there";
  ((theirs.rows as Item[])[0] as Item).audioText = "hello you";
  const url = pngDataUrl(7, 7, 11);
  (theirs.comments as Item[]).push({ id: "cT", rowId: "r1", field: "audioText", body: '<img src="' + url + '">' });
  const r = mergeStates(base, mine, theirs, ports);
  assert.equal(r.conflicts.length, 1);
  const comments = r.merged.comments as Item[];
  const card = comments.find((c) => c.kind === "conflict") as Item;
  assert.equal(card.id, "c-fake-1");
  assert.equal(card.anchorId, "c-fake-1", "migrateRows fills the card's anchor");
  assert.equal(card.author, EDITOR);
  const pic = comments.find((c) => c.id === "cT") as Item;
  const pending = ports.migration.images.pending();
  assert.equal(pending.length, 1);
  assert.match(pic.body as string, new RegExp('data-blob="' + (pending[0] as { ref: { sha256: string } }).ref.sha256 + '"'));
});

test("today's reply aliasing: a comment both sides hold keeps their reply objects, and migrateRows writes into them", () => {
  const ports = portsFor();
  const doc = migrated({ docId: "d" + "1".repeat(32), rows: [], comments: [{ id: "c1", body: "x", createdAt: "2026-01-01T00:00:00.000Z" }] });
  const mine = jsonCopy(doc), theirs = jsonCopy(doc);
  const mineReply: Item = { id: "rpM", body: "mine", createdAt: "2026-01-02T00:00:00.000Z" };
  ((mine.comments as Item[])[0] as Item).replies = [mineReply];
  ((theirs.comments as Item[])[0] as Item).replies = [{ id: "rpT", body: "theirs", createdAt: "2026-01-03T00:00:00.000Z" }];
  const r = mergeStates(doc, mine, theirs, ports);
  const replies = ((r.merged.comments as Item[])[0] as Item).replies as Item[];
  assert.equal(replies[0], mineReply);
  assert.equal(mineReply.author, "Anonymous");
});
