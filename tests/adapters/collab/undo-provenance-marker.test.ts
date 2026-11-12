import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { SharedContentRef, SharedOperation, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import "../../../src/test/_dom.mjs";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, observeSharedTransactions, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { readSharedMarkRecord, readSharedMarkRecordIdentity } from "../../../src/adapters/collab/mark-record.ts";
import { SHARED_MARK_PROVENANCE_MARKER, sharedMarkProvenanceCost } from "../../../src/adapters/collab/mark-provenance.ts";
import { prepareSharedMarkRecord, readCollabMarkState, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { createCollabTextFacade } from "../../../src/adapters/collab/prepare-text.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { operation, ref, replicas } from "./executor-support.ts";
import { projectionReferences } from "./projection-roundtrip-support.ts";

const TEXT: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };
const BOLD = { kind: "b", value: true } as const;

function stores(handle: SharedDocumentHandle): { text: Y.Text; store: Y.Map<unknown> }[] {
  const roots = collabState(handle).roots, found: { text: Y.Text; store: Y.Map<unknown> }[] = [];
  for (const root of [roots.segments, roots.visuals]) for (const key of [...root.keys()].sort()) {
    const container: unknown = root.get(key);
    if (!(container instanceof Y.Map)) continue;
    const text: unknown = container.get("text"), store: unknown = container.get("markRecords");
    if (text instanceof Y.Text && store instanceof Y.Map) found.push({ text, store: store as Y.Map<unknown> });
  }
  const title: unknown = roots.meta.get("title"), titleMarks: unknown = roots.meta.get("titleMarks");
  if (title instanceof Y.Text && titleMarks instanceof Y.Map) found.push({ text: title, store: titleMarks as Y.Map<unknown> });
  return found;
}

function readers(handle: SharedDocumentHandle): string {
  const late = createMonitoredSharedDocument();
  try {
    assert.ok(applySharedUpdate(late, encodeSharedState(handle)).ok);
    return JSON.stringify({ project: projectSharedDocument(handle), late: projectSharedDocument(late), texts: stores(handle).map(({ text, store }) => {
      const facade = createCollabTextFacade(handle, text, store, () => {});
      return { state: readCollabMarkState(handle, text, store), prepared: { length: facade.length, units: facade.units, recordKeys: facade.recordKeys, records: facade.records } };
    }) });
  } finally { destroySharedDocument(late); }
}

function store(handle: SharedDocumentHandle): Y.Map<unknown> {
  const found: unknown = (collabState(handle).roots.segments.get("b:R1") as Y.Map<unknown>).get("markRecords");
  assert.ok(found instanceof Y.Map);
  return found as Y.Map<unknown>;
}

function shown(handle: SharedDocumentHandle): string {
  return (readSharedTextHistory(handle, TEXT)?.units ?? []).map(unit => String(unit.value) + (unit.marks.some(group => group.kind === "b") ? "*" : "")).join(" ");
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

function retract(id: string, by: string, occurrences: readonly SharedContentRef[]): SharedOperation {
  return operation({ kind: "mark-retract", id, by, target: TEXT, occurrences });
}

function typed(handle: SharedDocumentHandle, id: string): SharedOperation {
  const left = createSharedAnchor(handle, TEXT, 1, "before");
  assert.ok(left);
  return operation({ kind: "text-insert", id, by: "Alice", target: TEXT, at: { left, right: null, affinity: "after" }, content: [{ value: "x", marks: [] }] });
}

function withHandlers(...handles: SharedDocumentHandle[]): void {
  for (const handle of handles) { registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle); }
}

test("the provenance marker is not a record: the record validators refuse its key and its value", () => {
  assert.equal(SHARED_MARK_PROVENANCE_MARKER, "provenance");
  assert.equal(readSharedMarkRecordIdentity(SHARED_MARK_PROVENANCE_MARKER), null);
  assert.equal(readSharedMarkRecord(SHARED_MARK_PROVENANCE_MARKER, true), null);
});

test("on 291 fixtures a marker on every text without a retraction changes no reader: mark state, preparation, projection and a late joiner's projection", () => {
  assert.equal(projectionReferences.length, 291);
  let texts = 0;
  for (const fixture of projectionReferences) {
    const handle = createMonitoredSharedDocument();
    try {
      hydrateSharedDocument(handle, migrateRows(structuredClone(fixture.document)));
      const before = readers(handle), found = stores(handle);
      transactSharedDocument(handle, "local-command", () => { for (const item of found) item.store.set(SHARED_MARK_PROVENANCE_MARKER, true); });
      texts += found.length;
      assert.ok(found.length > 0, fixture.name);
      assert.equal(readers(handle), before, fixture.name);
    } finally { destroySharedDocument(handle); }
  }
  assert.ok(texts >= 291);
});

test("the marker is written once, in the transaction of the first retraction on a text, and not by a restore that copies no mark", () => {
  const run = replicas();
  try {
    withHandlers(run.a, run.b);
    assert.deepEqual(executeSharedOperations(run.a, [bold(run.a, "m1", "Alice"), bold(run.a, "m2", "Alice")]), { ok: true });
    const b = readSharedTextHistory(run.a, TEXT)?.units[1]?.identity, a = readSharedTextHistory(run.a, TEXT)?.units[0]?.identity;
    assert.ok(a && b);
    assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "text-delete", id: "d1", by: "Alice", target: TEXT, observed: [b] })]), { ok: true });
    assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "text-restore", id: "u1", by: "Alice", target: TEXT, units: [{ unit: b, left: a, value: "b", marks: [] }] })],
      { origin: "local-undo" }), { ok: true });
    assert.equal(store(run.a).has(SHARED_MARK_PROVENANCE_MARKER), false);
    const records = (readSharedTextHistory(run.a, TEXT)?.records ?? []).filter(item => item.record.type === "add").map(item => item.identity);
    assert.equal(records.length, 2);
    let transactions = 0;
    const stop = observeSharedTransactions(run.a, () => { transactions++; });
    assert.deepEqual(executeSharedOperations(run.a, [retract("x1", "Alice", records.slice(0, 1))], { origin: "local-undo" }), { ok: true });
    assert.equal(transactions, 1);
    assert.equal(store(run.a).get(SHARED_MARK_PROVENANCE_MARKER), true);
    const written = store(run.a)._map.get(SHARED_MARK_PROVENANCE_MARKER)?.id;
    assert.deepEqual(executeSharedOperations(run.a, [retract("x2", "Alice", records.slice(1))], { origin: "local-undo" }), { ok: true });
    stop();
    assert.equal(transactions, 2);
    assert.deepEqual(store(run.a)._map.get(SHARED_MARK_PROVENANCE_MARKER)?.id, written);
    run.queue.flush("D1");
    assert.equal(store(run.b).get(SHARED_MARK_PROVENANCE_MARKER), true);
  } finally { run.close(); }
});

