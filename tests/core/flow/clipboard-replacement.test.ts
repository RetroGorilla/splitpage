import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPos, copyFlowRange, headingPos, pasteFlowRange } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "./load.ts";

for (const backward of [false, true]) {
  for (const survivor of [false, true]) {
    test(`structural replacement consumes only the generated placeholder (${backward}, surviving endpoint ${survivor})`, () => {
      const { ports } = createFlowLoadRuntime();
      const source = { rows: [{ id: "copied", audioText: "Whole", visualText: "Copied visual", status: "shot" }],
        sections: [{ id: "source", name: "Copied header", firstSceneId: "copied" }], comments: [] };
      const clip = copyFlowRange(source, { anchor: headingPos("source", 0), head: beatPos("copied", 5) }, ports);
      const endpoint = { id: "b", audioText: survivor ? "" : "End", visualText: "Original visual", status: "shot", ...(survivor ? { paragraphStart: true } : {}) };
      const doc = { rows: [{ id: "a", audioText: "Alpha", visualText: "First visual" }, endpoint, ...survivor ? [{ id: "c", audioText: "Tail" }] : []],
        comments: [{ id: "comment", rowId: "b", field: "visualText" }] };
      const from = beatPos("a", 0), to = beatPos("b", survivor ? 0 : 3);
      const result = pasteFlowRange(doc, backward ? { anchor: to, head: from } : { anchor: from, head: to }, clip, ports);
      assert.ok(result && "rows" in result);
      assert.deepEqual(result.rows.map(row => row.id), survivor ? ["copied", "b", "c"] : ["copied"]);
      assert.equal(result.rows[0]?.visualText, "Copied visual");
      assert.equal(result.rows[0]?.status, "shot");
      assert.deepEqual(result.sections?.map(scene => [scene.name, scene.firstSceneId]), [["Copied header", "copied"]]);
      assert.deepEqual(result.removedComments, survivor ? [] : ["comment"]);
      if (survivor) assert.deepEqual(result.rows[1], endpoint);
    });
  }
}
