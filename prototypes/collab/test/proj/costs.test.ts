import assert from "node:assert/strict";
import { test } from "node:test";
import { largeProjectionFixture } from "../../src/proj/costs.ts";
import { records } from "../../src/proj/value.ts";

test("PROJ scale generator follows recorder suffixes and keeps registries once", () => {
  const source = {
    rows: [{ id: "R1", audioText: '<span data-cmt="C1">a</span>', visualText: '<span data-broll-id="S1">B-roll:</span>' }],
    comments: [{ id: "C1", rowId: "R1", anchorId: "C1" }], brollShots: [{ id: "S1" }],
    people: [{ id: "p1", name: "A" }], productionTags: [{ id: "t1", name: "Cup", cat: "prop" }]
  };
  const large = largeProjectionFixture(source);
  assert.equal(records(large.rows).length, 10);
  assert.equal(records(large.comments).length, 10);
  assert.equal(records(large.brollShots).length, 10);
  assert.deepEqual(records(large.rows)[9], { id: "R1-9", audioText: '<span data-cmt="C1-9">a</span>', visualText: '<span data-broll-id="S1-9">B-roll:</span>' });
  assert.deepEqual(records(large.comments)[9], { id: "C1-9", rowId: "R1-9", anchorId: "C1-9" });
  assert.deepEqual(records(large.brollShots)[9], { id: "S1-9" });
  assert.deepEqual(large.people, [{ id: "p1", name: "A" }]);
  assert.deepEqual(large.productionTags, [{ id: "t1", name: "Cup", cat: "prop" }]);
  assert.equal(source.rows.length, 1);
  assert.equal(source.rows[0]?.id, "R1");
});
