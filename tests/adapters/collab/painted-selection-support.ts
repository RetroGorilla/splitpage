import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "./stage1-executor-support.ts";
import { operation, ref } from "./executor-support.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { bufferedFieldKey } from "../../../src/core/collab/buffer.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

export type PaintedSelectionField = "audioText" | "visualText";

export function seedPaintedSelectionHarness(text = "abcdef", second = "uvwx") {
  const h = new Stage1ExecutorHarness([{ id: "R1", text }, { id: "R2", text: second }]);
  const target = (row: string, field: PaintedSelectionField) => ({ owner: ref(row), segment: ref(row), field });
  function execute(handle: SharedDocumentHandle, ops: unknown[]): void {
    assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
  }
  execute(h.a, ["R1", "R2"].map(row => ({
    kind: "text-insert", id: "seed_" + row, by: "Alice", target: target(row, "visualText"),
    at: { left: null, right: flowBaseReference(row, "visualText", 0), affinity: "before" },
    content: [{ value: row === "R1" ? text : second, marks: [] }]
  })));
  h.queue.flush("D1");
  return {
    h,
    target,
    execute,
    key: (field: PaintedSelectionField, row = "R1") => bufferedFieldKey(row, field),
    close: () => { h.destroy(); }
  };
}
