import test from "node:test";
import assert from "node:assert/strict";
import type { SharedContentRef, SharedOperation, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { SHARED_MARK_PROVENANCE_MARKER, hasSharedMarkProvenanceMarker, sharedMarkProvenanceCost } from "../../../src/adapters/collab/mark-provenance.ts";
import { prepareSharedMarkRecord, readSharedMarkCharacters, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { operation, ref, replicas } from "./executor-support.ts";

const TEXT: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };
const BOLD = { kind: "b", value: true } as const;

function read(handle: SharedDocumentHandle): string {
  return (readSharedMarkCharacters(handle, TEXT) ?? []).map(unit => unit.value + (unit.marks.some(group => group.kind === "b") ? "*" : "")).join(" ");
}

function bold(handle: SharedDocumentHandle, id: string, by: string): SharedOperation {
  const span = captureSharedTextRange(handle, TEXT, 0, 2);
  assert.ok(span);
  return operation({ kind: "mark", id, by, target: TEXT, observed: [span], mark: BOLD });
}

function occurrence(handle: SharedDocumentHandle, client: number): SharedContentRef {
  const found = (readSharedTextHistory(handle, TEXT)?.records ?? []).find(item => item.record.type === "add" && item.record.writer === client);
  assert.ok(found);
  return found.identity;
}

function typed(handle: SharedDocumentHandle, id: string): SharedOperation {
  const left = createSharedAnchor(handle, TEXT, 1, "before");
  assert.ok(left);
  return operation({ kind: "text-insert", id, by: "Alice", target: TEXT, at: { left, right: null, affinity: "after" }, content: [{ value: "x", marks: [] }] });
}

function withHandlers(...handles: SharedDocumentHandle[]): void {
  for (const handle of handles) { registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle); }
}

test("the marker is found among sorted store keys wherever it sorts, and not in a store without it", () => {
  const records = ["[1,\"a\"]", "[2,\"b\"]", "[\"hydration\",\"c\"]"].sort();
  assert.equal(hasSharedMarkProvenanceMarker([]), false);
  assert.equal(hasSharedMarkProvenanceMarker(records), false);
  assert.equal(hasSharedMarkProvenanceMarker([...records, SHARED_MARK_PROVENANCE_MARKER].sort()), true);
  assert.equal(hasSharedMarkProvenanceMarker([...records, SHARED_MARK_PROVENANCE_MARKER, "zebra"].sort()), true);
  assert.equal(hasSharedMarkProvenanceMarker([...records, "apple", "zebra"].sort()), false);
  assert.equal(hasSharedMarkProvenanceMarker([SHARED_MARK_PROVENANCE_MARKER]), true);
});

test("a warm reading is not served after another writer's retraction arrives with the marker, nor after a later ordinary record", () => {
  const run = replicas(), late = createMonitoredSharedDocument();
  try {
    withHandlers(run.a, run.b, late);
    assert.deepEqual(executeSharedOperations(run.a, [bold(run.a, "m1", "Alice")]), { ok: true });
    assert.deepEqual(executeSharedOperations(run.b, [bold(run.b, "m1", "Bob")]), { ok: true });
    run.queue.flush("D1");
    assert.deepEqual([read(run.a), read(run.b), read(run.a), read(run.b)], ["a* b* Z", "a* b* Z", "a* b* Z", "a* b* Z"]);
    assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "mark-retract", id: "x1", by: "Alice", target: TEXT, occurrences: [occurrence(run.a, 1)] })],
      { origin: "local-undo" }), { ok: true });
    assert.equal(read(run.b), "a* b* Z");
    run.queue.flush("D1");
    assert.ok(applySharedUpdate(late, encodeSharedState(run.b)).ok);
    assert.deepEqual([read(run.a), read(run.b), read(late), read(run.b)], ["a b Z", "a b Z", "a b Z", "a b Z"]);
    assert.deepEqual(executeSharedOperations(run.a, [bold(run.a, "m2", "Alice")]), { ok: true });
    assert.equal(read(run.b), "a b Z");
    run.queue.flush("D1");
    const joined = createMonitoredSharedDocument();
    try {
      assert.ok(applySharedUpdate(joined, encodeSharedState(run.b)).ok);
      assert.deepEqual([read(run.a), read(run.b), read(joined), read(run.b)], ["a* b* Z", "a* b* Z", "a* b* Z", "a* b* Z"]);
    } finally { destroySharedDocument(joined); }
  } finally { destroySharedDocument(late); run.close(); }
});

for (const ordinary of [10, 1000]) {
  test(`with ${ordinary} ordinary mark records and no retraction, reading and typing cost zero provenance visits with the cache cold and warm`, () => {
    const handle = createMonitoredSharedDocument(), cold = createMonitoredSharedDocument();
    try {
      hydrateSharedDocument(handle, validatedFixture({ title: "Title", rows: [{ id: "R1", audioText: "abZ", status: "todo" }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] }));
      withHandlers(handle, cold);
      for (let index = 0; index < ordinary; index++) {
        const id = "link" + index, record = prepareSharedMarkRecord(handle, TEXT, id, 0, 1, { type: "add", mark: { kind: "link", id: ref("L" + index), value: "https://a.test/" + index } });
        assert.ok(record);
        assert.deepEqual(writeSharedMarkRecord(handle, TEXT, id, record), { ok: true });
      }
      assert.ok(applySharedUpdate(cold, encodeSharedState(handle)).ok);
      sharedMarkProvenanceCost.scans = 0; sharedMarkProvenanceCost.visits = 0;
      assert.equal(read(cold), "a b Z");
      assert.deepEqual(executeSharedOperations(cold, [typed(cold, "cold")]), { ok: true });
      assert.equal(read(handle), "a b Z");
      assert.equal(read(handle), "a b Z");
      assert.deepEqual(executeSharedOperations(handle, [typed(handle, "warm")]), { ok: true });
      assert.deepEqual([read(handle), read(cold)], ["a x b Z", "a x b Z"]);
      assert.deepEqual({ ...sharedMarkProvenanceCost }, { scans: 0, visits: 0 });
    } finally { destroySharedDocument(handle); destroySharedDocument(cold); }
  });
}
