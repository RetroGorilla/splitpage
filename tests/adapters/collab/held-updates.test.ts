import { test } from "node:test";
import assert from "node:assert/strict";
import { applySharedUpdate, observeSharedTransactions, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { operation } from "./executor-support.ts";
import { deliveryReplica } from "./helpers.ts";
import { recordReplicas } from "./record-support.ts";

const SOURCE = { title: "Title", rows: [{ id: "R1", audioText: "ab", status: "todo" }, { id: "R2", audioText: "cd", status: "todo" }] };

function lengths(handle: SharedDocumentHandle): unknown[] {
  return projectSharedDocument(handle).rows.map(row => row["lengthSeconds"] ?? null);
}

function written(handle: SharedDocumentHandle, steps: readonly [string, number][]): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const stop = deliveryReplica(handle).onLocalUpdate(update => { updates.push(update); });
  steps.forEach(([record, value], index) => {
    const list = [operation({ kind: "scalar", id: `o${index}`, by: "A", target: { scope: "beat", record }, field: "lengthSeconds", value })];
    assert.deepEqual(executeSharedOperations(handle, list, { base: readSharedRevision(handle) }), { ok: true });
  });
  stop();
  assert.equal(updates.length, steps.length);
  return updates;
}

test("received updates applied while the handle is notifying are held and applied in arrival order afterwards: every transaction is observed at its own revision with its own content", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const [first, second, third] = written(run.a, [["R1", 7], ["R2", 9], ["R1", 8]]);
    assert.ok(first && second && third);
    const pending = [second, third], results: unknown[] = [], seen: unknown[] = [];
    let sent = 0;
    collabState(run.b).doc.on("update", () => { sent++; });
    const stop = observeSharedTransactions(run.b, origin => {
      for (let next = pending.shift(); next; next = pending.shift()) results.push([applySharedUpdate(run.b, next), readSharedRevision(run.b), lengths(run.b)]);
      seen.push([origin, readSharedRevision(run.b), lengths(run.b)]);
    });
    assert.deepEqual([readSharedRevision(run.b), lengths(run.b)], [1, [null, null]]);
    assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
    stop();
    assert.deepEqual(results, [[{ ok: true }, 2, [7, null]], [{ ok: true }, 2, [7, null]]]);
    assert.deepEqual(seen, [["remote", 2, [7, null]], ["remote", 3, [7, 9]], ["remote", 4, [8, 9]]]);
    assert.deepEqual([readSharedRevision(run.b), lengths(run.b), sent], [4, [8, 9], 3]);
  } finally { run.close(); }
});

test("an invalid update arriving while the handle is notifying is refused at once and nothing is held for it", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const [first] = written(run.a, [["R1", 7]]);
    assert.ok(first);
    const results: unknown[] = [], seen: unknown[] = [];
    const stop = observeSharedTransactions(run.b, () => {
      if (!results.length) results.push(applySharedUpdate(run.b, new Uint8Array([255, 255, 255])));
      seen.push([readSharedRevision(run.b), lengths(run.b)]);
    });
    assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
    stop();
    assert.deepEqual(results, [{ ok: false, reason: "invalid-update" }]);
    assert.deepEqual(seen, [[2, [7, null]]]);
    assert.deepEqual([readSharedRevision(run.b), collabState(run.b).heldUpdates.length], [2, 0]);
  } finally { run.close(); }
});
