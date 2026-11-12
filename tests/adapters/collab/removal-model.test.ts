import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { observeSharedStructureIndex } from "../../../src/adapters/collab/structure-index.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";

const identities = [
  { beat: "structure_1_007200310037_beat_0", removal: "structure_1_007200310037005f00720065006d006f00760065_removal_0", visual: "structure_1_007200310037_visual_0", a: "structure_1_0061_removal_0" },
  { beat: "structure_2_007200310037_beat_0", removal: "structure_2_007200310037005f00720065006d006f00760065_removal_0", visual: "structure_2_007200310037_visual_0", a: "structure_2_0061_removal_0" },
  { beat: "structure_3_007200310037_beat_0", removal: "structure_3_007200310037005f00720065006d006f00760065_removal_0", visual: "structure_3_007200310037_visual_0", a: "structure_3_0061_removal_0" }
];
const declaredLimits: readonly string[] = [];

test("seeded removal checkpoints agree with a literal model and fresh ownership and attachment indexes", t => {
  let seed = 0x5c33, histories = 0, checkpoints = 0, comparisons = 0, commands = 0;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const runtime = createFlowLoadRuntime(), violations = new Set<string>();
  for (let sample = 0; sample < 12; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(copies, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] });
    const handles = [set.a, set.b, set.c].slice(0, copies), offset = random(3), first = random(copies);
    const send = (handle: typeof set.a, ops: unknown[]) => { assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true }); commands += ops.length; };
    const text = (copies === 2 ? ["ABcd", "cABd", "cdAB"] : ["ABCcd", "cABCd", "cdABC"])[offset]; assert.ok(text);
    const original = [{ id: "R1", text: "ab" }, { id: "R2", text }, { id: "R3", text: "ef" }];
    const created = identities.slice(0, copies).map((value, index) => ({ id: value.beat, text: "MNO".charAt(index) }));
    const checkpoint = (removed: boolean) => {
      set.queue.flush(order); checkpoints++;
      agree("seed=" + seed, order, handles, handle => {
        const value = projectSharedDocumentWithRecovery(handle), prep = createSharedPreparation(handle), index = observeSharedStructureIndex(handle).attachments;
        try {
          const targets = ["R1", "R2", "R3", ...created.map(row => row.id)];
          const result = { rows: value.document.rows.map(row => ({ id: row.id, text: row.audioText })), recovery: value.recovery.map(entry => {
            assert.equal(entry.kind, "removed-beat"); return entry.kind === "removed-beat" ? { id: entry.row.id, text: entry.row.audioText } : null;
          }).sort((a, b) => String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0), owners: targets.map(id => prep.view.resolveOwner(id, "audioText")),
          attachments: targets.map(id => [index.keys("visuals", id), index.keys("gallery", id)]) };
          const expectedRows = removed ? [original[0], original[2]] : [...original, ...created];
          const expectedRecovery = removed ? [original[1], ...created].sort((a, b) => String(a?.id) < String(b?.id) ? -1 : 1) : [];
          try { assert.deepEqual({ rows: result.rows, recovery: result.recovery }, { rows: expectedRows, recovery: expectedRecovery }); }
          catch (error) { violations.add(String(error)); }
          comparisons++; return result;
        } finally { prep.close(); }
      });
    };
    try {
      for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); }
      for (let index = 0; index < copies; index++) {
        const handle = handles[(first + index) % copies]; assert.ok(handle); const writer = handles.indexOf(handle), letter = "ABC".charAt(writer);
        send(handle, [
          { kind: "segment-create", id: "r17", by: "Writer", beat: "new", segment: "segment", at: { left: "R3", right: null, affinity: "after" }, fields: { audioText: "MNO".charAt(writer), visualText: letter } },
          { kind: "remove", id: "r17_remove", by: "Writer", removalKind: "beat", targets: ["new"], observed: [flowBaseReference("new", "audioText", 0, 1)], boundaries: ["new"], components: [], gallery: [], at: 3 },
          { kind: "text-insert", id: "typed", by: "Writer", target: { owner: "R2", segment: "R2", field: "audioText" }, at: { left: null, right: flowBaseReference("R2", "audioText", offset), affinity: "before" }, content: [{ value: letter, marks: [] }] },
          { kind: "remove", id: "a", by: "Writer", removalKind: "beat", targets: ["R2"], observed: [flowBaseReference("R2", "audioText", 0, 2)], boundaries: ["R2"], components: [], gallery: [], at: 1 }
        ]);
      }
      checkpoint(true);
      for (let index = 0; index < copies; index++) { const handle = handles[index], ids = identities[index]; assert.ok(handle && ids);
        send(handle, [{ kind: "restore", id: "back", by: "Writer", removals: [ids.a, ids.removal] }]); }
      checkpoint(false);
      const roots = collabState(set.a).roots; assert.equal(roots.order.length, 3 + copies); histories++;
    } finally { set.close(); }
  }
  assert.deepEqual([...violations], declaredLimits); assert.deepEqual({ histories, checkpoints, comparisons, commands }, { histories: 72, checkpoints: 144, comparisons: 504, commands: 900 });
  t.diagnostic(JSON.stringify({ seed: "0x5c33", histories, checkpoints, comparisons, commands, declaredLimits }));
});
