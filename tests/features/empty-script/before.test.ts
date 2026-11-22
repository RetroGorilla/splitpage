import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { replaceRange, beatPos } from "../../../src/core/flow/flow.ts";

test("standalone full removal keeps the last beat empty through replaceRange", () => {
  const doc = { rows: [{ id: "R1", audioText: "ab" }], comments: [] };
  const result = replaceRange(doc, { anchor: beatPos("R1", 0), head: beatPos("R1", 2) }, [], { ...createFlowLoadRuntime().ports, newId: () => "blank" }, true);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows, [{ id: "R1", audioText: "" }]);
});

test("standalone whole-script cross-beat removal recreates one empty beat through replaceRange's repair", () => {
  const doc = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }], comments: [] };
  const result = replaceRange(doc, { anchor: beatPos("R1", 0), head: beatPos("R2", 2) }, [], { ...createFlowLoadRuntime().ports, newId: () => "blank" }, true);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows, [{ id: "blank", visualText: "", imageRef: null, audioText: "", status: "todo" }]);
});

test("standalone removing every beat of a scene retains its heading and repairs one empty follower", () => {
  const doc = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }], comments: [], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] };
  const result = replaceRange(doc, { anchor: beatPos("R1", 0), head: beatPos("R2", 2) }, [], { ...createFlowLoadRuntime().ports, newId: () => "blank" }, true);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows, [{ id: "blank", visualText: "", imageRef: null, audioText: "", status: "todo" }]);
  assert.deepEqual(result.sections, [{ id: "H1", name: "Scene", firstSceneId: "blank" }]);
});
