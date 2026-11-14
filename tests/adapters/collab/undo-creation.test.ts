import test from "node:test";
import assert from "node:assert/strict";
import { replicas, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { applySharedUpdate, encodeSharedState, destroySharedDocument, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createRecord, setRecord } from "./record-support.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { isSharedCreationRetired } from "../../../src/adapters/collab/creation-retirement.ts";
import { sharedStructureKey } from "../../../src/core/collab/structure-key.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const;
const SOURCE = { rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "d" }] };

function start(order: typeof ORDERS[number], source: Record<string, unknown> = SOURCE) {
  const h = replicas(2, source), handles = [h.a, h.b];
  for (const handle of handles) registerSharedOperationFamilies(handle, { cells: runtime.cells });
  const incremental = handles.map(handle => captureIncrementalReplica(handle));
  let serial = 0;
  const owner = createSharedUndo({ now: () => serial * 2000, supports: supportsSharedUndoPart,
    reverse: record => reverseSharedUndoRecord(h.a, record, { by: "Alice", nextId: () => "undo" + ++serial }) });
  const flush = () => { h.queue.flush(order); handles.forEach((handle, i) => { const current = incremental[i]; assert.ok(current); assertIncremental(handle, current.projector); }); };
  const check = (expected: ReturnType<typeof projectSharedDocumentWithRecovery>, confirm?: (handle: SharedDocumentHandle) => void) => {
    flush(); const late = createMonitoredSharedDocument();
    try {
      assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
      for (const handle of [...handles, late]) { assert.deepEqual(projectSharedDocumentWithRecovery(handle), expected); confirm?.(handle); }
    } finally { destroySharedDocument(late); }
  };
  const command = (values: readonly unknown[], label = "create") => {
    let record: SharedUndoRecord | null = null;
    owner.perform(() => {
      const result = executeSharedCommand(h.a, values.map(operation), { label, selection: null, typing: null }, { base: readSharedRevision(h.a) });
      assert.deepEqual(result.result, { ok: true }); record = result.record; return result.record;
    });
    assert.ok(record); return record as SharedUndoRecord;
  };
  const send = (values: readonly unknown[], handle = h.b) => assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
  const create = (audioText = "", fields: Record<string, unknown> = {}) => {
    const record = command([{ kind: "segment-create", id: "add", by: "Alice", beat: "N1", segment: "N1",
      at: { left: source.rows && (source.rows as unknown[]).length ? "R1" : null, right: null, affinity: "after" }, fields: { audioText, status: "todo", ...fields } }]);
    assert.equal(record.parts.length, 1); const part = record.parts[0]; assert.ok(part?.kind === "beat-create"); flush(); return part.beat;
  };
  return { ...h, owner, flush, check, command, send, create, close: () => { incremental.forEach(value => value.projector.dispose()); h.close(); } };
}

function typed(beat: string, value = "X", offset = 0) {
  return { kind: "text-insert", id: "type", by: "Bob", target: { owner: beat, segment: beat, field: "audioText" },
    at: { left: offset ? flowBaseReference(beat, "audioText", offset - 1) : null, right: offset ? null : flowBaseReference(beat, "audioText", 0), affinity: offset ? "after" : "before" },
    content: [{ value, marks: [] }] };
}

