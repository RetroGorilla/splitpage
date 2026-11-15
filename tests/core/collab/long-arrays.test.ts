import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSharedBlocks } from "../../../src/core/collab/projection/blocks.ts";
import { projectSharedJoinGroups, projectSharedJoinedUnits } from "../../../src/core/collab/projection/joins.ts";
import type { SharedProjectionBeatStructure } from "../../../src/core/collab/projection/joins.ts";
import { projectSharedJoinedLayout } from "../../../src/core/collab/projection/join-layout.ts";
import type { SharedProjectionUnit } from "../../../src/core/collab/projection/units.ts";

const LONG = 300000;
const units = (count: number, value = "x"): SharedProjectionUnit[] => Array.from({ length: count }, () => ({ value, marks: [] }));

test("a beat of 300,000 units in two parts projects as the same block as one of 3 units does, scaled", () => {
  const blocks = (size: number) => projectSharedBlocks([{ segment: "S", inOrder: true, head: { kind: "b", id: "R1", before: null }, parts: [
    { boundary: null, units: units(size), from: 0, to: size }, { boundary: null, units: units(size, "y"), from: size, to: 2 * size }] }],
  [{ id: "R1", valid: true, segment: "S" }]);
  const shape = (size: number) => [{ kind: "b", id: "R1", segment: "S", from: 0, to: 2 * size, units: [...units(size), ...units(size, "y")], reason: null }];
  assert.deepEqual(blocks(3), shape(3));
  const long = blocks(LONG);
  assert.equal(long[0]?.units.length, 2 * LONG);
  assert.deepEqual(long, shape(LONG));
});

test("a joined row whose parts hold 300,000 units joins them as the same row of 3 units does, scaled", () => {
  const joined = (size: number) => projectSharedJoinedUnits([{ units: units(size), glue: "" }, { units: units(size, "y"), glue: "" }], [], false);
  assert.deepEqual(joined(3), [...units(3), ...units(3, "y")]);
  const long = joined(LONG);
  assert.equal(long.length, 2 * LONG);
  assert.deepEqual(long, [...units(LONG), ...units(LONG, "y")]);
});

function star(size: number): SharedProjectionBeatStructure[] {
  return [{ id: "R", removed: false, joins: [] }, ...Array.from({ length: size }, (_, index) => ({ id: "C" + String(index).padStart(6, "0"), removed: false,
    joins: [{ id: "j" + index, into: "R", glue: "" as const }] }))];
}
function ring(size: number): SharedProjectionBeatStructure[] {
  return Array.from({ length: size }, (_, index) => ({ id: "C" + String(index).padStart(6, "0"), removed: false,
    joins: [{ id: "j" + index, into: "C" + String((index + 1) % size).padStart(6, "0"), glue: "" as const }] }));
}
const ids = (size: number, from = 0) => Array.from({ length: size - from }, (_, index) => "C" + String(index + from).padStart(6, "0"));

test("a root with 300,000 rows joined into it groups them in the same order as a root with 3 does, scaled", () => {
  const order = (size: number) => projectSharedJoinGroups(star(size)).map(group => group.members.map(member => member.id));
  assert.deepEqual(order(3), [["R", ...ids(3)]]);
  assert.deepEqual(order(LONG), [["R", ...ids(LONG)]]);
});

test("a cycle of 300,000 joined rows groups them in the same order as a cycle of 3 does, scaled", () => {
  const order = (size: number) => projectSharedJoinGroups(ring(size)).map(group => [group.cyclic, group.members.map(member => member.id)]);
  assert.deepEqual(order(3), [[true, ids(3)]]);
  assert.deepEqual(order(LONG), [[true, ids(LONG)]]);
});

test("a joined row's fields list its rows in the same order at 3,000 rows as at 3; the layout is quadratic in joined rows", () => {
  const fields = (size: number) => projectSharedJoinedLayout(["R", ...ids(size)].map((id, index) => ({ id, segment: id, from: index, to: index + 1 })), star(size))
    .map(row => [row.root, row.fields]);
  assert.deepEqual(fields(3), [["R", ["R", ...ids(3)]]]);
  assert.deepEqual(fields(3000), [["R", ["R", ...ids(3000)]]]);
});
