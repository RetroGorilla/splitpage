import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { readSharedRevision, transactSharedDocument, applySharedUpdate, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { collabState, guardSharedCallback } from "../../../src/adapters/collab/state.ts";
import { sharedCreationRecordKeys } from "../../../src/adapters/collab/creation-record-index.ts";
import { isSharedCreationRetired, sharedCreationObservationCost } from "../../../src/adapters/collab/creation-retirement.ts";
import { SHARED_CREATION_RETIREMENT_FIELD } from "../../../src/adapters/collab/creation-marker.ts";
import { measureSharedReads } from "../../../src/adapters/collab/read-counts.ts";
import { measureLibraryReads } from "../../collab/library-read-counts.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { sharedStructureKey } from "../../../src/core/collab/structure-key.ts";
import { createRecord, setRecord } from "./record-support.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";

function fixture(unrelated: number) {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "def" },
    ...Array.from({ length: unrelated }, (_, index) => ({ id: "U" + index, audioText: "unrelated" }))] });
  registerSharedOperationFamilies(h.a, { cells: createFlowLoadRuntime().cells });
  const send = (values: readonly unknown[]) => assert.deepEqual(executeSharedOperations(h.a, values.map(operation), { base: readSharedRevision(h.a) }), { ok: true });
  const tails = new Map<string, string>();
  for (const owner of ["R1", "R2"]) {
    const id = "split-" + owner, beat = sharedStructureKey("1", id, "beat"); assert.ok(beat); tails.set(owner, beat);
    send([{ kind: "split", id, by: "Alice", target: { owner, segment: owner, field: "audioText" },
      at: { left: null, right: flowBaseReference(owner, "audioText", 1), affinity: "before" }, observed: [], boundary: id, beat: id, fields: {} }]);
  }
  return { ...h, send, tails };
}