for (const order of ORDERS) for (const audio of ["", "x", "<strong>A😀</strong>"]) test(`creation undo and redo keep the same identity and whole document: ${audio}/${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), beat = h.create(audio), after = projectSharedDocumentWithRecovery(h.a);
    assert.equal(h.owner.undo().ok, true); h.check(before);
    assert.deepEqual(h.owner.sizes(), { undo: 0, redo: 1, dropped: 0 });
    assert.equal(h.owner.redo().ok, true); h.check(after);
    assert.ok(projectSharedDocumentWithRecovery(h.a).document.rows.some(row => row.id === beat));
    assert.equal(h.owner.undo().ok, true); h.check(before);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`first text in an empty script returns to that empty document on undo: ${order}`, () => {
  const h = start(order, { rows: [] });
  try {
    const before = projectSharedDocumentWithRecovery(h.a); h.create("x"); const after = projectSharedDocumentWithRecovery(h.a);
    assert.equal(h.owner.undo().ok, true); h.check(before);
    assert.equal(h.owner.redo().ok, true); h.check(after);
  } finally { h.close(); }
});

const changes = [
  { name: "typing", make: (beat: string) => typed(beat) },
  { name: "value", make: (beat: string) => ({ kind: "scalar", id: "value", by: "Bob", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 4 }) },
  { name: "status", make: (beat: string) => ({ kind: "status", id: "status", by: "Bob", target: { scope: "beat", record: beat }, value: "ready", parents: [] }) },
  { name: "removal", make: (beat: string) => ({ kind: "remove", id: "remove", by: "Bob", removalKind: "beat", targets: [beat], boundaries: [beat], observed: [], components: [], gallery: [], at: 1 }) },
  { name: "split", make: (beat: string) => ({ kind: "split", id: "split", by: "Bob", target: { owner: beat, segment: beat, field: "audioText" },
    at: { left: null, right: flowBaseReference(beat, "audioText", 0), affinity: "before" }, observed: [], boundary: "N2", beat: "N2", fields: {} }) },
  { name: "join", make: (beat: string) => ({ kind: "join", id: "join", by: "Bob", from: beat, into: "R1", glue: " " }) },
  { name: "join into the created beat", make: (beat: string) => ({ kind: "join", id: "join-in", by: "Bob", from: "R2", into: beat, glue: " " }) },
  { name: "picture", make: (beat: string) => createRecord("gallery", "G1", { beat, rank: "1", picture: { imageRef: { sha256: "a".repeat(64) } }, links: [] }, "Bob") },
  { name: "comment", make: (beat: string) => createRecord("comments", "C1", { id: "C1", rowId: beat, field: "audioText", author: "Bob", createdAt: 0, text: "Keep this" }, "Bob") },
  { name: "visual", make: (beat: string) => ({ kind: "text-insert", id: "visual", by: "Bob", target: { owner: beat, segment: beat, field: "visualText" },
    at: { left: null, right: null, affinity: "after" }, content: [{ value: "Look", marks: [] }] }) }
];
for (const change of changes) for (const order of ORDERS) for (const seen of [true, false]) test(`creation undo versus ${change.name}, seen=${seen}: ${order}`, () => {
  const h = start(order);
  try {
    const beat = h.create("x"); h.send([change.make(beat)]);
    const other = projectSharedDocumentWithRecovery(h.b);
    if (seen) h.flush();
    const state = encodeSharedState(h.a), revision = readSharedRevision(h.a), outcome = h.owner.undo();
    if (seen) {
      assert.deepEqual(outcome, { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
      assert.equal(readSharedRevision(h.a), revision); assert.deepEqual(encodeSharedState(h.a), state);
      assert.deepEqual(h.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
    } else assert.deepEqual(outcome, { ok: true, effective: true, label: "create", selection: null });
    h.check(other);
    if (!seen) {
      assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
      h.check(other);
    }
  } finally { h.close(); }
});

for (const order of ORDERS) test(`later own typing must undo first; earlier text remains reachable across creation redo: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a);
    h.command([{ ...typed("R1", "A", 1), id: "older", by: "Alice" }], "older"); h.flush();
    const older = projectSharedDocumentWithRecovery(h.a), beat = h.create("x"), created = projectSharedDocumentWithRecovery(h.a);
    h.command([{ ...typed(beat, "y", 1), by: "Alice" }], "typing"); h.flush();
    assert.equal(h.owner.undo().ok, true); h.check(created);
    assert.equal(h.owner.undo().ok, true); h.check(older);
    assert.equal(h.owner.undo().ok, true); h.check(before);
    assert.equal(h.owner.redo().ok, true); h.check(older);
    assert.equal(h.owner.redo().ok, true); h.check(created);
    assert.equal(h.owner.redo().ok, true);
    assert.equal(projectSharedDocumentWithRecovery(h.a).document.rows.find(row => row.id === beat)?.audioText, "xy");
    assert.ok(collabState(h.a).roots.beats.has(beat));
  } finally { h.close(); }
});

