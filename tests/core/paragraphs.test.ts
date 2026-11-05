import { test } from "node:test";
import assert from "node:assert/strict";
import { startsParagraph } from "../../src/core/document/scenes.ts";
import { cloneState } from "../../src/core/document/clone.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { mergeStates } from "../../src/core/merge-states.ts";
import { rowContentEqual } from "../../src/core/merge/rows.ts";
import { fakeMigration } from "./migrate-ports.ts";
import { fakeDecoder, fixedClock } from "./merge/fakes.ts";

function doc(flag?: unknown, marker?: unknown) {
  return migrateRows({ schema: 2, docId: "d" + "1".repeat(32), rows: [
    { id: "a", paragraphStart: flag }, { id: "b" }
  ], paragraphsDecided: marker }, fakeMigration().ports);
}

function merge(base: ReturnType<typeof doc> | null, mine: ReturnType<typeof doc>, theirs: ReturnType<typeof doc>) {
  const migration = fakeMigration();
  return mergeStates(base, mine, theirs, { migrate: migration.ports, ids: migration.ids,
    decode: fakeDecoder([]).decode, clock: fixedClock, editor: () => "Editor" });
}

test("paragraph flags and the decision marker retain only literal true, and clone without aliases", () => {
  for (const value of [undefined, null, false, 0, 1, "true", [], {}, true]) {
    const loaded = doc(value, value);
    assert.ok(loaded.rows[0]);
    assert.equal(Object.hasOwn(loaded.rows[0], "paragraphStart"), value === true);
    assert.equal(Object.hasOwn(loaded, "paragraphsDecided"), value === true);
    assert.equal(loaded.schema, 2);
    const cloned = cloneState(loaded);
    assert.deepEqual(cloned, loaded);
    assert.notEqual(cloned.rows[0], loaded.rows[0]);
    assert.equal(JSON.stringify(migrateRows(cloneState(loaded), fakeMigration().ports)), JSON.stringify(loaded));
  }
});

test("effective starts include the script and scene starts, never missing beats or truthy garbage", () => {
  const source = { rows: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d", paragraphStart: true },
    { id: "e", paragraphStart: "true" }], sections: [{ id: "s", name: "Scene", firstSceneId: "c" }] };
  assert.deepEqual(["a", "b", "c", "d", "e", "missing"].map(id => startsParagraph(source, id)),
    [true, false, true, true, false, false]);
  assert.equal(startsParagraph({ rows: [] }, "a"), false);
});

test("paragraph merge exhausts both orientations, presence and removal, with and without a base", () => {
  for (const baseFlag of [null, undefined, true] as const) {
    for (const mineFlag of [undefined, true] as const) {
      for (const theirFlag of [undefined, true] as const) {
        const base = baseFlag === null ? null : doc(baseFlag);
        const mine = doc(mineFlag), theirs = doc(theirFlag);
        const before = JSON.stringify([base, mine, theirs]);
        const result = merge(base, mine, theirs);
        const expected = base ? (theirFlag === baseFlag ? mineFlag : theirFlag) : (mineFlag || theirFlag);
        assert.equal(result.merged.rows[0]?.paragraphStart, expected);
        assert.ok(result.merged.rows[0]);
        assert.equal(Object.hasOwn(result.merged.rows[0], "paragraphStart"), expected === true);
        assert.deepEqual(result.conflicts, []);
        assert.equal(JSON.stringify([base, mine, theirs]), before);
      }
    }
  }
});

test("a paragraph-only edit survives a concurrent delete in either orientation, including clearing a break", () => {
  for (const flag of [undefined, true] as const) {
    const base = doc(flag), changed = doc(flag ? undefined : true), deleted = doc(flag);
    deleted.rows.shift();
    assert.equal(rowContentEqual(base.rows[0], changed.rows[0]), false);
    for (const ancestor of [base, null]) {
      for (const [mine, theirs] of [[changed, deleted], [deleted, changed]] as const) {
        const result = merge(ancestor, mine, theirs);
        assert.deepEqual(result.merged.rows.find(row => row.id === "a"), changed.rows[0]);
      }
    }
    assert.equal(merge(base, base, deleted).merged.rows.some(row => row.id === "a"), false);
    assert.equal(merge(base, deleted, base).merged.rows.some(row => row.id === "a"), false);
  }
});

test("paragraph-only merges preserve visible attribution and do not report a content edit", () => {
  for (const baseFlag of [undefined, true] as const) {
    const base = doc(baseFlag), changed = doc(baseFlag ? undefined : true);
    for (const document of [base, changed]) {
      for (const row of document.rows) {
        row.updatedAt = "2020-01-01T00:00:00.000Z";
        row.updatedBy = "Alice";
      }
    }
    for (const ancestor of [base, null]) {
      for (const [mine, theirs] of [[changed, base], [base, changed]] as const) {
        const result = merge(ancestor, mine, theirs);
        assert.equal(result.merged.rows[0]?.updatedAt, base.rows[0]?.updatedAt);
        assert.equal(result.merged.rows[0]?.updatedBy, "Alice");
        assert.deepEqual(result.stats, { rowsFromMe: 0, rowsFromThem: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 });
      }
    }
  }
});

test("paragraphsDecided is true if either side has it; the base alone does not retain it", () => {
  for (const base of [null, doc(undefined), doc(undefined, true)]) {
    for (const mine of [undefined, true] as const) {
      for (const theirs of [undefined, true] as const) {
        const result = merge(base, doc(undefined, mine), doc(undefined, theirs)).merged;
        assert.equal(result.paragraphsDecided, mine || theirs);
        assert.equal(Object.hasOwn(result, "paragraphsDecided"), !!(mine || theirs));
      }
    }
  }
});

test("a merge failure after a paragraph edit leaves all inputs intact, and retry survives reload", () => {
  const base = doc(), mine = doc(true, true), theirs = doc();
  assert.ok(mine.rows[1]);
  mine.rows[1].lengthSeconds = 12;
  const before = JSON.stringify([base, mine, theirs]);
  const migration = fakeMigration();
  assert.throws(() => mergeStates(base, mine, theirs, { migrate: migration.ports, ids: migration.ids,
    decode: fakeDecoder([]).decode, clock: { nowIso: () => { throw new Error("clock unavailable"); } },
    editor: () => "Editor" }), /clock unavailable/);
  assert.equal(JSON.stringify([base, mine, theirs]), before);
  const result = merge(base, mine, theirs).merged;
  const saved = JSON.stringify(result);
  assert.equal(JSON.stringify(migrateRows(JSON.parse(saved), fakeMigration().ports)), saved);
  assert.equal(result.rows[0]?.paragraphStart, true);
  assert.equal(result.paragraphsDecided, true);
  assert.equal(result.rows[1]?.updatedBy, "Editor");
  assert.equal(result.rows[1]?.updatedAt, fixedClock.nowIso());
});