const placements = [[], ["R1"], ["R2"], ["R1", "R1"], ["R2", "R2"], ["R1", "R2"]] as const;
const costs = {
  none: { native: [7, 5, 46, 0, 0], unrelated: [0, 0, 0, 0, 0], rules: [2, 10, 2, 4, 2, 0], textUnits: 35, observations: 0 },
  R1: { native: [10, 8, 74, 0, 0], unrelated: [1, 0, 28, 0, 0], rules: [2, 14, 2, 8, 4, 0], textUnits: 61, observations: 1 },
  R2: { native: [10, 6, 74, 0, 0], unrelated: [3, 1, 28, 0, 0], rules: [2, 10, 2, 4, 2, 0], textUnits: 47, observations: 1 },
  "R1,R1": { native: [13, 13, 102, 0, 0], unrelated: [2, 0, 56, 0, 0], rules: [2, 18, 2, 12, 6, 0], textUnits: 95, observations: 2 },
  "R2,R2": { native: [13, 9, 102, 0, 0], unrelated: [6, 4, 56, 0, 0], rules: [2, 10, 2, 4, 2, 0], textUnits: 67, observations: 2 },
  "R1,R2": { native: [13, 9, 102, 0, 0], unrelated: [4, 1, 56, 0, 0], rules: [2, 14, 2, 8, 4, 0], textUnits: 73, observations: 2 }
};
for (const unrelated of [0, 100]) for (const hosts of placements) test(`creation retirement typing cost: ${hosts.join(",") || "none"}, unrelated=${unrelated}`, t => {
  const h = fixture(unrelated), records: SharedUndoRecord[] = [], previous = new Map<string, string>(); let serial = 0;
  try {
    for (const [index, host] of hosts.entries()) {
      const id = "create-" + index, result = executeSharedCommand(h.a, [operation({ kind: "segment-create", id, by: "Alice", beat: id, segment: id,
        at: { left: previous.get(host) ?? host, right: h.tails.get(host), affinity: "after" }, fields: { audioText: "x", status: "todo" } })],
      { label: "create", selection: null, typing: null }, { base: readSharedRevision(h.a) });
      assert.deepEqual(result.result, { ok: true }); assert.ok(result.record); records.push(result.record);
      const part = result.record.parts[0]; assert.ok(part?.kind === "beat-create"); previous.set(host, part.beat);
      const raw = collabState(h.a).roots.beats.get(part.beat); assert.ok(raw instanceof Y.Map); assert.equal(raw.get("segment"), "b:" + host);
    }
    assert.equal(applySharedUpdate(h.c, encodeSharedState(h.a)).ok, true);
    registerSharedOperationFamilies(h.c, { cells: createFlowLoadRuntime().cells });
    for (const record of records) {
      const part = record.parts[0]; assert.ok(part?.kind === "beat-create");
      assert.deepEqual(executeSharedOperations(h.c, [operation({ kind: "scalar", id: "invalidate-" + part.beat, by: "Bob",
        target: { scope: "beat", record: part.beat }, field: "lengthSeconds", value: 9 })], { base: readSharedRevision(h.c) }), { ok: true });
    }
    const invalidated = encodeSharedState(h.c);
    for (const record of records.reverse()) {
      const result = reverseSharedUndoRecord(h.a, record, { by: "Alice", nextId: () => "undo-" + ++serial });
      assert.equal(result.ok && result.effective, true);
    }
    const { projector, docs } = captureIncrementalReplica(h.a);
    try {
      assert.equal(projector.read().document.rows.some(row => row.audioText === "x"), false);
      const preparation = createSharedPreparation(h.a); preparation.view.text(["segments", "b:R1", "text"]); preparation.close();
      let textUnits = 0;
      const readDelta = Y.Text.prototype.toDelta;
      const mock = t.mock.method(Y.Text.prototype, "toDelta", function (this: Y.Text, ...args: Parameters<Y.Text["toDelta"]>) {
        const delta = Reflect.apply(readDelta, this, args) as { insert: unknown }[];
        for (const part of delta) textUnits += typeof part.insert === "string" ? part.insert.length : 1;
        return delta;
      });
      const getMap = Y.Map.prototype.get; let observations = 0;
      const maps = t.mock.method(Y.Map.prototype, "get", function (this: Y.Map<unknown>, key: string): unknown {
        if (key === SHARED_CREATION_RETIREMENT_FIELD) observations++;
        const value: unknown = getMap.call(this, key); return value;
      });
      sharedCreationObservationCost.checks = 0; sharedCreationObservationCost.builds = 0;
      const measured = measureLibraryReads(h.a, "R1", () => measureSharedReads(() => executeSharedCommand(h.a, [
        operation({ kind: "text-insert", id: "key", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
          at: { left: null, right: flowBaseReference("R1", "audioText", 0), affinity: "before" }, content: [{ value: "z", marks: [] }] }),
        operation({ kind: "scalar", id: "stamp", by: "Alice", target: { scope: "beat", record: "R1" }, field: "stamp", value: { by: "Alice", at: "2026-11-14T00:00:00Z" } })
      ], { label: "typing", selection: null, typing: "z" }, { base: readSharedRevision(h.a) })), docs);
      const firstCost = { ...sharedCreationObservationCost };
      assert.deepEqual(firstCost, { checks: hosts.length, builds: hosts.length });
      t.diagnostic(JSON.stringify({ cost: firstCost, hosts, unrelated, measured: measured.totals, unrelatedReads: measured.unrelated, textUnits, observations }));
      mock.mock.restore();
      maps.mock.restore();
      assert.deepEqual(measured.result.result.result, { ok: true });
      assert.equal(projector.read().document.rows.find(row => row.id === "R1")?.audioText, "za");
      assertIncremental(h.a, projector);
      const native = measured.totals, unrelatedReads = measured.unrelated, rules = measured.result.counts;
      assert.deepEqual({ native: [native.texts, native.markEntries, native.records, native.statusEntries, native.orderEntries],
        unrelated: [unrelatedReads.texts, unrelatedReads.markEntries, unrelatedReads.records, unrelatedReads.statusEntries, unrelatedReads.orderEntries],
        rules: [rules.texts, rules.identities, rules.markRecords, rules.markAnchors, rules.markChecks, rules.statusEvents], textUnits, observations },
      costs[(hosts.join(",") || "none") as keyof typeof costs]);
      t.diagnostic(JSON.stringify({ hosts, unrelated, native: measured.totals, unrelatedReads: measured.unrelated, rules: measured.result.counts, textUnits, observations }));
      let nextObservations = 0;
      const nextMaps = t.mock.method(Y.Map.prototype, "get", function (this: Y.Map<unknown>, key: string): unknown {
        if (key === SHARED_CREATION_RETIREMENT_FIELD) nextObservations++;
        const value: unknown = getMap.call(this, key); return value;
      });
      sharedCreationObservationCost.checks = 0; sharedCreationObservationCost.builds = 0;
      const next = executeSharedCommand(h.a, [operation({ kind: "text-insert", id: "next-key", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
        at: { left: null, right: flowBaseReference("R1", "audioText", 0), affinity: "before" }, content: [{ value: "z", marks: [] }] }),
      operation({ kind: "scalar", id: "next-stamp", by: "Alice", target: { scope: "beat", record: "R1" }, field: "stamp", value: { by: "Alice", at: "2026-11-14T00:00:01Z" } })],
      { label: "typing", selection: null, typing: "z" }, { base: readSharedRevision(h.a) });
      nextMaps.mock.restore(); assert.deepEqual(next.result, { ok: true });
      assert.equal(nextObservations, 0);
      assert.deepEqual(sharedCreationObservationCost, { checks: 0, builds: 0 });
      assert.equal(projector.read().document.rows.find(row => row.id === "R1")?.audioText, "zza"); assertIncremental(h.a, projector);
      assert.equal(applySharedUpdate(h.a, invalidated).ok, true);
      for (const record of records) {
        const part = record.parts[0]; assert.ok(part?.kind === "beat-create");
        assert.equal(isSharedCreationRetired(h.a, part.beat), false);
      }
      sharedCreationObservationCost.checks = 0; sharedCreationObservationCost.builds = 0;
      const continued = executeSharedCommand(h.a, [operation({ kind: "text-insert", id: "after-invalidated", by: "Alice",
        target: { owner: "R1", segment: "R1", field: "audioText" },
        at: { left: null, right: flowBaseReference("R1", "audioText", 0), affinity: "before" }, content: [{ value: "z", marks: [] }] })],
      { label: "typing", selection: null, typing: "z" }, { base: readSharedRevision(h.a) });
      assert.deepEqual(continued.result, { ok: true });
      assert.deepEqual(sharedCreationObservationCost, { checks: 0, builds: 0 });
      assert.equal(projector.read().document.rows.filter(row => row.audioText === "x").length, hosts.length);
      assertIncremental(h.a, projector);
      for (const record of records) {
        const part = record.parts[0]; assert.ok(part?.kind === "beat-create");
        sharedCreationObservationCost.checks = 0; sharedCreationObservationCost.builds = 0;
        const typed = executeSharedCommand(h.a, [operation({ kind: "text-insert", id: "retired-key-" + part.beat, by: "Alice",
          target: { owner: part.beat, segment: part.beat, field: "audioText" },
          at: { left: null, right: flowBaseReference(part.beat, "audioText", 0), affinity: "before" }, content: [{ value: "y", marks: [] }] }),
        operation({ kind: "scalar", id: "retired-stamp-" + part.beat, by: "Alice", target: { scope: "beat", record: part.beat },
          field: "stamp", value: { by: "Alice", at: "2026-11-14T00:00:03Z" } })],
        { label: "typing", selection: null, typing: "y" }, { base: readSharedRevision(h.a) });
        assert.deepEqual(typed.result, { ok: true });
        assert.deepEqual(sharedCreationObservationCost, { checks: 0, builds: 0 });
        assert.equal(projector.read().document.rows.find(row => row.id === part.beat)?.audioText, "yx"); assertIncremental(h.a, projector);
        sharedCreationObservationCost.checks = 0; sharedCreationObservationCost.builds = 0;
        const formatted = executeSharedCommand(h.a, [operation({ kind: "text-insert", id: "retired-bold-key-" + part.beat, by: "Alice",
          target: { owner: part.beat, segment: part.beat, field: "audioText" },
          at: { left: null, right: flowBaseReference(part.beat, "audioText", 0), affinity: "before" }, content: [{ value: "z", marks: [{ kind: "b", value: true }] }] })],
        { label: "typing", selection: null, typing: "z" }, { base: readSharedRevision(h.a) });
        assert.deepEqual(formatted.result, { ok: true });
        assert.deepEqual(sharedCreationObservationCost, { checks: 0, builds: 0 });
        assert.equal(projector.read().document.rows.find(row => row.id === part.beat)?.audioText, "<strong>z</strong>yx"); assertIncremental(h.a, projector);
      }
    } finally { projector.dispose(); }
  } finally { h.close(); }
});

