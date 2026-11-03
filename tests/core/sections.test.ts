import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../src/core/migrate.ts";
import { sectionForBeat } from "../../src/core/document/sections.ts";
import { mergeSectionLayout } from "../../src/core/merge/sections.ts";
import { fakeMigration } from "./migrate-ports.ts";
import { fakePorts } from "./merge/fakes.ts";
import { mergeStateFields } from "../../src/core/merge/states.ts";

const rows = ["a", "b", "c", "d"].map(id => ({ id }));
const sections = [{ id: "s1", name: "Opening", firstSceneId: "a" }, { id: "s2", name: "Ending", firstSceneId: "c" }];

test("sections r2: removing a header retains the predecessor after its original scene leaves", () => {
  const base = { rows: ["a", "b", "c"].map(id => ({ id })), sections: [
    { id: "P", name: "P", firstSceneId: "b" }, { id: "S", name: "S", firstSceneId: "c" }
  ] };
  for (const [beatIds, name] of [[["a", "c"], "P"], [["b", "a", "c"], "P"], [["a", "c"], "P2"]] as const) {
    const edited = { rows: beatIds.map(id => ({ id })), sections: [{ id: "P", name, firstSceneId: "c" }] };
    for (const other of [base, { ...base, sections: [base.sections[0]] }]) {
      for (const [mine, theirs] of [[other, edited], [edited, other]] as const) {
        const result = mergeSectionLayout(base, mine, theirs, edited.rows);
        assert.deepEqual(result, edited);
      }
    }
    assert.deepEqual(mergeSectionLayout(base, edited, edited, edited.rows), edited);
  }
});

test("sections r1: rename survives removal with an unrelated scene insertion", () => {
  const base = { rows: ["a", "b", "c", "d", "e", "f"].map(id => ({ id })), sections: [
    { id: "one", name: "One", firstSceneId: "b" }, { id: "two", name: "Two", firstSceneId: "d" }
  ] };
  const removed = { rows: [{ id: "y" }, ...base.rows], sections: [base.sections[0]] };
  const renamed = { ...base, sections: [base.sections[0], { ...base.sections[1], name: "Renamed" }] };
  for (const [mine, theirs] of [[removed, renamed], [renamed, removed]] as const) {
    const result = mergeSectionLayout(base, mine, theirs, removed.rows);
    assert.deepEqual(result.rows, removed.rows);
    assert.deepEqual(result.sections, renamed.sections);
  }
});

test("sections r1: absent metadata defers without a base in both orientations", () => {
  const sectioned = { rows, sections }, plain = { rows };
  for (const [mine, theirs] of [[sectioned, plain], [plain, sectioned]] as const) {
    const migration = fakeMigration();
    const result = mergeStateFields(null, migrateRows(structuredClone(mine), migration.ports),
      migrateRows(structuredClone(theirs), migration.ports), fakePorts(() => []));
    const state = migrateRows(result.merged, migration.ports);
    assert.deepEqual(state.rows.map(row => row.id), rows.map(row => row.id));
    assert.deepEqual(state.sections, sections);
  }
});