test("a restore that copies a mark writes the marker in its own transaction", () => {
  const run = replicas();
  try {
    withHandlers(run.a, run.b);
    assert.deepEqual(executeSharedOperations(run.a, [bold(run.a, "m1", "Alice")]), { ok: true });
    const units = readSharedTextHistory(run.a, TEXT)?.units ?? [], a = units[0]?.identity, b = units[1]?.identity;
    assert.ok(a && b);
    assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "text-delete", id: "d1", by: "Alice", target: TEXT, observed: [b] })]), { ok: true });
    assert.equal(store(run.a).has(SHARED_MARK_PROVENANCE_MARKER), false);
    let transactions = 0;
    const stop = observeSharedTransactions(run.a, () => { transactions++; });
    assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "text-restore", id: "u1", by: "Alice", target: TEXT,
      units: [{ unit: b, left: a, value: "b", marks: [occurrence(run.a, 1)] }] })], { origin: "local-undo" }), { ok: true });
    stop();
    assert.equal(transactions, 1);
    run.queue.flush("D1");
    assert.deepEqual([run.a, run.b].map(handle => [store(handle).get(SHARED_MARK_PROVENANCE_MARKER), shown(handle)]), [[true, "a* b* Z"], [true, "a* b* Z"]]);
  } finally { run.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) {
  test(`first retractions by two writers who had not seen each other's end in the same marker on every copy and a late joiner: ${order}`, () => {
    const run = replicas(), late = createMonitoredSharedDocument();
    try {
      withHandlers(run.a, run.b, late);
      assert.deepEqual(executeSharedOperations(run.a, [bold(run.a, "m1", "Alice")]), { ok: true });
      assert.deepEqual(executeSharedOperations(run.b, [bold(run.b, "m1", "Bob")]), { ok: true });
      assert.deepEqual(executeSharedOperations(run.a, [retract("x1", "Alice", [occurrence(run.a, 1)])], { origin: "local-undo" }), { ok: true });
      assert.deepEqual(executeSharedOperations(run.b, [retract("x1", "Bob", [occurrence(run.b, 2)])], { origin: "local-undo" }), { ok: true });
      run.queue.flush(order);
      assert.ok(applySharedUpdate(late, encodeSharedState(run.a)).ok);
      assert.deepEqual([run.a, run.b, late].map(handle => [store(handle).get(SHARED_MARK_PROVENANCE_MARKER), shown(handle)]), [[true, "a b Z"], [true, "a b Z"], [true, "a b Z"]]);
      assert.deepEqual(encodeSharedState(run.a), encodeSharedState(run.b));
    } finally { destroySharedDocument(late); run.close(); }
  });
}

