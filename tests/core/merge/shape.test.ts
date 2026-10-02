import { test } from "node:test";
import assert from "node:assert/strict";
import { STATE_FIELDS } from "../../../src/core/document/fields.ts";
import type { StateField } from "../../../src/core/document/fields.ts";
import { listShapedSide } from "../../../src/core/merge/shape.ts";

type Bag = Record<string, unknown>;

function side(over?: Bag): Bag {
  return Object.assign({
    title: "T",
    rows: [{ id: "r1", imageLinks: [{ href: "https://v.example/a" }], moreImages: [{ links: [{ href: "https://v.example/b", poster: true }] }] }],
    comments: [{ id: "c1", replies: [{ id: "rp1" }] }],
    people: [{ id: "p1", name: "Sam" }],
    productionTags: [{ id: "t1", cat: "prop", name: "Kettle" }],
    brollShots: [{ id: "b1", props: "not a list" }]
  }, over || {});
}

test("a side whose lists are lists of objects reads the same, and is not written into", () => {
  const s = side();
  const before = JSON.stringify(s);
  const out = listShapedSide(s, STATE_FIELDS);
  assert.equal(JSON.stringify(out), before);
  assert.equal(JSON.stringify(s), before);
  assert.notEqual(out, s);
  assert.equal((out.people as unknown[])[0], (s.people as unknown[])[0], "items are the input's own, for the mergers to copy");
  assert.equal((out.brollShots as Bag[])[0]?.props, "not a list", "a shot's props are the props merger's to read");
});

test("a document list that is not an array is empty, and items that are not objects are dropped", () => {
  const s = side({ rows: { 0: { id: "r1" } }, comments: "x", people: 5, productionTags: true, brollShots: [null, "x", 3, { id: "b1" }] });
  const out = listShapedSide(s, STATE_FIELDS);
  assert.deepEqual([out.rows, out.comments, out.people, out.productionTags, out.brollShots], [[], [], [], [], [{ id: "b1" }]]);
  assert.deepEqual(listShapedSide({ rows: [null, "x", 7, false, { id: "r1" }, ["r2"]] }, STATE_FIELDS).rows, [{ id: "r1" }, ["r2"]],
    "an array counts as an object, as in migrateRows");
});

test("rows and comments are always lists; a missing or null registry, people or shot list stays as it was", () => {
  const out = listShapedSide({ people: null }, STATE_FIELDS);
  assert.deepEqual(out, { people: null, rows: [], comments: [] });
});

test("the lists inside a scene and a comment are cleaned the same way, and a missing one stays missing", () => {
  const s = side({
    rows: [
      { id: "r1", imageLinks: [null, { href: "https://v.example/a" }], moreImages: [null, { links: "x" }, { links: [7, { name: "f" }] }] },
      { id: "r2", imageLinks: {}, moreImages: null },
      { id: "r3" }
    ],
    comments: [{ id: "c1", replies: "x" }, { id: "c2", replies: [null, { id: "rp" }] }, { id: "c3" }, { id: "c4", replies: null }]
  });
  const before = JSON.stringify(s);
  const out = listShapedSide(s, STATE_FIELDS);
  assert.deepEqual(out.rows, [
    { id: "r1", imageLinks: [{ href: "https://v.example/a" }], moreImages: [{ links: [] }, { links: [{ name: "f" }] }] },
    { id: "r2", imageLinks: [], moreImages: null },
    { id: "r3" }
  ]);
  assert.deepEqual(out.comments, [{ id: "c1", replies: [] }, { id: "c2", replies: [{ id: "rp" }] }, { id: "c3" }, { id: "c4", replies: null }]);
  assert.equal(JSON.stringify(s), before);
  assert.equal((out.rows as Bag[])[2], (s.rows as Bag[])[2], "an item with nothing to clean is the input's own");
});

test("a key named __proto__ is copied as a key, and the copy keeps Object's prototype", () => {
  const s = JSON.parse('{"__proto__": {"title": "From proto"}, "rows": [{"id": "r1", "__proto__": {"imageLinks": "x"}, "imageLinks": [null]}]}') as Bag;
  const out = listShapedSide(s, STATE_FIELDS);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.title, undefined);
  assert.deepEqual(Object.keys(out), ["__proto__", "rows", "comments"]);
  const row = (out.rows as Bag[])[0] as Bag;
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.deepEqual(row.imageLinks, []);
});

test("every list-union-with-base field in the table is cleaned, and only those", () => {
  const fields: readonly StateField[] = [...STATE_FIELDS, { key: "probes", merge: "list-union-with-base", undo: true }];
  const out = listShapedSide({ probes: [null, { id: "x" }], other: [null] }, fields);
  assert.deepEqual(out.probes, [{ id: "x" }]);
  assert.deepEqual(out.other, [null]);
});
