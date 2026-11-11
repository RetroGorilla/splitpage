import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSharedTagExtents } from "../../../src/core/collab/projection/tag-extents.ts";
import type { SharedProjectionUnit } from "../../../src/core/collab/projection/units.ts";

test("tag extents preserve inputs, reject crossings, and ignore atom tag marks", () => {
  const units: readonly SharedProjectionUnit[] = Object.freeze([
    { value: "a", marks: Object.freeze([{ kind: "tag" as const, id: "outer", value: "t:prop:Cup" }]) },
    { value: "b", marks: Object.freeze([{ kind: "tag" as const, id: "outer", value: "t:prop:Cup" }, { kind: "tag" as const, id: "cross", value: "t:cast:Ada" }]) },
    { value: "c", marks: Object.freeze([{ kind: "tag" as const, id: "cross", value: "t:cast:Ada" }]) },
    { value: { atom: "who" as const, name: "Ada" }, marks: Object.freeze([{ kind: "tag" as const, id: "atom", value: "t:cast:Ada" }]) }
  ].map(unit => Object.freeze(unit)));
  const before = JSON.stringify(units), result = projectSharedTagExtents(units, []);
  assert.equal(JSON.stringify(units), before);
  assert.deepEqual(result.rejected, [{ kind: "crossing-tag", occurrence: "cross", tag: "t:cast:Ada", from: 1, to: 3, words: "bc" }]);
  assert.deepEqual(result.units, [
    { value: "a", marks: [{ kind: "tag", id: "outer", value: "t:prop:Cup" }] },
    { value: "b", marks: [{ kind: "tag", id: "outer", value: "t:prop:Cup" }] },
    { value: "c", marks: [] }, { value: { atom: "who", name: "Ada" }, marks: [] }
  ]);
});

test("tag extent acceptance uses longer-first before UTF-16 ids and permits adjacent occurrences", () => {
  const units: SharedProjectionUnit[] = [
    { value: "a", marks: [{ kind: "tag", id: "z", value: "t:prop:Cup" }, { kind: "tag", id: "a", value: "t:cast:Ada" }] },
    { value: "b", marks: [{ kind: "tag", id: "z", value: "t:prop:Cup" }] },
    { value: "c", marks: [{ kind: "tag", id: "tail", value: "t:cast:Ada" }] }
  ];
  for (const input of [units, units.map(unit => ({ value: unit.value, marks: [...unit.marks].reverse() }))]) {
    const result = projectSharedTagExtents(input, []);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.units[0]?.marks.map(mark => mark.id), ["z", "a"]);
    assert.deepEqual(result.units[2]?.marks.map(mark => mark.id), ["tail"]);
  }
});

test("one tag name is a presence set: overlapping native occurrences have one outer extent", () => {
  const units: SharedProjectionUnit[] = [
    { value: "a", marks: [{ kind: "tag", id: "z", value: "t:prop:Cup" }] },
    { value: "b", marks: [{ kind: "tag", id: "z", value: "t:prop:Cup" }, { kind: "tag", id: "y", value: "t:prop:Cup" }, { kind: "tag", id: "a", value: "t:cast:Ada" }] },
    { value: "c", marks: [{ kind: "tag", id: "y", value: "t:prop:Cup" }, { kind: "tag", id: "a", value: "t:cast:Ada" }] },
    { value: "d", marks: [{ kind: "tag", id: "y", value: "t:prop:Cup" }] }
  ];
  const projected = projectSharedTagExtents(units, []);
  assert.deepEqual(projected.rejected, []);
  assert.deepEqual(projected.units.map(unit => unit.marks.map(mark => mark.value)), [["t:prop:Cup"], ["t:prop:Cup", "t:cast:Ada"], ["t:prop:Cup", "t:cast:Ada"], ["t:prop:Cup"]]);
});
