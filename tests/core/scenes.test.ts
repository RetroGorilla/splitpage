import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../src/core/migrate.ts";
import { sceneForBeat } from "../../src/core/document/scenes.ts";
import { mergeSceneLayout } from "../../src/core/merge/scenes.ts";
import { fakeMigration } from "./migrate-ports.ts";
import { fakePorts } from "./merge/fakes.ts";
import { mergeStateFields } from "../../src/core/merge/states.ts";

const rows = ["a", "b", "c", "d"].map(id => ({ id }));
const scenes = [{ id: "s1", name: "Opening", firstSceneId: "a" }, { id: "s2", name: "Ending", firstSceneId: "c" }];

test("sections r2: removing a header retains the predecessor after its original scene leaves", () => {
  const base = { rows: ["a", "b", "c"].map(id => ({ id })), sections: [
    { id: "P", name: "P", firstSceneId: "b" }, { id: "S", name: "S", firstSceneId: "c" }
  ] };
  for (const [beatIds, name] of [[["a", "c"], "P"], [["b", "a", "c"], "P"], [["a", "c"], "P2"]] as const) {
    const edited = { rows: beatIds.map(id => ({ id })), sections: [{ id: "P", name, firstSceneId: "c" }] };
    for (const other of [base, { ...base, sections: [base.sections[0]] }]) {
      for (const [mine, theirs] of [[other, edited], [edited, other]] as const) {
        const result = mergeSceneLayout(base, mine, theirs, edited.rows);
        assert.deepEqual(result, edited);
      }
    }
    assert.deepEqual(mergeSceneLayout(base, edited, edited, edited.rows), edited);
  }
});

test("sections r1: rename survives removal with an unrelated scene insertion", () => {
  const base = { rows: ["a", "b", "c", "d", "e", "f"].map(id => ({ id })), sections: [
    { id: "one", name: "One", firstSceneId: "b" }, { id: "two", name: "Two", firstSceneId: "d" }
  ] };
  const removed = { rows: [{ id: "y" }, ...base.rows], sections: [base.sections[0]] };
  const renamed = { ...base, sections: [base.sections[0], { ...base.sections[1], name: "Renamed" }] };
  for (const [mine, theirs] of [[removed, renamed], [renamed, removed]] as const) {
    const result = mergeSceneLayout(base, mine, theirs, removed.rows);
    assert.deepEqual(result.rows, removed.rows);
    assert.deepEqual(result.sections, renamed.sections);
  }
});

test("sections r1: absent metadata defers without a base in both orientations", () => {
  const withScenes = { rows, sections: scenes }, plain = { rows };
  for (const [mine, theirs] of [[withScenes, plain], [plain, withScenes]] as const) {
    const migration = fakeMigration();
    const result = mergeStateFields(null, migrateRows(structuredClone(mine), migration.ports),
      migrateRows(structuredClone(theirs), migration.ports), fakePorts(() => []));
    const state = migrateRows(result.merged, migration.ports);
    assert.deepEqual(state.rows.map(row => row.id), rows.map(row => row.id));
    assert.deepEqual(state.sections, scenes);
  }
});

test("sections r1: incidental deletion or movement of an anchor does not defeat header removal", () => {
  const base = { rows, sections: scenes };
  const removed = { rows, sections: [scenes[0]] };
  for (const beatIds of [["a", "b", "d"], ["a", "c", "b", "d"]]) {
    const edited = { rows: beatIds.map(id => ({ id })), sections: [scenes[0], { ...scenes[1], firstSceneId: "d" }] };
    for (const [mine, theirs] of [[removed, edited], [edited, removed]] as const) {
      const result = mergeSceneLayout(base, mine, theirs, edited.rows);
      assert.deepEqual(result.rows, edited.rows);
      assert.deepEqual(result.sections, [scenes[0]]);
    }
  }
});

