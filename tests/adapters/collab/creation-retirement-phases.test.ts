import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, operation } from "./executor-support.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { applySharedUpdate, encodeSharedState, destroySharedDocument, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { collabState, guardSharedCallback } from "../../../src/adapters/collab/state.ts";
import { observeSharedStructureIndex } from "../../../src/adapters/collab/structure-index.ts";
import { readProjectionBlocks } from "../../../src/adapters/collab/projection-reader.ts";
import { readProjectionUnits } from "../../../src/adapters/collab/projection-text-reader.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

function reading(handle: SharedDocumentHandle) {
  const index = observeSharedStructureIndex(handle), state = collabState(handle);
  return { hidden: [...state.roots.beats.keys()].sort().map(id => [id, index.hidden(id)]),
    blocks: readProjectionBlocks(handle, record => readProjectionUnits(handle, record.get("text"), record.get("markRecords"))) };
}

for (const order of ["D1", "rev"] as const) test(`creation retirement generated readers equal encoded readers in every transaction phase: ${order}`, t => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "abc", visualText: "look" }, { id: "R2", audioText: "d" }] });
  const handles = [h.a, h.b, h.c], removals: (() => void)[] = []; let checking = false, step = "setup", serial = 0, comparisons = 0;
  const compare = (handle: SharedDocumentHandle, phase: string) => {
    if (checking) return; checking = true;
    const fresh = createMonitoredSharedDocument();
    try {
      assert.equal(applySharedUpdate(fresh, encodeSharedState(handle)).ok, true);
      assert.deepEqual(reading(handle), reading(fresh), step + "/" + phase); comparisons++;
    } finally { destroySharedDocument(fresh); checking = false; }
  };
  for (const handle of handles) {
    registerSharedOperationFamilies(handle, { cells: createFlowLoadRuntime().cells });
    const state = collabState(handle);
    for (const phase of ["beforeTransaction", "beforeObserverCalls", "afterTransaction", "afterAllTransactions"] as const) {
      const callback = () => guardSharedCallback(state, () => compare(handle, phase)); state.doc.on(phase, callback);
      removals.push(() => state.doc.off(phase, callback));
    }
    for (const root of Object.values(state.roots)) {
      const callback = () => guardSharedCallback(state, () => compare(handle, "observer")); root.observeDeep(callback);
      removals.push(() => root.unobserveDeep(callback));
    }
  }
  const docs = new Map(handles.map(handle => [collabState(handle).doc, handle]));
  for (const name of ["set", "delete"] as const) {
    const original = Y.Map.prototype[name];
    t.mock.method(Y.Map.prototype, name, function (this: Y.Map<unknown>, ...args: unknown[]) {
      const result: unknown = Reflect.apply(original, this, args); const handle = this.doc && docs.get(this.doc);
      if (handle) compare(handle, "inside-map-write"); return result;
    });
  }
  for (const name of ["insert", "insertEmbed", "delete", "format"] as const) {
    const original = Y.Text.prototype[name];
    t.mock.method(Y.Text.prototype, name, function (this: Y.Text, ...args: unknown[]) {
      const result: unknown = Reflect.apply(original, this, args); const handle = this.doc && docs.get(this.doc);
      if (handle) compare(handle, "inside-text-write"); return result;
    });
  }
  const owner = createSharedUndo({ now: () => serial * 2000, supports: supportsSharedUndoPart,
    reverse: record => reverseSharedUndoRecord(h.a, record, { by: "Alice", nextId: () => "undo-" + ++serial }) });
  const command = (values: readonly unknown[]) => {
    let beat = "";
    owner.perform(() => {
      const result = executeSharedCommand(h.a, values.map(operation), { label: step, selection: null, typing: null }, { base: readSharedRevision(h.a) });
      assert.deepEqual(result.result, { ok: true });
      const part = result.record?.parts.find(part => part.kind === "beat-create"); if (part?.kind === "beat-create") beat = part.beat;
      return result.record;
    }); return beat;
  };
  const add = (id: string) => command([{ kind: "segment-create", id, by: "Alice", beat: id, segment: id,
    at: { left: "R1", right: "R2", affinity: "before" }, fields: { audioText: "x", visualText: "v" } }]);
  const type = (field: "audioText" | "visualText", id: string) => command([{ kind: "text-insert", id, by: "Alice", target: { owner: "R1", segment: "R1", field },
    at: { left: null, right: flowBaseReference("R1", field, 0), affinity: "before" }, content: [{ value: "y", marks: [] }] }]);
  try {
    let steps = 0;
    const run = (name: string, act: () => void) => { step = name; act(); steps++; for (const handle of handles) compare(handle, "after-operation"); };
    for (let cycle = 0; cycle < 3; cycle++) {
      let beat = "", raced = "";
      run("add-" + cycle, () => { beat = add("new-" + cycle); h.queue.flush(order); });
      run("undo-creation-" + cycle, () => { assert.equal(owner.undo().ok, true); });
      run("encoded-retirement-" + cycle, () => { assert.equal(applySharedUpdate(h.c, encodeSharedState(h.a)).ok, true); });
      run("deliver-retirement-" + cycle, () => h.queue.flush(order));
      for (const field of ["audioText", "visualText"] as const) run("remote-hidden-" + field + "-" + cycle, () => {
        assert.deepEqual(executeSharedOperations(h.b, [operation({ kind: "text-insert", id: step, by: "Bob", target: { owner: "R1", segment: "R1", field },
          at: { left: null, right: flowBaseReference("R1", field, 0), affinity: "before" }, content: [{ value: "r", marks: cycle % 2 ? [{ kind: "b", value: true }] : [] }] })],
          { base: readSharedRevision(h.b) }), { ok: true }); h.queue.flush(order);
      });
      run("redo-creation-" + cycle, () => { assert.equal(owner.redo().ok, true); h.queue.flush(order); });
      run("narration-" + cycle, () => { type("audioText", step); });
      run("visual-" + cycle, () => { type("visualText", step); });
      run("format-" + cycle, () => { command([{ kind: "mark", id: step, by: "Alice", target: { owner: "R1", segment: "R1", field: "visualText" },
        observed: [flowBaseReference("R1", "visualText", 0, 1)], mark: { kind: "b", value: true } }]); });
      run("value-" + cycle, () => { command([{ kind: "scalar", id: step, by: "Alice", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: cycle + 1 }]); });
      run("undo-value-" + cycle, () => { assert.equal(owner.undo().ok, true); });
      run("join-" + cycle, () => { command([{ kind: "join", id: step, by: "Alice", from: beat, into: "R1", glue: " " }]); });
      run("undo-join-" + cycle, () => { assert.equal(owner.undo().ok, true); });
      run("split-" + cycle, () => { command([{ kind: "split", id: step, by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
        at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, observed: [], boundary: step, beat: step, fields: {} }]); });
      run("undo-split-" + cycle, () => { assert.equal(owner.undo().ok, true); h.queue.flush(order); });
      run("race-add-" + cycle, () => { raced = add("race-" + cycle); h.queue.flush(order); });
      run("remote-value-" + cycle, () => {
        assert.deepEqual(executeSharedOperations(h.b, [operation({ kind: "scalar", id: step, by: "Bob", target: { scope: "beat", record: raced }, field: "lengthSeconds", value: 9 })],
          { base: readSharedRevision(h.b) }), { ok: true });
      });
      run("race-undo-" + cycle, () => { assert.equal(owner.undo().ok, true); });
      run("deliver-race-" + cycle, () => h.queue.flush(order));
      run("encoded-race-" + cycle, () => { assert.equal(applySharedUpdate(h.c, encodeSharedState(h.a)).ok, true); });
    }
    assert.ok(comparisons >= 300); t.diagnostic(JSON.stringify({ cycles: 3, steps, comparisons }));
  } finally { t.mock.restoreAll(); removals.forEach(remove => remove()); h.close(); }
});