for (const order of ORDERS) test(`creation owns its initial rich visual, picture and stamp; undo keeps stamps elsewhere: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a);
    h.create("<em>A😀</em>", { visualText: "<strong>Look</strong>", imageRef: { sha256: "b".repeat(64) }, updatedAt: "2026-11-14T00:00:00Z", updatedBy: "Alice" });
    const after = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
    assert.deepEqual(h.owner.redo(), { ok: true, effective: true, label: "create", selection: null }); h.check(after);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`used-up creation writes nothing and the next press reaches the older step: ${order}`, () => {
  const h = start(order);
  try {
    h.command([{ ...typed("R1", "A", 1), id: "older", by: "Alice" }], "older"); h.flush();
    const beat = h.create("x"); h.send([typed(beat)]); h.flush();
    assert.deepEqual(h.owner.undo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
    assert.deepEqual(h.owner.sizes(), { undo: 1, redo: 0, dropped: 0 });
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "older", selection: null }); h.flush();
    const after = projectSharedDocumentWithRecovery(h.a);
    assert.equal(after.document.rows.find(row => row.id === "R1")?.audioText, "abc");
    assert.equal(after.document.rows.find(row => row.id === beat)?.audioText, "Xx"); h.check(after);
  } finally { h.close(); }
});

for (const kind of ["split", "join", "removal"] as const) for (const audio of ["", "x"]) for (const order of ORDERS) test(`a structural change by the creator uses creation undo up even after its own undo: ${kind}/${audio}/${order}`, () => {
  const h = start(order);
  try {
    const beat = h.create(audio), change = changes.find(change => change.name === kind); assert.ok(change);
    h.command([{ ...change.make(beat) as Record<string, unknown>, by: "Alice" }], kind); h.flush();
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: kind, selection: null }); h.flush();
    const before = projectSharedDocumentWithRecovery(h.a), encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
    assert.deepEqual(encodeSharedState(h.a), encoded); h.check(before);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`a beat made by a split has one split part and no independent creation part: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a);
    const record = h.command([{ kind: "split", id: "split", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
      at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, observed: [], boundary: "N1", beat: "N1", fields: {} }], "split");
    assert.deepEqual(record.parts.map(part => part.kind), ["beat-split"]); h.flush();
    const after = projectSharedDocumentWithRecovery(h.a);
    assert.equal(h.owner.undo().ok, true); h.check(before);
    assert.equal(h.owner.redo().ok, true); h.check(after);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`own replacement undo restores original character and mark identities before creation undo: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), beat = h.create("<strong>x</strong>"), created = projectSharedDocumentWithRecovery(h.a);
    const target = { owner: beat, segment: beat, field: "audioText" } as const;
    const observed = captureSharedTextRange(h.a, target, 0, 1); assert.ok(observed);
    h.command([{ ...typed(beat, "y"), by: "Alice" }, { kind: "text-delete", id: "delete", by: "Alice", target, observed: [observed] }], "replace"); h.flush();
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "replace", selection: null }); h.check(created);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
    assert.equal(h.owner.redo().ok, true); h.check(created);
    assert.equal(h.owner.redo().ok, true); h.flush();
    assert.equal(projectSharedDocumentWithRecovery(h.a).document.rows.find(row => row.id === beat)?.audioText, "y");
  } finally { h.close(); }
});

for (const name of ["value", "status", "visual"] as const) for (const order of ORDERS) test(`own ${name} undone before creation undo leaves the creation eligible: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), beat = h.create("x"), change = changes.find(change => change.name === name); assert.ok(change);
    h.command([{ ...change.make(beat) as Record<string, unknown>, by: "Alice" }], name); h.flush();
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: name, selection: null }); h.flush();
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`a value changed and put back by another copy still belongs to that copy and uses creation undo up: ${order}`, () => {
  const h = start(order);
  try {
    const beat = h.create("x", { lengthSeconds: 4 });
    h.send([{ kind: "scalar", id: "changed", by: "Bob", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 8 },
      { kind: "scalar", id: "put-back", by: "Bob", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 4 }]); h.flush();
    const encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
    assert.deepEqual(encodeSharedState(h.a), encoded); h.check(projectSharedDocumentWithRecovery(h.a));
  } finally { h.close(); }
});

for (const order of ORDERS) test(`a same-value no-op writes nothing and does not use creation undo up: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), beat = h.create("x", { lengthSeconds: 4 }), encoded = encodeSharedState(h.a);
    h.send([{ kind: "scalar", id: "same", by: "Bob", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 4 }]); h.flush();
    assert.deepEqual(encodeSharedState(h.a), encoded);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`a stamp alone leaves creation undo and same-id redo available: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), beat = h.create("x");
    h.send([{ kind: "scalar", id: "stamp", by: "Bob", target: { scope: "beat", record: beat }, field: "stamp", value: { at: "2026-11-14T01:00:00Z", by: "Bob" } }]); h.flush();
    const after = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
    assert.deepEqual(h.owner.redo(), { ok: true, effective: true, label: "create", selection: null }); h.check(after);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`another copy replacing text with the same letters still supplies new characters: ${order}`, () => {
  const h = start(order);
  try {
    const beat = h.create("x"), before = projectSharedDocumentWithRecovery(h.a), target = { owner: beat, segment: beat, field: "audioText" } as const;
    const observed = captureSharedTextRange(h.b, target, 0, 1); assert.ok(observed);
    h.send([typed(beat, "x"), { kind: "text-delete", id: "replace", by: "Bob", target, observed: [observed] }]); h.check(before);
    const encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
    assert.deepEqual(encodeSharedState(h.a), encoded); h.check(before);
  } finally { h.close(); }
});

