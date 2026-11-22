import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSharedJoinedFields, projectSharedJoinedUnits, projectSharedJoinGroups, projectSharedSections } from "../../../src/core/collab/projection/joins.ts";

test("join selection uses UTF-16 ids before following the graph, without changing inputs", () => {
  const beats = [{ id: "R1", removed: false, joins: [] }, { id: "R2", removed: false, joins: [
    { id: "\ue000", into: "R1", glue: "" as const }, { id: "\ud83d\ude00", into: "R3", glue: " " as const }
  ] }, { id: "R3", removed: false, joins: [] }];
  const before = JSON.stringify(beats);
  const expected = [{ root: "R1", removed: false, cyclic: false, members: [{ id: "R1", glue: "" }] },
    { root: "R3", removed: false, cyclic: false, members: [{ id: "R3", glue: "" }, { id: "R2", glue: " " }] }];
  assert.deepEqual(projectSharedJoinGroups(beats), expected); assert.equal(JSON.stringify(beats), before);
  assert.deepEqual(projectSharedJoinGroups(beats.map(beat => ({ ...beat, joins: [...beat.joins].reverse() }))), expected);
});

test("a dangling smallest join retains its source and a self-cycle retains its own row", () => {
  assert.deepEqual(projectSharedJoinGroups([{ id: "R1", removed: false, joins: [{ id: "a", into: "R1", glue: " " }] },
    { id: "R2", removed: false, joins: [{ id: "a", into: "missing", glue: " " }, { id: "z", into: "R1", glue: " " }] }]), [
    { root: "R1", removed: false, cyclic: true, members: [{ id: "R1", glue: "" }] },
    { root: "R2", removed: false, cyclic: false, members: [{ id: "R2", glue: "" }] }
  ]);
});

test("a join cycle chooses the first live root and keeps the other live members together", () => {
  const joins = (into: string) => [{ id: "join", into, glue: " " as const }];
  assert.deepEqual(projectSharedJoinGroups([
    { id: "Removed", removed: true, joins: joins("First") },
    { id: "First", removed: false, joins: joins("Last") },
    { id: "Last", removed: false, joins: joins("Removed") }
  ]), [
    { root: "Removed", removed: true, cyclic: false, members: [{ id: "Removed", glue: "" }] },
    { root: "First", removed: false, cyclic: true, members: [{ id: "First", glue: "" }, { id: "Last", glue: " " }] }
  ]);
});

test("joined fields keep the root's duration and select the status across members", () => {
  const root = { id: "First", lengthSeconds: 12, status: "ready" };
  const child = { id: "Last", lengthSeconds: 25, status: "shot" };
  assert.deepEqual(projectSharedJoinedFields(root, [root, child], []), {
    row: { id: "First", lengthSeconds: 12, status: "shot" }, overflow: []
  });
});

test("the synthetic join space carries the stored formats", () => {
  assert.deepEqual(projectSharedJoinedUnits([
    { units: [{ value: "A", marks: [] }], glue: "" }, { units: [{ value: "B", marks: [] }], glue: " ", formats: ["b", "i"] }
  ], [], false), [
    { value: "A", marks: [] }, { value: " ", marks: [{ kind: "b", value: true }, { kind: "i", value: true }] }, { value: "B", marks: [] }
  ]);
});

test("empty heading boundaries do not replace a named scene and orphan headings keep their location", () => {
  const blocks = [{ kind: "h" as const, id: "H1", name: "First", extra: { note: "kept" } }, { kind: "h" as const, id: "empty", name: "" },
    { kind: "b" as const, id: "R1" }, { kind: "h" as const, id: "H2", name: "Second" }, { kind: "b" as const, id: "R2" }];
  assert.deepEqual(projectSharedSections(blocks, new Set(["R1", "R2"])), {
    sections: [{ note: "kept", id: "H1", name: "First", firstSceneId: "R1" }, { id: "H2", name: "Second", firstSceneId: "R2" }], empty: []
  });
  assert.deepEqual(projectSharedSections(blocks, new Set(["R2"])), {
    sections: [{ id: "H2", name: "Second", firstSceneId: "R2" }], empty: [{ heading: { note: "kept", id: "H1", name: "First" }, beforeRowId: "R2" }]
  });
});
