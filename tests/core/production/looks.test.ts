import { test } from "node:test";
import assert from "node:assert/strict";
import { ROW_STATUSES, TAG_CATEGORIES, TAG_STATUSES, groupTagsByCategory, rowStatus, tagCategory, tagStatus } from "../../../src/core/production/looks.ts";

test("the looks tables follow the id lists, in order", () => {
  assert.deepEqual(ROW_STATUSES.map((s) => s.id), ["todo", "ready", "shot"]);
  assert.deepEqual(TAG_STATUSES.map((s) => s.id), ["needed", "sourcing", "have", "returned"]);
  assert.deepEqual(TAG_CATEGORIES.map((c) => c.id), ["prop", "location", "cast", "vfx", "sound", "gear"]);
});

test("a lookup finds its entry and answers null for anything else, including inherited names", () => {
  assert.equal(rowStatus("shot")?.label, "Shot");
  assert.equal(tagStatus("have")?.label, "Have it");
  assert.equal(tagCategory("sound")?.label, "Music/SFX");
  for (const bad of ["nope", "__proto__", "constructor", "", null, undefined, 3]) {
    assert.equal(rowStatus(bad), null);
    assert.equal(tagStatus(bad), null);
    assert.equal(tagCategory(bad), null);
  }
});

test("tags group by category with the busiest first and orphans last", () => {
  const tag = (name: string, id: string, mentions: number, orphaned: boolean) =>
    ({ name, cat: { id }, mentions: new Array<number>(mentions).fill(0), orphaned });
  const groups = groupTagsByCategory([
    tag("b", "prop", 1, false), tag("a", "prop", 3, false), tag("z", "prop", 9, true), tag("rig", "gear", 1, false)
  ]);
  assert.deepEqual(groups.map((g) => g.cat.id), ["prop", "gear"]);
  assert.deepEqual(groups[0]?.items.map((t) => t.name), ["a", "b", "z"]);
});