function withRecords(h: ReturnType<typeof start>) {
  const beat = sharedStructureKey("1", "add", "beat");
  assert.ok(beat);
  const record = h.command([{ kind: "segment-create", id: "add", by: "Alice", beat: "N1", segment: "N1",
    at: { left: "R1", right: "R2", affinity: "before" }, fields: { audioText: "x", status: "todo" } },
  createRecord("gallery", "G1", { beat, rank: "1", picture: { imageRef: { sha256: "c".repeat(64) } }, links: [] }),
  createRecord("comments", "C1", { id: "C1", rowId: beat, field: "audioText", author: "Alice", createdAt: 0, text: "Note" }),
  createRecord("replies", '["C1","A1"]', { id: "A1", commentId: "C1", author: "Alice", createdAt: 1, text: "Reply" })]); h.flush();
  assert.deepEqual(record.parts.map(part => part.kind), ["beat-create"]); return beat;
}

for (const order of ORDERS) test(`a creation and explicit initial picture and comment parts undo and redo as one edit: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a);
    const collections = ["gallery", "comments", "replies"] as const;
    const records = collections.map(collection => readSharedRecords(h.a, collection));
    const beat = withRecords(h);
    const after = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
    for (const [index, collection] of collections.entries()) assert.deepEqual(readSharedRecords(h.a, collection), records[index]);
    assert.deepEqual(h.owner.redo(), { ok: true, effective: true, label: "create", selection: null }); h.check(after);
    assert.equal(readSharedRecords(h.a, "comments")[0]?.fields.rowId, beat);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
  } finally { h.close(); }
});

test("a retired creation guard enumerates no document collection after its indexes are ready", t => {
  const h = start("D1");
  try {
    const beat = h.create("x"); assert.equal(h.owner.undo().ok, true); h.flush();
    assert.equal(isSharedCreationRetired(h.a, beat), true);
    for (const collection of ["beats", "headings", "visuals", "gallery", "comments", "replies", "statusEvents"] as const) {
      const root = collabState(h.a).roots[collection];
      t.mock.method(root, "keys", () => { assert.fail("Enumerated " + collection); });
      t.mock.method(root, "entries", () => { assert.fail("Enumerated " + collection); });
    }
    assert.equal(isSharedCreationRetired(h.a, beat), true);
    h.send([typed("R2", "Y")], h.a);
    assert.equal(isSharedCreationRetired(h.a, beat), true);
    t.mock.restoreAll(); h.flush();
    const after = projectSharedDocumentWithRecovery(h.a);
    assert.equal(after.document.rows.find(row => row.id === "R2")?.audioText, "Yd"); h.check(after);
  } finally { t.mock.restoreAll(); h.close(); }
});

for (const order of ORDERS) test(`two successive adds each undo and redo without consuming the other creation: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), first = h.create("x"), one = projectSharedDocumentWithRecovery(h.a);
    h.command([{ kind: "segment-create", id: "second", by: "Alice", beat: "N2", segment: "N2", at: { left: first, right: "R2", affinity: "before" }, fields: { audioText: "y", status: "todo" } }]); h.flush();
    const two = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(one);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
    assert.equal(h.owner.redo().ok, true); h.check(one);
    assert.equal(h.owner.redo().ok, true); h.check(two);
  } finally { h.close(); }
});

for (const order of ORDERS) for (const seen of [true, false]) test(`a neighbouring creation is independent work and remains after creation undo, seen=${seen}: ${order}`, () => {
  const h = start(order);
  try {
    const first = h.create("x");
    h.send([{ kind: "segment-create", id: "neighbour", by: "Bob", beat: "N2", segment: "N2", at: { left: first, right: "R2", affinity: "before" }, fields: { audioText: "y", status: "todo" } }]);
    const other = projectSharedDocumentWithRecovery(h.b), expected = { ...other, document: { ...other.document, rows: other.document.rows.filter(row => row.id !== first) } };
    if (seen) h.flush();
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(expected);
    assert.equal(expected.document.rows.some(row => row.audioText === "y"), true);
  } finally { h.close(); }
});

