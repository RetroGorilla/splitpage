import test from "node:test";
import assert from "node:assert/strict";
import { FlowOperationTrace } from "../../../src/core/flow/operations.ts";
import { setMark, addComment, explode } from "../../../src/core/text/edits.ts";
import { tagStack } from "../../../src/core/text/runs.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { createFlowLoadRuntime } from "./load.ts";
import { samePayloadMarkCases, samePayloadTextFields } from "./mark-occurrence-cases.ts";

for (const fixture of samePayloadMarkCases) test(`same-payload ${fixture.kind} name trace uses only missing units`, () => {
  const { field, edges } = samePayloadTextFields[0];
  const rt = createFlowLoadRuntime(), cell = rt.cells(fixture.base), next = fixture.kind === "comment" ? addComment(cell, 0, 4, "C")
    : setMark(cell, 0, 4, fixture.kind === "tag" ? "tag" : "href", fixture.mark.value);
  assert.equal(toHtml(cell), fixture.base); assert.equal(toHtml(next), fixture.html);
  assert.deepEqual(explode(next).map(char => {
    const marks = char.atom ? char.atom.marks : char.marks;
    return fixture.kind === "tag" ? tagStack(marks).length : fixture.kind === "comment" ? marks.cmt?.length ?? 0 : Number(!!marks.href);
  }), fixture.standaloneCounts);
  const trace = new FlowOperationTrace({ rows: [{ id: "R1", [field]: fixture.base }] }, rt.ports, { id: "mark", by: "Writer" });
  trace.marks("R1", cell, 0, 4, next, fixture.kind === "tag" ? "tag" : fixture.kind === "link" ? "href" : "cmt", true);
  assert.deepEqual(trace.ops, [{ kind: "mark", target: { owner: "R1", segment: "R1", field },
    observed: edges, mark: fixture.mark, id: "mark:0", by: "Writer" }]);
});