test("sections r1: snapshot ambiguity restores renamed original scenes but keeps explicit reassignment", () => {
  const base = { rows: ["a", "b", "c", "d"].map(id => ({ id })), sections: [
    { id: "A", name: "A", firstSceneId: "b" }, { id: "B", name: "B", firstSceneId: "d" }
  ] };
  const renamed = { ...base, sections: [{ ...base.sections[0], name: "Renamed" }, base.sections[1]] };
  const removed = { rows: ["a", "x", "b", "d", "c"].map(id => ({ id })), sections: [base.sections[1]] };
  for (const [mine, theirs] of [[removed, renamed], [renamed, removed]] as const) {
    const result = mergeSceneLayout(base, mine, theirs, removed.rows);
    assert.deepEqual(result.rows, removed.rows);
    assert.deepEqual(result.sections, renamed.sections);
    assert.equal(sceneForBeat(result, "x"), undefined);
    assert.equal(sceneForBeat(result, "b")?.id, "A");
    assert.equal(sceneForBeat(result, "c")?.id, "B");
  }
  const anchorOnly = { ...base, sections: [{ ...base.sections[0], firstSceneId: "c" }, base.sections[1]] };
  assert.deepEqual(mergeSceneLayout(base, { ...base, sections: [base.sections[1]] }, anchorOnly, rows).sections, [base.sections[1]]);
});

test("sections r1: a new boundary preserves the concurrent order of its scenes", () => {
  const base = { rows: ["a", "b", "c", "d"].map(id => ({ id })) };
  const added = { ...base, sections: [{ id: "new", name: "New", firstSceneId: "b" }] };
  const reordered = { rows: ["a", "b", "d", "c"].map(id => ({ id })) };
  for (const [mine, theirs] of [[added, reordered], [reordered, added]] as const) {
    const result = mergeSceneLayout(base, mine, theirs, reordered.rows);
    assert.deepEqual(result.rows, reordered.rows);
    assert.deepEqual(result.sections, added.sections);
  }
});

test("sections: migration omits absent and empty metadata, normalizes names, rejects bad or duplicate anchors", () => {
  const migration = fakeMigration();
  for (const value of [undefined, null, [], "invalid"]) {
    const doc = migrateRows({ rows, sections: value }, migration.ports);
    assert.equal("sections" in doc, false);
  }
  const doc = migrateRows({ rows, sections: [scenes[1], { ...scenes[0], name: "  Opening  " },
    { id: "duplicate", name: "Duplicate", firstSceneId: "a" }, { id: "orphan", name: "Gone", firstSceneId: "gone" }] }, migration.ports);
  assert.deepEqual(doc.sections, scenes);
  assert.equal(sceneForBeat(doc, "b")?.id, "s1");
  assert.equal(sceneForBeat(doc, "d")?.id, "s2");
});

test("sections: concurrent rename and anchor change combine; same-property conflicts keep theirs", () => {
  const base = { rows, sections: scenes };
  const mine = { rows, sections: [{ ...scenes[0], name: "Renamed" }, scenes[1]] };
  const theirs = { rows, sections: [{ ...scenes[0], firstSceneId: "b" }, scenes[1]] };
  assert.deepEqual(mergeSceneLayout(base, mine, theirs, rows).sections?.[0], { id: "s1", name: "Renamed", firstSceneId: "b" });
  assert.equal(mergeSceneLayout(base, mine, { rows, sections: [{ ...scenes[0], name: "Incoming" }, scenes[1]] }, rows).sections?.[0]?.name, "Incoming");
});

test("sections: deletion beats unchanged, edited headers survive deletion, missing anchors advance within their group", () => {
  const base = { rows, sections: scenes };
  assert.deepEqual(mergeSceneLayout(base, { rows }, base, rows).sections, undefined);
  assert.deepEqual(mergeSceneLayout(base, base, { rows }, rows).sections, undefined);
  const edited = { rows, sections: [{ ...scenes[0], name: "Keep" }, scenes[1]] };
  assert.deepEqual(mergeSceneLayout(base, { rows }, edited, rows).sections, [{ id: "s1", name: "Keep", firstSceneId: "a" }]);
  assert.equal(mergeSceneLayout(base, base, base, rows.slice(1)).sections?.[0]?.firstSceneId, "b");
  assert.deepEqual(mergeSceneLayout(base, base, base, []).sections, undefined);
});

test("sections: a one-sided group move survives merge and incoming rows retain their neighbour", () => {
  const base = { rows, sections: scenes };
  const mine = { rows: ["c", "d", "a", "b"].map(id => ({ id })), sections: scenes };
  const incoming = [{ id: "a" }, { id: "new" }, ...rows.slice(1)];
  assert.deepEqual(mergeSceneLayout(base, mine, { rows: incoming, sections: scenes }, incoming).rows.map(row => row.id), ["c", "d", "a", "new", "b"]);
  const theirs = { rows: [...rows].reverse(), sections: scenes };
  assert.deepEqual(mergeSceneLayout(base, mine, theirs, theirs.rows).rows, theirs.rows);
  assert.deepEqual(mergeSceneLayout({ rows }, { rows: mine.rows }, { rows }, rows).rows, rows);
});

