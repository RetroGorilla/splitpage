import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOTYPE_IDS, idMap } from "../../../src/core/document/id-map.ts";

test("PROTOTYPE_IDS names every Object.prototype member, frozen", () => {
  assert.ok(Object.isFrozen(PROTOTYPE_IDS));
  assert.deepEqual([...PROTOTYPE_IDS].sort(), Object.getOwnPropertyNames(Object.prototype).sort());
});

test("an id map has no prototype: every id is stored as given, and a missing one reads as missing", () => {
  const map = idMap<number>();
  assert.equal(Object.getPrototypeOf(map), null);
  PROTOTYPE_IDS.forEach((id) => assert.equal(map[id], undefined, id));
  PROTOTYPE_IDS.forEach((id, i) => { map[id] = i; });
  assert.deepEqual(Object.keys(map), PROTOTYPE_IDS);
  PROTOTYPE_IDS.forEach((id, i) => assert.equal(map[id], i, id));
  assert.equal(Object.getPrototypeOf(map), null);
  assert.notEqual(idMap(), idMap());
});
