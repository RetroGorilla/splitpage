import { test } from "node:test";
import assert from "node:assert/strict";
import { changesBetween } from "../../../src/application/session/projection-changes.ts";
import type { DocumentShape } from "../../../src/core/document/validated.ts";
import { writesOutside } from "../session-fakes.ts";
import { namesUnchanged } from "./change-set-checks.ts";

function script(parts: Record<string, unknown> = {}): DocumentShape {
  return {
    schema: 2,
    title: "Title",
    docId: "d1",
    rows: [
      { id: "R1", status: "todo", visualText: "", audioText: "one", updatedAt: "", updatedBy: null },
      { id: "R2", status: "todo", visualText: "", audioText: "two", updatedAt: "", updatedBy: null },
      { id: "R3", status: "todo", visualText: "", audioText: "three", updatedAt: "", updatedBy: null }
    ],
    comments: [],
    people: [],
    productionTags: [],
    brollShots: [],
    wordsPerMinute: 150,
    rev: 0,
    sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }],
    ...parts
  };
}

const NOTHING = { whole: false, cells: [], rowsInserted: [], rowsRemoved: [], rowsMoved: false, runsMoved: false, docFields: [], derive: [], saveNow: false };

test("equal projections give the empty set, frozen", () => {
  const changes = changesBetween(script(), script());
  assert.deepEqual(changes, NOTHING);
  assert.ok(Object.isFrozen(changes) && Object.isFrozen(changes.cells) && Object.isFrozen(changes.docFields));
});

test("INV-07: one changed narration names one cell and nothing else", () => {
  const after = script();
  after.rows[1] = { id: "R2", status: "todo", visualText: "", audioText: "twoX", updatedAt: "", updatedBy: null };
  assert.deepEqual(changesBetween(script(), after), { ...NOTHING, cells: [{ rowId: "R2", field: "audioText" }] });
});

test("beat fields are named cell by cell in the projection's row and key order; an added field follows, a dropped one comes last", () => {
  const after = script();
  after.rows[0] = { id: "R1", status: "ready", visualText: "", audioText: "one", updatedAt: "", updatedBy: null, lengthSeconds: 7 };
  after.rows[2] = { id: "R3", status: "todo", visualText: "wide", audioText: "three", updatedAt: "" };
  assert.deepEqual(changesBetween(script(), after), { ...NOTHING, cells: [
    { rowId: "R1", field: "status" }, { rowId: "R1", field: "lengthSeconds" },
    { rowId: "R3", field: "visualText" }, { rowId: "R3", field: "updatedBy" }
  ] });
});

test("inserted and removed beats are named by id; the beats that stay are not, and their order did not move", () => {
  const after = script();
  after.rows.splice(1, 1, { id: "R4", status: "todo", visualText: "", audioText: "four", updatedAt: "", updatedBy: null });
  assert.deepEqual(changesBetween(script(), after), { ...NOTHING, rowsInserted: ["R4"], rowsRemoved: ["R2"] });
});

test("a moved beat sets rowsMoved and names no cell", () => {
  const after = script();
  after.rows.push(...after.rows.splice(0, 1));
  assert.deepEqual(changesBetween(script(), after), { ...NOTHING, rowsMoved: true });
});

test("headings, records and document scalars are document fields in the projection's key order; a dropped field comes last", () => {
  const after = script({
    title: "Renamed",
    people: [{ id: "P1", name: "Ann" }],
    sections: [{ id: "H1", name: "Scene!", firstSceneId: "R1" }],
    targetSeconds: 90
  });
  Reflect.deleteProperty(after, "wordsPerMinute");
  assert.deepEqual(changesBetween(script(), after), { ...NOTHING, docFields: ["title", "people", "sections", "targetSeconds", "wordsPerMinute"] });
});

test("a repeated beat id on either side reports the whole document", () => {
  const twice = script();
  twice.rows.push({ id: "R1", status: "todo", visualText: "", audioText: "again", updatedAt: "", updatedBy: null });
  const whole = { ...NOTHING, whole: true };
  assert.deepEqual(changesBetween(script(), twice), whole);
  assert.deepEqual(changesBetween(twice, script()), whole);
});

type Bag = Record<string, unknown>;

function copyOf(doc: DocumentShape): Bag {
  return JSON.parse(JSON.stringify(doc)) as Bag;
}

test("seeded: the compared set covers every difference between two projections and names nothing that is equal", () => {
  let random = 0x7b0014;
  const next = (below: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % below; };
  const fields = ["status", "audioText", "visualText", "lengthSeconds", "updatedAt", "imageRef"];
  const docFields = ["title", "people", "comments", "sections", "targetSeconds", "productionTags", "brollShots", "extra"];
  const kinds = new Set<string>();
  let serial = 0, compared = 0;
  for (let round = 0; round < 300; round++) {
    const before = script();
    for (let fill = next(4); fill > 0; fill--) before.rows.push({ id: `N${++serial}`, status: "todo", audioText: "" });
    const after = script({ rows: JSON.parse(JSON.stringify(before.rows)) as DocumentShape["rows"] });
    for (let edits = 1 + next(4); edits > 0; edits--) {
      const kind = ["set", "drop", "insert", "remove", "move", "field", "unfield", "same"][next(8)] ?? "same";
      const row = after.rows[next(after.rows.length || 1)];
      kinds.add(kind);
      if (kind === "set" && row) row[fields[next(fields.length)] ?? "status"] = `v${next(3)}`;
      else if (kind === "drop" && row) Reflect.deleteProperty(row, fields[next(fields.length)] ?? "status");
      else if (kind === "insert") after.rows.splice(next(after.rows.length + 1), 0, { id: `N${++serial}`, status: "todo", audioText: "new" });
      else if (kind === "remove" && after.rows.length) after.rows.splice(next(after.rows.length), 1);
      else if (kind === "move" && after.rows.length > 1) after.rows.splice(next(after.rows.length), 0, ...after.rows.splice(next(after.rows.length), 1));
      else if (kind === "field") after[docFields[next(docFields.length)] ?? "title"] = [{ id: `X${next(3)}`, name: `n${next(3)}` }];
      else if (kind === "unfield") Reflect.deleteProperty(after, docFields[next(docFields.length)] ?? "title");
    }
    const changes = changesBetween(before, after);
    const was = copyOf(before), now = copyOf(after);
    assert.deepEqual(writesOutside(was, now, changes), [], `round ${round}`);
    assert.deepEqual(namesUnchanged(was, now, changes), [], `round ${round}`);
    assert.deepEqual([changes.derive, changes.saveNow], [[], false]);
    assert.deepEqual(changesBetween(after, after), NOTHING);
    compared++;
  }
  assert.equal(compared, 300);
  assert.deepEqual([...kinds].sort(), ["drop", "field", "insert", "move", "remove", "same", "set", "unfield"]);
});
