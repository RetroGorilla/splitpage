import test from "node:test";
import assert from "node:assert/strict";
import { projectSharedJoinedLayout } from "../../../src/core/collab/projection/join-layout.ts";

const blocks = [{ id: "R1", segment: "one", from: 0, to: 1 }, { id: "fresh", segment: "one", from: 2, to: 3 }, { id: "R2", segment: "two", from: 0, to: 2 }];
const binding = { end: { segment: "one", offset: 3 }, start: { segment: "two", offset: 0 }, stop: { segment: "two", offset: 2 } };

test("joined layout follows the native end while fields stay with the retained destination", () => {
  assert.deepEqual(projectSharedJoinedLayout(blocks, [
    { id: "R1", removed: false, joins: [] }, { id: "fresh", removed: false, joins: [] },
    { id: "R2", removed: false, joins: [{ id: "join", into: "R1", glue: " ", binding }] }
  ]), [
    { root: "R1", removed: false, cyclic: false, members: [{ id: "R1", segment: "one", from: 0, to: 1, glue: "", join: null }], fields: ["R1", "R2"] },
    { root: "fresh", removed: false, cyclic: false, members: [{ id: "fresh", segment: "one", from: 2, to: 3, glue: "", join: null },
      { id: "R2", segment: "two", from: 0, to: 2, glue: " ", join: "join" }], fields: ["fresh"] }
  ]);
});

for (const damaged of [null, { ...binding, end: { segment: "missing", offset: 1 } }]) test("damaged selected binding never activates a later competing join: " + JSON.stringify(damaged), () => {
  assert.deepEqual(projectSharedJoinedLayout(blocks, [
    { id: "R1", removed: false, joins: [] }, { id: "fresh", removed: false, joins: [] },
    { id: "R2", removed: false, joins: [{ id: "a", into: "R1", glue: " ", binding: damaged }, { id: "z", into: "fresh", glue: "" }] }
  ]).map(row => ({ root: row.root, members: row.members.map(member => member.id), fields: row.fields })), [
    { root: "R1", members: ["R1"], fields: ["R1"] }, { root: "fresh", members: ["fresh"], fields: ["fresh"] }, { root: "R2", members: ["R2"], fields: ["R2"] }
  ]);
});