test("creation retirement follows changed dependencies and sees writes inside a transaction", t => {
  const h = fixture(0);
  try {
    const result = executeSharedCommand(h.a, [operation({ kind: "segment-create", id: "create", by: "Alice", beat: "N1", segment: "N1",
      at: { left: "R1", right: h.tails.get("R1"), affinity: "after" }, fields: { audioText: "x" } })], { label: "create", selection: null, typing: null }, { base: readSharedRevision(h.a) });
    assert.deepEqual(result.result, { ok: true }); assert.ok(result.record);
    const part = result.record.parts[0]; assert.ok(part?.kind === "beat-create");
    let serial = 0;
    assert.equal(reverseSharedUndoRecord(h.a, result.record, { by: "Alice", nextId: () => "undo-" + ++serial }).ok, true);
    const record = collabState(h.a).roots.beats.get(part.beat); assert.ok(record instanceof Y.Map);
    const get = record.get.bind(record); let reads = 0;
    t.mock.method(record, "get", (key: string): unknown => { if (key === SHARED_CREATION_RETIREMENT_FIELD) reads++; return get(key); });
    for (let index = 0; index < 100; index++) assert.equal(isSharedCreationRetired(h.a, part.beat), true);
    assert.equal(reads, 1);
    transactSharedDocument(h.a, "local-command", () => {
      record.set("lengthSeconds", 9); assert.equal(isSharedCreationRetired(h.a, part.beat), false);
      record.delete("lengthSeconds"); assert.equal(isSharedCreationRetired(h.a, part.beat), true);
    });
    assert.equal(reads, 3);
    for (let index = 0; index < 100; index++) assert.equal(isSharedCreationRetired(h.a, part.beat), true);
    assert.equal(reads, 4);
    guardSharedCallback(collabState(h.a), () => {
      assert.equal(isSharedCreationRetired(h.a, part.beat), true);
      assert.equal(isSharedCreationRetired(h.a, part.beat), true);
    });
    assert.equal(reads, 4);
    assert.equal(isSharedCreationRetired(h.a, part.beat), true); assert.equal(reads, 4);
    transactSharedDocument(h.a, "local-command", () => { record.set("lengthSeconds", 9); });
    for (let index = 0; index < 100; index++) assert.equal(isSharedCreationRetired(h.a, part.beat), false);
    assert.equal(reads, 5); assert.equal(record.has(SHARED_CREATION_RETIREMENT_FIELD), true);
    h.send([operation({ kind: "scalar", id: "unrelated", by: "Alice", target: { scope: "beat", record: "R2" }, field: "stamp", value: { by: "Alice", at: "2026-11-14T00:00:02Z" } })]);
    assert.equal(isSharedCreationRetired(h.a, part.beat), false); assert.equal(reads, 5);
    transactSharedDocument(h.a, "local-command", () => { record.delete("lengthSeconds"); });
    assert.equal(isSharedCreationRetired(h.a, part.beat), true); assert.equal(reads, 6);
  } finally { h.close(); }
});