test("declared limit: a text seeded by hand with a retraction and no marker reads the retraction as a plain removal, the same on every copy", () => {
  const run = replicas(), late = createMonitoredSharedDocument();
  try {
    withHandlers(run.a, run.b, late);
    assert.deepEqual(executeSharedOperations(run.a, [bold(run.a, "m1", "Alice")]), { ok: true });
    assert.deepEqual(executeSharedOperations(run.b, [bold(run.b, "m1", "Bob")]), { ok: true });
    assert.deepEqual(executeSharedOperations(run.a, [retract("x1", "Alice", [occurrence(run.a, 1)])], { origin: "local-undo" }), { ok: true });
    run.queue.flush("D1");
    assert.deepEqual([shown(run.a), shown(run.b)], ["a b Z", "a b Z"]);
    transactSharedDocument(run.a, "local-command", () => { store(run.a).delete(SHARED_MARK_PROVENANCE_MARKER); });
    run.queue.flush("D1");
    assert.ok(applySharedUpdate(late, encodeSharedState(run.a)).ok);
    assert.deepEqual([run.a, run.b, late].map(handle => [store(handle).has(SHARED_MARK_PROVENANCE_MARKER), shown(handle)]),
      [[false, "a* b* Z"], [false, "a* b* Z"], [false, "a* b* Z"]]);
  } finally { destroySharedDocument(late); run.close(); }
});

for (const ordinary of [10, 1000]) {
  test(`typing one character on a text with ${ordinary} ordinary mark records and no retraction costs zero provenance visits; with the marker it is counted`, () => {
    const handle = createMonitoredSharedDocument();
    try {
      hydrateSharedDocument(handle, validatedFixture({ title: "Title", rows: [{ id: "R1", audioText: "abZ", status: "todo" }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] }));
      withHandlers(handle);
      for (let index = 0; index < ordinary; index++) {
        const id = "link" + index, record = prepareSharedMarkRecord(handle, TEXT, id, 0, 1, { type: "add", mark: { kind: "link", id: ref("L" + index), value: "https://a.test/" + index } });
        assert.ok(record);
        assert.deepEqual(writeSharedMarkRecord(handle, TEXT, id, record), { ok: true });
      }
      assert.equal([...store(handle).keys()].length, ordinary);
      const cost = (run: () => void): { scans: number; visits: number } => {
        sharedMarkProvenanceCost.scans = 0; sharedMarkProvenanceCost.visits = 0;
        run();
        return { ...sharedMarkProvenanceCost };
      };
      assert.deepEqual(cost(() => { assert.deepEqual(executeSharedOperations(handle, [typed(handle, "t1")]), { ok: true }); }), { scans: 0, visits: 0 });
      assert.deepEqual(cost(() => { assert.ok(executeSharedCommand(handle, [typed(handle, "t2")], { label: "typing", selection: null, typing: "t" }).record); }), { scans: 0, visits: 0 });
      assert.deepEqual(executeSharedOperations(handle, [bold(handle, "m1", "Alice")]), { ok: true });
      const added = (readSharedTextHistory(handle, TEXT)?.records ?? []).find(item => item.record.type === "add" && item.record.mark.kind === "b");
      assert.ok(added);
      assert.deepEqual(executeSharedOperations(handle, [retract("x1", "Alice", [added.identity])], { origin: "local-undo" }), { ok: true });
      const records = ordinary + 4;
      assert.deepEqual(cost(() => { assert.deepEqual(executeSharedOperations(handle, [typed(handle, "t3")]), { ok: true }); }), { scans: 1, visits: records });
      assert.deepEqual(cost(() => { assert.ok(executeSharedCommand(handle, [typed(handle, "t4")], { label: "typing", selection: null, typing: "t" }).record); }),
        { scans: 3, visits: 3 * records + 5 });
    } finally { destroySharedDocument(handle); }
  });
}