for (const empty of [false, true]) for (const order of ORDERS) for (const seen of [true, false]) test(`a heading added above the created beat uses creation undo up, empty=${empty}, seen=${seen}: ${order}`, () => {
  const h = start(order, empty ? { rows: [] } : SOURCE);
  try {
    const beat = h.create("x");
    h.send([{ kind: "heading-create", id: "heading", by: "Bob", segment: "H1", heading: "H1", firstBeat: beat, at: { left: null, right: beat, affinity: "before" } },
      { kind: "text-insert", id: "name", by: "Bob", target: { owner: "H1", segment: "H1", field: "heading" }, at: { left: null, right: null, affinity: "after" }, content: [{ value: "Keep", marks: [] }] }]);
    const other = projectSharedDocumentWithRecovery(h.b); if (seen) h.flush();
    const encoded = encodeSharedState(h.a), outcome = h.owner.undo();
    assert.deepEqual(outcome, seen ? { ok: true, effective: false, label: "create", selection: null, reason: "used-up" } : { ok: true, effective: true, label: "create", selection: null });
    if (seen) assert.deepEqual(encodeSharedState(h.a), encoded);
    h.check(other);
    if (!seen) assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
  } finally { h.close(); }
});

for (const order of ORDERS) test(`own unformat undo leaves the original creation eligible: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), beat = h.create("<strong>x</strong>"), target = { owner: beat, segment: beat, field: "audioText" } as const;
    const observed = captureSharedTextRange(h.a, target, 0, 1); assert.ok(observed);
    h.command([{ kind: "mark", id: "unbold", by: "Alice", target, observed: [observed], mark: { kind: "b", value: null } }], "unformat"); h.flush();
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "unformat", selection: null }); h.flush();
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`a foreign identical format stays protected through the creator's replacement undo: ${order}`, () => {
  const h = start(order);
  try {
    const beat = h.create("<strong>x</strong>"), target = { owner: beat, segment: beat, field: "audioText" } as const;
    const foreign = captureSharedTextRange(h.b, target, 0, 1); assert.ok(foreign);
    h.send([{ kind: "mark", id: "foreign-bold", by: "Bob", target, observed: [foreign], mark: { kind: "b", value: true } }]); h.flush();
    const observed = captureSharedTextRange(h.a, target, 0, 1); assert.ok(observed);
    h.command([{ ...typed(beat, "y"), by: "Alice" }, { kind: "text-delete", id: "delete", by: "Alice", target, observed: [observed] }], "replace"); h.flush();
    assert.equal(h.owner.undo().ok, true); h.flush();
    const before = projectSharedDocumentWithRecovery(h.a), encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
    assert.deepEqual(encodeSharedState(h.a), encoded); h.check(before);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`unjoining an initially joined creation uses the whole compound undo up without a partial write: ${order}`, () => {
  const h = start(order);
  try {
    const record = h.command([{ kind: "segment-create", id: "add", by: "Alice", beat: "N1", segment: "N1",
      at: { left: "R1", right: "R2", affinity: "before" }, fields: { audioText: "x", status: "todo" } },
    { kind: "join", id: "join", by: "Alice", from: "N1", into: "R1", glue: " " }]); h.flush();
    assert.deepEqual(record.parts.map(part => part.kind), ["beat-create"]);
    h.send([{ kind: "join-retire", id: "unjoin", by: "Bob", joins: [sharedStructureKey("1", "join", "join")] }]); h.flush();
    const before = projectSharedDocumentWithRecovery(h.a), encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
    assert.deepEqual(encodeSharedState(h.a), encoded); assert.equal(h.owner.sizes().redo, 0); h.check(before);
  } finally { h.close(); }
});

for (const order of ORDERS) for (const incoming of [false, true]) test(`an initial join follows creation retirement and restoration, incoming=${incoming}: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a);
    const record = h.command([{ kind: "segment-create", id: "add", by: "Alice", beat: "N1", segment: "N1",
      at: { left: "R1", right: "R2", affinity: "before" }, fields: { audioText: "x", status: "todo" } },
    { kind: "join", id: "join", by: "Alice", from: incoming ? "R2" : "N1", into: incoming ? "N1" : "R1", glue: " " }]); h.flush();
    assert.deepEqual(record.parts.map(part => part.kind), ["beat-create"]);
    const after = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
    assert.deepEqual(h.owner.redo(), { ok: true, effective: true, label: "create", selection: null }); h.check(after);
  } finally { h.close(); }
});

for (const change of ["typing", "picture", "comment", "reply"] as const) for (const order of ORDERS) for (const seen of [true, false]) test(`initial child records stay with a creation that another copy changed: ${change}, seen=${seen}/${order}`, () => {
  const h = start(order);
  try {
    const beat = withRecords(h);
    const operation = change === "typing" ? typed(beat) : change === "picture" ? setRecord("gallery", "G1", "picture", { imageRef: { sha256: "c".repeat(64) }, name: "Keep" }, "Bob")
      : change === "comment" ? setRecord("comments", "C1", "assignee", "Bob", "Bob") : createRecord("replies", '["C1","B1"]', { id: "B1", commentId: "C1", author: "Bob", createdAt: 2, text: "Keep" }, "Bob");
    h.send([operation]); const other = projectSharedDocumentWithRecovery(h.b); if (seen) h.flush();
    const encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), seen ? { ok: true, effective: false, label: "create", selection: null, reason: "used-up" } : { ok: true, effective: true, label: "create", selection: null });
    if (seen) assert.deepEqual(encodeSharedState(h.a), encoded);
    h.check(other);
    for (const collection of ["gallery", "comments", "replies"] as const) assert.equal(readSharedRecords(h.a, collection).length > 0, true);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`own comment text undo leaves its updated time and the creation remains undoable: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a); withRecords(h);
    h.command([setRecord("comments", "C1", "text", "Changed"), setRecord("comments", "C1", "updatedAt", 4)], "comment"); h.flush();
    assert.equal(h.owner.undo().ok, true); h.flush();
    assert.equal(readSharedRecords(h.a, "comments")[0]?.fields.updatedAt, 4);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "create", selection: null }); h.check(before);
  } finally { h.close(); }
});

