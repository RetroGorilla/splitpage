import { strict as assert } from "node:assert";
import { test } from "node:test";
import { groupItemsByScene } from "../../src/core/document/scene-items.ts";

test("groups items in script order and retains items without a beat", () => {
  const doc = {
    rows: [{ id: "a" }, { id: "b" }, { id: "c" }],
    sections: [{ id: "second", name: "Arrival", firstSceneId: "b" }]
  };
  const items = [{ row: "c" }, { row: "missing" }, { row: "a" }, { row: "b" }];
  const result = groupItemsByScene(doc, items, item => item.row);
  assert.deepEqual(result.groups.map(group => [group.scene.letter, group.scene.name, group.items.map(item => item.row)]), [
    ["A", "", ["a"]], ["B", "Arrival", ["c", "b"]]
  ]);
  assert.deepEqual(result.unassigned, [{ row: "missing" }]);
});

test("starts at Scene A when the first beat has a named header", () => {
  const doc = {
    rows: [{ id: "a" }, { id: "b" }],
    sections: [{ id: "first", name: "Opening", firstSceneId: "a" }]
  };
  const result = groupItemsByScene(doc, [{ row: "b" }], item => item.row);
  assert.deepEqual(result.groups.map(group => [group.scene.letter, group.scene.name]), [["A", "Opening"]]);
});

test("keeps all items when the document has no beats", () => {
  const result = groupItemsByScene({ rows: [] }, [{ row: "missing" }, { row: "" }], item => item.row);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unassigned, [{ row: "missing" }, { row: "" }]);
});