for (const unrelated of [0, 100]) test(`creation ownership index reads only a retargeted child: unrelated=${unrelated}`, t => {
  const h = fixture(0);
  try {
    h.send(Array.from({ length: unrelated + 1 }, (_, index) => createRecord("gallery", "G" + index,
      { beat: "R1", rank: String(index), picture: { imageRef: null }, links: [] })));
    assert.equal(sharedCreationRecordKeys(h.a, "gallery", "beat", "R1").includes("G0"), true);
    h.send([setRecord("gallery", "G0", "beat", "R2")]);
    const root = collabState(h.a).roots.gallery, get = root.get.bind(root), visited: string[] = [];
    const child = get("G0"); assert.ok(child instanceof Y.Map);
    const childGet = child.get.bind(child), fields: string[] = [];
    t.mock.method(child, "get", (field: string): unknown => { fields.push(field); return childGet(field); });
    t.mock.method(root, "get", (key: string) => { visited.push(key); return get(key); });
    t.mock.method(root, "keys", () => { assert.fail("Retargeting enumerated the collection"); });
    assert.equal(sharedCreationRecordKeys(h.a, "gallery", "beat", "R1").includes("G0"), false);
    assert.equal(sharedCreationRecordKeys(h.a, "gallery", "beat", "R2").includes("G0"), true);
    assert.deepEqual(visited, ["G0"]); visited.length = 0;
    assert.deepEqual(fields, ["beat"]); fields.length = 0;
    assert.equal(sharedCreationRecordKeys(h.a, "gallery", "beat", "R2").includes("G0"), true);
    assert.deepEqual(visited, []);
    assert.deepEqual(fields, []);
  } finally { h.close(); }
});

test("creation retirement sees a guarded callback before its dependency observer", () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "abc" }] });
  const state = collabState(h.a); let beat = "", inspect = false, callbacks = 0;
  const listener = () => guardSharedCallback(state, () => {
    if (inspect) { callbacks++; assert.equal(isSharedCreationRetired(h.a, beat), false); }
  });
  state.doc.on("beforeObserverCalls", listener);
  try {
    registerSharedOperationFamilies(h.a, { cells: createFlowLoadRuntime().cells });
    const result = executeSharedCommand(h.a, [operation({ kind: "segment-create", id: "create", by: "Alice", beat: "N1", segment: "N1",
      at: { left: "R1", right: null, affinity: "after" }, fields: { audioText: "x" } })], { label: "create", selection: null, typing: null }, { base: readSharedRevision(h.a) });
    assert.deepEqual(result.result, { ok: true }); assert.ok(result.record); const part = result.record.parts[0]; assert.ok(part?.kind === "beat-create"); beat = part.beat;
    assert.equal(reverseSharedUndoRecord(h.a, result.record, { by: "Alice", nextId: () => "undo" }).ok, true);
    assert.equal(isSharedCreationRetired(h.a, beat), true); inspect = true;
    const record = state.roots.beats.get(beat); assert.ok(record instanceof Y.Map);
    transactSharedDocument(h.a, "local-command", () => { record.set("lengthSeconds", 9); });
    assert.equal(callbacks, 1); assert.equal(isSharedCreationRetired(h.a, beat), false);
  } finally { state.doc.off("beforeObserverCalls", listener); h.close(); }
});