for (const collection of ["gallery", "comments"] as const) for (const order of ORDERS) for (const seen of [true, false]) for (const incoming of [true, false]) test(`retargeting a child uses creation undo up: ${collection}, incoming=${incoming}, seen=${seen}/${order}`, () => {
  const h = start(order);
  try {
    if (incoming) {
      h.send([collection === "gallery" ? createRecord("gallery", "G1", { beat: "R2", rank: "1", picture: { imageRef: { sha256: "c".repeat(64) } }, links: [] }, "Bob")
        : createRecord("comments", "C1", { id: "C1", rowId: "R2", field: "audioText", author: "Bob", createdAt: 0, text: "Keep" }, "Bob")]); h.flush();
    }
    const beat = incoming ? h.create("x") : withRecords(h);
    h.send([setRecord(collection, collection === "gallery" ? "G1" : "C1", collection === "gallery" ? "beat" : "rowId", incoming ? beat : "R2", "Bob")]);
    const other = projectSharedDocumentWithRecovery(h.b); if (seen) h.flush();
    const encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), seen ? { ok: true, effective: false, label: "create", selection: null, reason: "used-up" } : { ok: true, effective: true, label: "create", selection: null });
    if (seen) assert.deepEqual(encodeSharedState(h.a), encoded);
    h.check(other);
    if (!seen) assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
  } finally { h.close(); }
});

for (const change of ["typing", "value", "comment", "reply"] as const) for (const order of ORDERS) for (const seen of [true, false]) test(`another copy with the creator's display name uses creation undo up: ${change}, seen=${seen}/${order}`, () => {
  const h = start(order);
  try {
    const beat = change === "comment" || change === "reply" ? withRecords(h) : h.create("x", { lengthSeconds: 4 });
    h.send(change === "typing" ? [{ ...typed(beat), by: "Alice" }] : change === "comment" ? [setRecord("comments", "C1", "text", "Peer work", "Alice")]
      : change === "reply" ? [setRecord("replies", '["C1","A1"]', "text", "Peer work", "Alice")]
      : [{ kind: "scalar", id: "away", by: "Alice", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 8 },
        { kind: "scalar", id: "back", by: "Alice", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 4 }]);
    const other = projectSharedDocumentWithRecovery(h.b); if (seen) h.flush();
    const encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), seen ? { ok: true, effective: false, label: "create", selection: null, reason: "used-up" } : { ok: true, effective: true, label: "create", selection: null });
    if (seen) assert.deepEqual(encodeSharedState(h.a), encoded);
    h.check(other, handle => {
      if (change === "comment" || change === "reply") {
        const collection = change === "comment" ? "comments" : "replies", key = change === "comment" ? "C1" : '["C1","A1"]';
        assert.equal(readSharedRecords(handle, collection).find(record => record.key === key)?.fields.text, "Peer work");
      }
    });
    if (!seen) assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
  } finally { h.close(); }
});

