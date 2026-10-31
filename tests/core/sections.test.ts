import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../src/core/migrate.ts";
import { sectionForScene } from "../../src/core/document/sections.ts";
import { mergeSections, sectionMergeOrder } from "../../src/core/merge/sections.ts";
import { fakeMigration } from "./migrate-ports.ts";

const rows = ["a", "b", "c", "d"].map(id => ({ id }));
const sections = [{ id: "s1", name: "Opening", firstSceneId: "a" }, { id: "s2", name: "Ending", firstSceneId: "c" }];

test("sections: migration omits absent and empty metadata, normalizes names, rejects bad or duplicate anchors", () => {
  const migration = fakeMigration();
  for (const value of [undefined, null, [], "invalid"]) {
    const doc = migrateRows({ rows, sections: value }, migration.ports);
    assert.equal("sections" in doc, false);
  }
  const doc = migrateRows({ rows, sections: [sections[1], { ...sections[0], name: "  Opening  " },
    { id: "duplicate", name: "Duplicate", firstSceneId: "a" }, { id: "orphan", name: "Gone", firstSceneId: "gone" }] }, migration.ports);
  assert.deepEqual(doc.sections, sections);
  assert.equal(sectionForScene(doc, "b")?.id, "s1");
  assert.equal(sectionForScene(doc, "d")?.id, "s2");
});

test("sections: concurrent rename and anchor change combine; same-property conflicts keep theirs", () => {
  const base = { rows, sections };
  const mine = { rows, sections: [{ ...sections[0], name: "Renamed" }, sections[1]] };
  const theirs = { rows, sections: [{ ...sections[0], firstSceneId: "b" }, sections[1]] };
  assert.deepEqual(mergeSections(base, mine, theirs, rows)?.[0], { id: "s1", name: "Renamed", firstSceneId: "b" });
  assert.equal(mergeSections(base, mine, { rows, sections: [{ ...sections[0], name: "Incoming" }, sections[1]] }, rows)?.[0]?.name, "Incoming");
});

test("sections: deletion beats unchanged, edited headers survive deletion, missing anchors advance within their group", () => {
  const base = { rows, sections };
  assert.deepEqual(mergeSections(base, { rows }, base, rows), undefined);
  const edited = { rows, sections: [{ ...sections[0], name: "Keep" }, sections[1]] };
  assert.deepEqual(mergeSections(base, { rows }, edited, rows), [{ id: "s1", name: "Keep", firstSceneId: "a" }]);
  assert.equal(mergeSections(base, base, base, rows.slice(1))?.[0]?.firstSceneId, "b");
  assert.deepEqual(mergeSections(base, base, base, []), undefined);
});

test("sections: a one-sided group move survives merge and incoming rows retain their neighbour", () => {
  const base = { rows, sections };
  const mine = { rows: ["c", "d", "a", "b"].map(id => ({ id })), sections };
  const incoming = [{ id: "a" }, { id: "new" }, ...rows.slice(1)];
  assert.deepEqual(sectionMergeOrder(base, mine, { rows: incoming, sections }, incoming).map(row => row.id), ["c", "d", "a", "new", "b"]);
  const theirs = { rows: [...rows].reverse(), sections };
  assert.deepEqual(sectionMergeOrder(base, mine, theirs, theirs.rows), theirs.rows);
  assert.deepEqual(sectionMergeOrder({ rows }, { rows: mine.rows }, { rows }, rows), rows);
});

test("sections: a group move and concurrent paste over its first scene keep the replacement inside the moved group", () => {
  const base = { rows, sections };
  const mine = { rows: ["c", "d", "a", "b"].map(id => ({ id })), sections };
  const theirs = {
    rows: ["a", "b", "x", "y", "d"].map(id => ({ id })),
    sections: [sections[0], { id: "s2", name: "Ending", firstSceneId: "x" }]
  };
  const mergedRows = sectionMergeOrder(base, mine, theirs, theirs.rows);
  const merged = { rows: mergedRows, sections: mergeSections(base, mine, theirs, mergedRows) };
  assert.deepEqual(mergedRows.map(row => row.id), ["x", "y", "d", "a", "b"]);
  assert.equal(sectionForScene(merged, "d")?.id, "s2");
  assert.equal(sectionForScene(merged, "a")?.id, "s1");
});
