import test from "node:test";
import assert from "node:assert/strict";
import type { SharedOperation, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { operation, ref, replicas } from "./executor-support.ts";

const TEXT: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };

function fixture(audioText: string): Record<string, unknown> {
  return { title: "Title", rows: [{ id: "R1", audioText, status: "todo" }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] };
}

function shown(handle: SharedDocumentHandle): string {
  return (readSharedTextHistory(handle, TEXT)?.units ?? []).map(unit => String(unit.value)).join("");
}

function typed(handle: SharedDocumentHandle, id: string, at: number, value: string): SharedOperation {
  const left = createSharedAnchor(handle, TEXT, at, "before");
  assert.ok(left);
  return operation({ kind: "text-insert", id, by: "Alice", target: TEXT, at: { left, right: null, affinity: "after" }, content: [{ value, marks: [] }] });
}

function cut(handle: SharedDocumentHandle, from: number, to: number): SharedOperation {
  const units = (readSharedTextHistory(handle, TEXT)?.units ?? []).slice(from, to).map(unit => unit.identity);
  assert.equal(units.length, to - from);
  return operation({ kind: "text-delete", id: "cut", by: "Alice", target: TEXT, observed: units });
}

function commanded(handle: SharedDocumentHandle, operations: readonly SharedOperation[]): SharedUndoRecord {
  const execution = executeSharedCommand(handle, operations, { label: "command", selection: null, typing: null });
  assert.deepEqual(execution.result, { ok: true });
  assert.ok(execution.record);
  return execution.record;
}

const RUNS = [
  { name: "an emoji", seed: "a\u{1f600}b", type: [] as readonly (readonly [number, string])[], from: 1, to: 3, whole: "a\u{1f600}b", without: "ab" },
  { name: "a run of several units", seed: "abcdZ", type: [], from: 1, to: 4, whole: "abcdZ", without: "aZ" },
  { name: "a run typed in two commands", seed: "abZ", type: [[1, "xy"], [3, "pq"]], from: 1, to: 5, whole: "axypqbZ", without: "abZ" },
  { name: "a run with an emoji typed in two commands", seed: "abZ", type: [[1, "x\u{1f600}"], [4, "\u{1f601}q"]], from: 2, to: 6, whole: "ax\u{1f600}\u{1f601}qbZ", without: "axqbZ" }
] as const;

for (const item of RUNS) {
  test(`five rounds of undo and redo on a cut of ${item.name} return the exact string on every copy each time`, () => {
    const run = replicas(2, fixture(item.seed));
    try {
      for (const handle of [run.a, run.b]) { registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle); }
      item.type.forEach(([at, value], index) => { commanded(run.a, [typed(run.a, "typed:" + index, at, value)]); });
      assert.equal(shown(run.a), item.whole);
      let record = commanded(run.a, [cut(run.a, item.from, item.to)]), serial = 0;
      const writer = { by: "Alice", nextId: () => "undo:" + ++serial }, seen: string[][] = [];
      const everywhere = (): string[] => {
        run.queue.flush("D1");
        const late = createMonitoredSharedDocument();
        try {
          assert.ok(applySharedUpdate(late, encodeSharedState(run.b)).ok);
          return [shown(run.a), shown(run.b), shown(late)];
        } finally { destroySharedDocument(late); }
      };
      seen.push(everywhere());
      for (let round = 0; round < 10; round++) {
        const reversal = reverseSharedUndoRecord(run.a, record, writer);
        assert.ok(reversal.ok && reversal.effective);
        record = reversal.inverse;
        seen.push(everywhere());
      }
      const cutEverywhere = [item.without, item.without, item.without], wholeEverywhere = [item.whole, item.whole, item.whole];
      assert.deepEqual(seen, [cutEverywhere, wholeEverywhere, cutEverywhere, wholeEverywhere, cutEverywhere, wholeEverywhere, cutEverywhere,
        wholeEverywhere, cutEverywhere, wholeEverywhere, cutEverywhere]);
    } finally { run.close(); }
  });
}