for (const change of ["separator format", "separator value", "separator format taken back", "separator value taken back", "joined typing"] as const) for (const order of ORDERS) for (const seen of [true, false]) test(`initial join protects ${change}, seen=${seen}/${order}`, () => {
  const h = start(order);
  try {
    const record = h.command([{ kind: "segment-create", id: "add", by: "Alice", beat: "N1", segment: "N1",
      at: { left: "R1", right: "R2", affinity: "before" }, fields: { audioText: "x", status: "todo" } },
    { kind: "join", id: "join", by: "Alice", from: "R2", into: "N1", glue: " " }]); h.flush();
    const part = record.parts[0]; assert.ok(part?.kind === "beat-create"); const beat = part.beat;
    const target = { owner: beat, segment: beat, field: "audioText" };
    h.send(change === "separator format" ? [{ kind: "mark", id: "bold", by: "Bob", target,
      observed: [flowBaseReference(beat, "audioText", 1, 2)], mark: { kind: "b", value: true } }]
      : change === "separator value" ? [{ kind: "join-glue", id: "glue", by: "Bob", joins: [sharedStructureKey("1", "join", "join")], glue: "" }]
      : change === "joined typing" ? [{ kind: "text-insert", id: "joined-type", by: "Bob", target,
        at: { left: null, right: flowBaseReference(beat, "audioText", 2), affinity: "before" }, content: [{ value: "Y", marks: [] }] }] : []);
    if (change === "separator format taken back") {
      h.send([{ kind: "mark", id: "bold-away", by: "Bob", target, observed: [flowBaseReference(beat, "audioText", 1, 2)], mark: { kind: "b", value: true } }]);
      h.send([{ kind: "mark", id: "bold-back", by: "Bob", target, observed: [flowBaseReference(beat, "audioText", 1, 2)], mark: { kind: "b", value: null } }]);
    }
    if (change === "separator value taken back") {
      h.send([{ kind: "join-glue", id: "glue-away", by: "Bob", joins: [sharedStructureKey("1", "join", "join")], glue: "" }]);
      h.send([{ kind: "join-glue", id: "glue-back", by: "Bob", joins: [sharedStructureKey("1", "join", "join")], glue: " " }]);
    }
    const other = projectSharedDocumentWithRecovery(h.b);
    assert.equal(other.document.rows.find(row => row.id === beat)?.audioText,
      change === "separator format" ? "x<strong> </strong>d" : change === "separator value" ? "xd" : change === "joined typing" ? "x Yd" : "x d");
    if (seen) h.flush(); const encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), seen ? { ok: true, effective: false, label: "create", selection: null, reason: "used-up" }
      : { ok: true, effective: true, label: "create", selection: null });
    if (seen) { assert.deepEqual(encodeSharedState(h.a), encoded); assert.equal(h.owner.sizes().redo, 0); }
    h.check(other);
    if (!seen) { assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" }); h.check(other); }
  } finally { h.close(); }
});

for (const order of ORDERS) for (const seen of [true, false]) test(`another copy's real deletion undo preserves its restored characters, seen=${seen}/${order}`, () => {
  const h = start(order);
  try {
    const beat = h.create("x"), before = projectSharedDocumentWithRecovery(h.a), target = { owner: beat, segment: beat, field: "audioText" } as const;
    const observed = captureSharedTextRange(h.b, target, 0, 1); assert.ok(observed);
    const deletion = executeSharedCommand(h.b, [operation({ kind: "text-delete", id: "delete", by: "Bob", target, observed: [observed] })],
      { label: "delete", selection: null, typing: null }, { base: readSharedRevision(h.b) });
    assert.deepEqual(deletion.result, { ok: true }); assert.ok(deletion.record); let serial = 0;
    assert.deepEqual(reverseSharedUndoRecord(h.b, deletion.record, { by: "Bob", nextId: () => "restore-" + ++serial }).ok, true);
    assert.deepEqual(projectSharedDocumentWithRecovery(h.b), before);
    if (seen) h.flush(); const encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.undo(), seen ? { ok: true, effective: false, label: "create", selection: null, reason: "used-up" }
      : { ok: true, effective: true, label: "create", selection: null });
    if (seen) { assert.deepEqual(encodeSharedState(h.a), encoded); assert.equal(h.owner.sizes().redo, 0); }
    h.check(before);
    if (!seen) { assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" }); h.check(before); }
  } finally { h.close(); }
});

