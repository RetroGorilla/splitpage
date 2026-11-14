import test from "node:test";
import assert from "node:assert/strict";
import { replicas, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { readSharedRevision, applySharedUpdate, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { isSharedCreationRetired, sharedCreationObservationCost } from "../../../src/adapters/collab/creation-retirement.ts";
import { readSharedCreationCandidates } from "../../../src/adapters/collab/creation-observation-cache.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { sharedStructureKey } from "../../../src/core/collab/structure-key.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";

const placements = [[], ["R1"], ["R2"], ["R1", "R1"], ["R2", "R2"], ["R1", "R2"]] as const;
for (const unrelated of [0, 100]) for (const hosts of placements) for (const field of ["audioText", "visualText"] as const)
  for (const formatted of [false, true]) for (const invalidated of [false, true]) test(`retirement complete typing matrix: ${hosts.join(",") || "none"}/${field}/formatted=${formatted}/invalidated=${invalidated}/unrelated=${unrelated}`, t => {
    const h = replicas(2, { rows: [{ id: "R1", audioText: "abc", visualText: "look" }, { id: "R2", audioText: "def" },
      ...Array.from({ length: unrelated }, (_, index) => ({ id: "U" + index, audioText: "unrelated" }))] });
    const runtime = createFlowLoadRuntime(), records: SharedUndoRecord[] = [], tails = new Map<string, string>(), previous = new Map<string, string>(); let serial = 0;
    const send = (handle: typeof h.a, values: readonly unknown[]) => assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
    try {
      for (const handle of [h.a, h.c]) registerSharedOperationFamilies(handle, { cells: runtime.cells });
      for (const owner of ["R1", "R2"]) {
        const id = "split-" + owner, tail = sharedStructureKey("1", id, "beat"); assert.ok(tail); tails.set(owner, tail);
        send(h.a, [{ kind: "split", id, by: "Alice", target: { owner, segment: owner, field: "audioText" },
          at: { left: null, right: flowBaseReference(owner, "audioText", 1), affinity: "before" }, observed: [], boundary: id, beat: id, fields: {} }]);
      }
      for (const [index, host] of hosts.entries()) {
        const id = "create-" + index, result = executeSharedCommand(h.a, [operation({ kind: "segment-create", id, by: "Alice", beat: id, segment: id,
          at: { left: previous.get(host) ?? host, right: tails.get(host), affinity: "after" }, fields: { audioText: "x", visualText: "v" } })],
        { label: "create", selection: null, typing: null }, { base: readSharedRevision(h.a) });
        assert.deepEqual(result.result, { ok: true }); assert.ok(result.record); records.push(result.record);
        const part = result.record.parts[0]; assert.ok(part?.kind === "beat-create"); previous.set(host, part.beat);
      }
      assert.equal(applySharedUpdate(h.c, encodeSharedState(h.a)).ok, true);
      for (const record of records) {
        const part = record.parts[0]; assert.ok(part?.kind === "beat-create");
        send(h.c, [{ kind: "scalar", id: "foreign-" + part.beat, by: "Bob", target: { scope: "beat", record: part.beat }, field: "lengthSeconds", value: 9 }]);
      }
      for (const record of [...records].reverse()) assert.equal(reverseSharedUndoRecord(h.a, record, { by: "Alice", nextId: () => "undo-" + ++serial }).ok, true);
      const { projector } = captureIncrementalReplica(h.a);
      try {
        if (invalidated) {
          assert.equal(applySharedUpdate(h.a, encodeSharedState(h.c)).ok, true);
          for (const record of records) { const part = record.parts[0]; assert.ok(part?.kind === "beat-create"); assert.equal(isSharedCreationRetired(h.a, part.beat), false); }
        }
        if (invalidated) assert.equal(readSharedCreationCandidates(h.a).size, 0);
        const key = (id: string) => {
          sharedCreationObservationCost.checks = 0; sharedCreationObservationCost.builds = 0;
          const result = executeSharedCommand(h.a, [operation({ kind: "text-insert", id, by: "Alice", target: { owner: "R1", segment: "R1", field },
            at: { left: null, right: flowBaseReference("R1", field, 0), affinity: "before" }, content: [{ value: "z", marks: formatted ? [{ kind: "b", value: true }] : [] }] }),
          operation({ kind: "scalar", id: id + "-stamp", by: "Alice", target: { scope: "beat", record: "R1" }, field: "stamp", value: { by: "Alice", at: "2026-11-14T00:00:00Z" } })],
          { label: "typing", selection: null, typing: "z" }, { base: readSharedRevision(h.a) });
          assert.deepEqual(result.result, { ok: true }); const cost = { ...sharedCreationObservationCost };
          assertIncremental(h.a, projector); return cost;
        };
        const first = key("first"), following = key("following");
        assert.deepEqual(following, { checks: 0, builds: 0 });
        const cold = invalidated ? 0 : hosts.filter(host => host === "R1").length;
        assert.deepEqual(first, { checks: cold, builds: cold });
        if (invalidated) assert.equal(readSharedCreationCandidates(h.a).size, 0);
        t.diagnostic(JSON.stringify({ hosts, field, formatted, invalidated, unrelated, first, following }));
      } finally { projector.dispose(); }
    } finally { h.close(); }
  });