test("sections r1: incidental deletion or movement of an anchor does not defeat header removal", () => {
  const base = { rows, sections };
  const removed = { rows, sections: [sections[0]] };
  for (const beatIds of [["a", "b", "d"], ["a", "c", "b", "d"]]) {
    const edited = { rows: beatIds.map(id => ({ id })), sections: [sections[0], { ...sections[1], firstSceneId: "d" }] };
    for (const [mine, theirs] of [[removed, edited], [edited, removed]] as const) {
      const result = mergeSectionLayout(base, mine, theirs, edited.rows);
      assert.deepEqual(result.rows, edited.rows);
      assert.deepEqual(result.sections, [sections[0]]);
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
    const result = mergeSectionLayout(base, mine, theirs, removed.rows);
    assert.deepEqual(result.rows, removed.rows);
    assert.deepEqual(result.sections, renamed.sections);
    assert.equal(sectionForBeat(result, "x"), undefined);
    assert.equal(sectionForBeat(result, "b")?.id, "A");
    assert.equal(sectionForBeat(result, "c")?.id, "B");
  }
  const anchorOnly = { ...base, sections: [{ ...base.sections[0], firstSceneId: "c" }, base.sections[1]] };
  assert.deepEqual(mergeSectionLayout(base, { ...base, sections: [base.sections[1]] }, anchorOnly, rows).sections, [base.sections[1]]);
});

test("sections r1: a new boundary preserves the concurrent order of its scenes", () => {
  const base = { rows: ["a", "b", "c", "d"].map(id => ({ id })) };
  const added = { ...base, sections: [{ id: "new", name: "New", firstSceneId: "b" }] };
  const reordered = { rows: ["a", "b", "d", "c"].map(id => ({ id })) };
  for (const [mine, theirs] of [[added, reordered], [reordered, added]] as const) {
    const result = mergeSectionLayout(base, mine, theirs, reordered.rows);
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
  const doc = migrateRows({ rows, sections: [sections[1], { ...sections[0], name: "  Opening  " },
    { id: "duplicate", name: "Duplicate", firstSceneId: "a" }, { id: "orphan", name: "Gone", firstSceneId: "gone" }] }, migration.ports);
  assert.deepEqual(doc.sections, sections);
  assert.equal(sectionForBeat(doc, "b")?.id, "s1");
  assert.equal(sectionForBeat(doc, "d")?.id, "s2");
});

test("sections: concurrent rename and anchor change combine; same-property conflicts keep theirs", () => {
  const base = { rows, sections };
  const mine = { rows, sections: [{ ...sections[0], name: "Renamed" }, sections[1]] };
  const theirs = { rows, sections: [{ ...sections[0], firstSceneId: "b" }, sections[1]] };
  assert.deepEqual(mergeSectionLayout(base, mine, theirs, rows).sections?.[0], { id: "s1", name: "Renamed", firstSceneId: "b" });
  assert.equal(mergeSectionLayout(base, mine, { rows, sections: [{ ...sections[0], name: "Incoming" }, sections[1]] }, rows).sections?.[0]?.name, "Incoming");
});

test("sections: deletion beats unchanged, edited headers survive deletion, missing anchors advance within their group", () => {
  const base = { rows, sections };
  assert.deepEqual(mergeSectionLayout(base, { rows }, base, rows).sections, undefined);
  assert.deepEqual(mergeSectionLayout(base, base, { rows }, rows).sections, undefined);
  const edited = { rows, sections: [{ ...sections[0], name: "Keep" }, sections[1]] };
  assert.deepEqual(mergeSectionLayout(base, { rows }, edited, rows).sections, [{ id: "s1", name: "Keep", firstSceneId: "a" }]);
  assert.equal(mergeSectionLayout(base, base, base, rows.slice(1)).sections?.[0]?.firstSceneId, "b");
  assert.deepEqual(mergeSectionLayout(base, base, base, []).sections, undefined);
});

test("sections: a one-sided group move survives merge and incoming rows retain their neighbour", () => {
  const base = { rows, sections };
  const mine = { rows: ["c", "d", "a", "b"].map(id => ({ id })), sections };
  const incoming = [{ id: "a" }, { id: "new" }, ...rows.slice(1)];
  assert.deepEqual(mergeSectionLayout(base, mine, { rows: incoming, sections }, incoming).rows.map(row => row.id), ["c", "d", "a", "new", "b"]);
  const theirs = { rows: [...rows].reverse(), sections };
  assert.deepEqual(mergeSectionLayout(base, mine, theirs, theirs.rows).rows, theirs.rows);
  assert.deepEqual(mergeSectionLayout({ rows }, { rows: mine.rows }, { rows }, rows).rows, rows);
});

test("sections: a group move and concurrent paste over its first scene keep the replacement inside the moved group", () => {
  const base = { rows, sections };
  const mine = { rows: ["c", "d", "a", "b"].map(id => ({ id })), sections };
  const theirs = {
    rows: ["a", "b", "x", "y", "d"].map(id => ({ id })),
    sections: [sections[0], { id: "s2", name: "Ending", firstSceneId: "x" }]
  };
  const merged = mergeSectionLayout(base, mine, theirs, theirs.rows);
  const mergedRows = merged.rows;
  assert.deepEqual(mergedRows.map(row => row.id), ["x", "y", "d", "a", "b"]);
  assert.equal(sectionForBeat(merged, "d")?.id, "s2");
  assert.equal(sectionForBeat(merged, "a")?.id, "s1");
  for (const [mineSide, theirSide] of [[mine, theirs], [theirs, mine]]) {
    const migration = fakeMigration();
    const result = mergeStateFields(migrateRows(structuredClone(base), migration.ports),
      migrateRows(structuredClone(mineSide), migration.ports), migrateRows(structuredClone(theirSide), migration.ports), fakePorts(() => []));
    const state = migrateRows(result.merged, migration.ports);
    assert.deepEqual(state.rows.map(row => row.id), ["x", "y", "d", "a", "b"]);
    assert.equal(sectionForBeat(state, "d")?.id, "s2");
  }
});

test("sections: replacing a singleton retains its section's concurrent move in both orientations", () => {
  const base = { rows: [{ id: "a" }, { id: "b" }], sections: [sections[0], { ...sections[1], firstSceneId: "b" }] };
  const moved = { ...base, rows: [...base.rows].reverse() };
  const replaced = { rows: ["a", "x", "y"].map(id => ({ id })), sections: [sections[0], { ...sections[1], firstSceneId: "x" }] };
  for (const [mine, theirs] of [[moved, replaced], [replaced, moved]]) {
    const migration = fakeMigration();
    const result = mergeStateFields(migrateRows(structuredClone(base), migration.ports),
      migrateRows(structuredClone(mine), migration.ports), migrateRows(structuredClone(theirs), migration.ports), fakePorts(() => []));
    const state = migrateRows(result.merged, migration.ports);
    assert.deepEqual(state.rows.map(row => row.id), ["x", "y", "a"]);
    assert.equal(sectionForBeat(state, "x")?.id, "s2");
    assert.equal(sectionForBeat(state, "y")?.id, "s2");
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
    const result = mergeSectionLayout(base, mine, theirs, edited.rows);
    assert.deepEqual(result.rows.map(row => row.id), ["d", "e", "a", "c", "b"]);
    assert.equal(sectionForBeat(result, "c")?.id, "A");
  }
});

test("sections: an emptied moved section cannot reorder its scenes inside the destination section", () => {
  const base = { rows: ["a", "b", "c", "d"].map(id => ({ id })), sections: [
    { id: "A", name: "A", firstSceneId: "a" }, { id: "B", name: "B", firstSceneId: "d" }
  ] };
  const moved = { ...base, rows: ["d", "a", "b", "c"].map(id => ({ id })) };
  const edited = { rows: ["a", "b", "d", "x", "c"].map(id => ({ id })), sections: [base.sections[0]] };
  for (const [mine, theirs] of [[moved, edited], [edited, moved]] as const) {
    const result = mergeSectionLayout(base, mine, theirs, edited.rows);
    assert.deepEqual(result.rows.map(row => row.id), ["a", "b", "d", "x", "c"]);
    assert.deepEqual(result.sections, [base.sections[0]]);
  }
});