for (const kind of ["text", "value", "picture"] as const) for (const order of ORDERS) for (const seen of [true, false]) test(`taken-back ${kind} race keeps its ownership policy, seen=${seen}/${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), beat = kind === "picture" ? withRecords(h) : h.create("x", { lengthSeconds: 4 });
    const made = projectSharedDocumentWithRecovery(h.a);
    const values = kind === "text" ? [typed(beat, "Y")] : kind === "value"
      ? [{ kind: "scalar", id: "away", by: "Bob", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 8 }]
      : [setRecord("gallery", "G1", "picture", { imageRef: { sha256: "d".repeat(64) } }, "Bob")];
    const result = executeSharedCommand(h.b, values.map(operation), { label: kind, selection: null, typing: null }, { base: readSharedRevision(h.b) });
    assert.deepEqual(result.result, { ok: true }); assert.ok(result.record); let serial = 0;
    assert.equal(reverseSharedUndoRecord(h.b, result.record, { by: "Bob", nextId: () => "take-back-" + ++serial }).ok, true);
    assert.deepEqual(projectSharedDocumentWithRecovery(h.b), made);
    if (seen) h.flush(); const encoded = encodeSharedState(h.a);
    const used = kind !== "text" && seen;
    assert.deepEqual(h.owner.undo(), used ? { ok: true, effective: false, label: "create", selection: null, reason: "used-up" }
      : { ok: true, effective: true, label: "create", selection: null });
    if (used) assert.deepEqual(encodeSharedState(h.a), encoded);
    h.check(kind === "text" ? before : made);
    if (kind === "text") { assert.equal(h.owner.redo().ok, true); h.check(made); }
    else if (!seen) { assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" }); h.check(made); }
  } finally { h.close(); }
});

for (const order of ORDERS) test(`continued typing after an invalidated retirement stays visible: ${order}`, () => {
  const h = start(order);
  try {
    const beat = h.create("x"); h.send([typed(beat, "Y")]);
    assert.equal(h.owner.undo().ok, true); h.flush();
    assert.equal(projectSharedDocumentWithRecovery(h.a).document.rows.find(row => row.id === beat)?.audioText, "Yx");
    h.send([{ ...typed(beat, "Z"), id: "continued" }]); h.flush();
    const after = projectSharedDocumentWithRecovery(h.b);
    assert.equal(after.document.rows.find(row => row.id === beat)?.audioText, "ZYx"); h.check(after);
    const encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
    assert.deepEqual(encodeSharedState(h.a), encoded); h.check(after);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`another copy restores text before the pending creation redo: ${order}`, () => {
  const h = start(order);
  try {
    const beat = h.create("x"), made = projectSharedDocumentWithRecovery(h.a), target = { owner: beat, segment: beat, field: "audioText" } as const;
    const observed = captureSharedTextRange(h.b, target, 0, 1); assert.ok(observed);
    const deletion = executeSharedCommand(h.b, [operation({ kind: "text-delete", id: "delete", by: "Bob", target, observed: [observed] })],
      { label: "delete", selection: null, typing: null }, { base: readSharedRevision(h.b) });
    assert.deepEqual(deletion.result, { ok: true }); assert.ok(deletion.record);
    assert.equal(h.owner.undo().ok, true); let serial = 0;
    assert.equal(reverseSharedUndoRecord(h.b, deletion.record, { by: "Bob", nextId: () => "restore-" + ++serial }).ok, true);
    h.check(made); const encoded = encodeSharedState(h.a);
    assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
    assert.deepEqual(encodeSharedState(h.a), encoded); h.check(made);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`inside-segment creation and later typing undo and redo in order: ${order}`, () => {
  const h = start(order);
  try {
    h.send([{ kind: "split", id: "inside", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
      at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, observed: [], boundary: "tail", beat: "tail", fields: {} }], h.a); h.flush();
    const before = projectSharedDocumentWithRecovery(h.a), tail = sharedStructureKey("1", "inside", "beat"); assert.ok(tail);
    const record = h.command([{ kind: "segment-create", id: "add", by: "Alice", beat: "N1", segment: "N1",
      at: { left: "R1", right: tail, affinity: "after" }, fields: { audioText: "x" } }]); h.flush();
    const part = record.parts[0]; assert.ok(part?.kind === "beat-create"); const beat = part.beat, made = projectSharedDocumentWithRecovery(h.a);
    assert.equal((collabState(h.a).roots.beats.get(beat) as { readonly get: (key: string) => unknown }).get("segment"), "b:R1");
    h.command([{ ...typed(beat, "y", 1), by: "Alice" }], "typing"); h.flush(); const after = projectSharedDocumentWithRecovery(h.a);
    assert.equal(h.owner.undo().ok, true); h.check(made); assert.equal(h.owner.undo().ok, true); h.check(before);
    assert.equal(h.owner.redo().ok, true); h.check(made); assert.equal(h.owner.redo().ok, true); h.check(after);
    assert.equal(h.owner.undo().ok, true); h.check(made); assert.equal(h.owner.undo().ok, true); h.check(before);
  } finally { h.close(); }
});
for (const length of [1, 1000]) test(`creation retirement encoded storage growth: ${length} characters`, t => {
  const h = start("D1");
  try {
    h.create("x".repeat(length)); const before = encodeSharedState(h.a).length;
    assert.equal(h.owner.undo().ok, true); const growth = encodeSharedState(h.a).length - before;
    t.diagnostic(JSON.stringify({ length, growth })); assert.equal(growth, length === 1 ? 638 : 17673);
  } finally { h.close(); }
});
