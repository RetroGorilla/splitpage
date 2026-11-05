import "../../../src/test/_dom.mjs";
import "../../../src/test/_copy-paste-mounted.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pasteFlowClipboard } from "../../../src/features/clipboard/flow-clip.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { cellOf, inertBody } from "../../../src/bootstrap/richtext.ts";
import { beatPos, caretAt } from "../../../src/core/flow/flow.ts";
import type { FlowPorts } from "../../../src/core/flow/flow.ts";

for (const backward of [false, true]) {
  for (const [name, payload] of [
    ["missing structure", { format: "splitpage-flow", version: 1, text: "" }],
    ["empty structure", { format: "splitpage-flow", version: 1, text: "", beats: null, wholeIds: [], headers: [] }],
    ["invalid header list", { format: "splitpage-flow", version: 1, text: "", beats: null, wholeIds: [], headers: {} }],
    ["missing whole beats", { format: "splitpage-flow", version: 1, text: "", beats: null, wholeIds: ["missing"], headers: [] }]
  ] as const) {
    test(`empty flow payload falls back to plain text: ${name} (${backward})`, () => {
      const doc = migrateRows({ rows: [{ id: "a", audioText: "Alpha", visualText: "Keep A" }, { id: "b", audioText: "Bravo", visualText: "Keep B" }] });
      const before = JSON.stringify(doc);
      const from = beatPos("a", 0), to = beatPos("b", 5);
      const data = { getData: (type: string) => type === "application/x-splitpage-flow" ? JSON.stringify(payload) : type === "text/plain" ? "Replacement" : "" };
      const ports: FlowPorts = { cells: cellOf, hasVisual: row => !!row.visualText, newId: () => "new" };
      assert.equal(pasteFlowClipboard(doc, backward ? { anchor: to, head: from } : { anchor: from, head: to }, data, ports, inertBody, migrateRows), undefined);
      assert.equal(JSON.stringify(doc), before);
    });
  }
}

test("an empty narration with a whole visual beat remains structural clipboard content", () => {
  const doc = migrateRows({ rows: [{ id: "a", audioText: "Alpha", visualText: "Original" }] });
  const payload = { format: "splitpage-flow", version: 1, text: "", wholeIds: ["visual"], headers: [],
    beats: { format: "splitpage-scenes", version: 1, rows: [{ id: "visual", audioText: "", visualText: "Copied visual", status: "shot" }] } };
  const data = { getData: (type: string) => type === "application/x-splitpage-flow" ? JSON.stringify(payload) : "" };
  let next = 0;
  const ports: FlowPorts = { cells: cellOf, hasVisual: row => !!row.visualText, newId: () => "new" + ++next };
  const result = pasteFlowClipboard(doc, caretAt(beatPos("a", 0)), data, ports, inertBody, migrateRows);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows.map(row => [row.audioText, row.visualText, row.status]), [["", "Copied visual", "shot"], ["Alpha", "Original", "todo"]]);
});
