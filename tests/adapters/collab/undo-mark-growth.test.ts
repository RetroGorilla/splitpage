import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { SharedContentRef, SharedOperation, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { sharedMarkProvenanceCost } from "../../../src/adapters/collab/mark-provenance.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { operation, ref, replicas } from "./executor-support.ts";

const TEXT: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };
const BOLD = { kind: "b", value: true } as const;

function keys(handle: SharedDocumentHandle): string[] {
  const store: unknown = (collabState(handle).roots.segments.get("b:R1") as Y.Map<unknown>).get("markRecords");
  assert.ok(store instanceof Y.Map);
  return [...(store as Y.Map<unknown>).keys()].sort();
}

function read(handle: SharedDocumentHandle): string {
  return (readSharedMarkCharacters(handle, TEXT) ?? []).map(unit => unit.value + (unit.marks.some(group => group.kind === "b") ? "*" : "")).join(" ");
}

function bold(handle: SharedDocumentHandle, id: string, by: string): SharedOperation {
  const span = captureSharedTextRange(handle, TEXT, 0, 1);
  assert.ok(span);
  return operation({ kind: "mark", id, by, target: TEXT, observed: [span], mark: BOLD });
}

function withHandlers(...handles: SharedDocumentHandle[]): void {
  for (const handle of handles) { registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle); }
}

test("200 rounds of bold and undo: every round is accepted, no stored key grows with the history and the document grows by a fixed step", () => {
  const run = replicas();
  try {
    withHandlers(run.a, run.b);
    let serial = 0;
    const writer = { by: "Alice", nextId: () => "u" + ++serial }, sizes: number[] = [encodeSharedState(run.a).length], longest: number[] = [];
    for (let round = 1; round <= 200; round++) {
      const execution = executeSharedCommand(run.a, [bold(run.a, "m" + round, "Alice")], { label: "bold", selection: null, typing: null });
      assert.deepEqual(execution.result, { ok: true }, "round " + round);
      assert.ok(execution.record);
      assert.equal(read(run.a), "a* b Z", "round " + round);
      const undone = reverseSharedUndoRecord(run.a, execution.record, writer);
      assert.ok(undone.ok && undone.effective, "round " + round);
      assert.equal(read(run.a), "a b Z", "round " + round);
      sizes.push(encodeSharedState(run.a).length);
      longest.push(Math.max(...keys(run.a).map(key => key.length)));
    }
    const all = keys(run.a);
    assert.deepEqual([all.find(key => key.includes("m1\\\",0")), all.find(key => key.includes("m12\\\"")), all.find(key => key.includes("m200\\\""))],
      ["[1,\"[\\\"range-mark\\\",\\\"m1\\\",0]\"]", "[1,\"[\\\"range-mark\\\",\\\"m12\\\",0,12]\"]", "[1,\"[\\\"range-mark\\\",\\\"m200\\\",0,200]\"]"]);
    assert.deepEqual([longest[0], longest[11], longest[199]], [33, 35, 37]);
    const steps = sizes.slice(1).map((size, index) => size - (sizes[index] ?? 0));
    assert.deepEqual([steps[0], steps[1], steps[10], steps[11], steps[99], steps[100], steps[199], Math.min(...steps), Math.max(...steps), sizes[200]],
      [492, 481, 489, 489, 497, 497, 497, 481, 497, 99595]);
    run.queue.flush("D1");
    assert.equal(read(run.b), "a b Z");
  } finally { run.close(); }
});

test("identical marks made apart share one number; a mark made after seeing them carries the next, and only that one stays when the first is undone", () => {
  const run = replicas(3), late = createMonitoredSharedDocument();
  try {
    withHandlers(run.a, run.b, run.c, late);
    assert.deepEqual(executeSharedOperations(run.a, [bold(run.a, "m1", "Alice")]), { ok: true });
    assert.deepEqual(executeSharedOperations(run.b, [bold(run.b, "m1", "Bob")]), { ok: true });
    assert.deepEqual(executeSharedOperations(run.c, [bold(run.c, "m1", "Carol")]), { ok: true });
    run.queue.flush("D1");
    assert.deepEqual(executeSharedOperations(run.b, [bold(run.b, "m2", "Bob")]), { ok: true });
    run.queue.flush("D1");
    assert.deepEqual(keys(run.a), ["[1,\"[\\\"range-mark\\\",\\\"m1\\\",0]\"]", "[2,\"[\\\"range-mark\\\",\\\"m1\\\",0]\"]", "[2,\"[\\\"range-mark\\\",\\\"m2\\\",0,2]\"]",
      "[3,\"[\\\"range-mark\\\",\\\"m1\\\",0]\"]"]);
    const first = (readSharedTextHistory(run.a, TEXT)?.records ?? []).find(item => item.record.type === "add" && item.record.writer === 1);
    assert.ok(first);
    const retract = (id: string, occurrence: SharedContentRef) => operation({ kind: "mark-retract", id, by: "Alice", target: TEXT, occurrences: [occurrence] });
    assert.deepEqual(executeSharedOperations(run.a, [retract("x1", first.identity)], { origin: "local-undo" }), { ok: true });
    run.queue.flush("rev");
    assert.ok(applySharedUpdate(late, encodeSharedState(run.c)).ok);
    assert.deepEqual([run.a, run.b, run.c, late].map(read), ["a* b Z", "a* b Z", "a* b Z", "a* b Z"]);
    const second = (readSharedTextHistory(run.b, TEXT)?.records ?? []).find(item => item.record.type === "add" && item.record.operation.includes("m2"));
    assert.ok(second);
    assert.deepEqual(executeSharedOperations(run.b, [retract("x2", second.identity)], { origin: "local-undo" }), { ok: true });
    run.queue.flush("dup");
    assert.deepEqual([run.a, run.b, run.c].map(read), ["a b Z", "a b Z", "a b Z"]);
  } finally { destroySharedDocument(late); run.close(); }
});

for (const [retractions, visits] of [[10, 40], [20, 80], [100, 400]] as const) {
  test(`one reading of a text with ${retractions} retractions over ${2 * retractions} records visits each record a fixed number of times`, () => {
    const run = replicas(), cold = createMonitoredSharedDocument();
    try {
      withHandlers(run.a, cold);
      for (let round = 1; round <= retractions; round++) {
        assert.deepEqual(executeSharedOperations(run.a, [bold(run.a, "m" + round, "Alice")]), { ok: true });
        const added = (readSharedTextHistory(run.a, TEXT)?.records ?? []).find(item => item.record.type === "add" && item.record.operation.includes("\"m" + round + "\""));
        assert.ok(added);
        assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "mark-retract", id: "x" + round, by: "Alice", target: TEXT, occurrences: [added.identity] })],
          { origin: "local-undo" }), { ok: true });
      }
      assert.equal(keys(run.a).length, 2 * retractions + 1);
      assert.ok(applySharedUpdate(cold, encodeSharedState(run.a)).ok);
      sharedMarkProvenanceCost.scans = 0; sharedMarkProvenanceCost.visits = 0;
      assert.equal(read(cold), "a b Z");
      assert.deepEqual({ ...sharedMarkProvenanceCost }, { scans: 1, visits });
      assert.equal(read(cold), "a b Z");
      assert.deepEqual({ ...sharedMarkProvenanceCost }, { scans: 1, visits });
    } finally { destroySharedDocument(cold); run.close(); }
  });
}