test("sections: a group move and concurrent paste over its first scene keep the replacement inside the moved group", () => {
  const base = { rows, sections: scenes };
  const mine = { rows: ["c", "d", "a", "b"].map(id => ({ id })), sections: scenes };
  const theirs = {
    rows: ["a", "b", "x", "y", "d"].map(id => ({ id })),
    sections: [scenes[0], { id: "s2", name: "Ending", firstSceneId: "x" }]
  };
  const merged = mergeSceneLayout(base, mine, theirs, theirs.rows);
  const mergedRows = merged.rows;
  assert.deepEqual(mergedRows.map(row => row.id), ["x", "y", "d", "a", "b"]);
  assert.equal(sceneForBeat(merged, "d")?.id, "s2");
  assert.equal(sceneForBeat(merged, "a")?.id, "s1");
  for (const [mineSide, theirSide] of [[mine, theirs], [theirs, mine]]) {
    const migration = fakeMigration();
    const result = mergeStateFields(migrateRows(structuredClone(base), migration.ports),
      migrateRows(structuredClone(mineSide), migration.ports), migrateRows(structuredClone(theirSide), migration.ports), fakePorts(() => []));
    const state = migrateRows(result.merged, migration.ports);
    assert.deepEqual(state.rows.map(row => row.id), ["x", "y", "d", "a", "b"]);
    assert.equal(sceneForBeat(state, "d")?.id, "s2");
  }
});

test("sections: replacing a singleton retains its section's concurrent move in both orientations", () => {
  const base = { rows: [{ id: "a" }, { id: "b" }], sections: [scenes[0], { ...scenes[1], firstSceneId: "b" }] };
  const moved = { ...base, rows: [...base.rows].reverse() };
  const replaced = { rows: ["a", "x", "y"].map(id => ({ id })), sections: [scenes[0], { ...scenes[1], firstSceneId: "x" }] };
  for (const [mine, theirs] of [[moved, replaced], [replaced, moved]]) {
    const migration = fakeMigration();
    const result = mergeStateFields(migrateRows(structuredClone(base), migration.ports),
      migrateRows(structuredClone(mine), migration.ports), migrateRows(structuredClone(theirs), migration.ports), fakePorts(() => []));
    const state = migrateRows(result.merged, migration.ports);
    assert.deepEqual(state.rows.map(row => row.id), ["x", "y", "a"]);
    assert.equal(sceneForBeat(state, "x")?.id, "s2");
    assert.equal(sceneForBeat(state, "y")?.id, "s2");
  }
});

test("sections: scene positions inside their destination do not compete with a section move", () => {
  const base = { rows: ["a", "b", "c", "d", "e"].map(id => ({ id })), sections: [
    { id: "A", name: "A", firstSceneId: "a" }, { id: "B", name: "B", firstSceneId: "c" }
  ] };
  const moved = { ...base, rows: ["c", "d", "e", "a", "b"].map(id => ({ id })) };
  const edited = { rows: ["a", "c", "b", "d", "e"].map(id => ({ id })), sections: [
    base.sections[0], { id: "B", name: "B", firstSceneId: "d" }
  ] };
  for (const [mine, theirs] of [[moved, edited], [edited, moved]] as const) {
    const result = mergeSceneLayout(base, mine, theirs, edited.rows);
    assert.deepEqual(result.rows.map(row => row.id), ["d", "e", "a", "c", "b"]);
    assert.equal(sceneForBeat(result, "c")?.id, "A");
  }
});

test("sections: an emptied moved section cannot reorder its scenes inside the destination section", () => {
  const base = { rows: ["a", "b", "c", "d"].map(id => ({ id })), sections: [
    { id: "A", name: "A", firstSceneId: "a" }, { id: "B", name: "B", firstSceneId: "d" }
  ] };
  const moved = { ...base, rows: ["d", "a", "b", "c"].map(id => ({ id })) };
  const edited = { rows: ["a", "b", "d", "x", "c"].map(id => ({ id })), sections: [base.sections[0]] };
  for (const [mine, theirs] of [[moved, edited], [edited, moved]] as const) {
    const result = mergeSceneLayout(base, mine, theirs, edited.rows);
    assert.deepEqual(result.rows.map(row => row.id), ["a", "b", "d", "x", "c"]);
    assert.deepEqual(result.sections, [base.sections[0]]);
  }
});
