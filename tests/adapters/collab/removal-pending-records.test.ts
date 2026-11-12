import test from "node:test";
import assert from "node:assert/strict";
import { replicas, operation, agree } from "./executor-support.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRemovalCommand } from "../../../src/adapters/collab/removal-record.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";

const target = { collection: "gallery", record: "g" };
const attach = (beat: string) => operation({ kind: "record-create", id: "attach", by: "", target, fields: { beat, rank: "0", picture: { name: "late" } } });
const reassign = (beat: string) => operation({ kind: "record-set", id: "assign", by: "", target, field: "beat", value: beat });
const remove = (gallery: string[]) => operation({ kind: "remove", id: "r", by: "", removalKind: "beat", targets: ["R1"], observed: [], boundaries: ["R1"], components: [], gallery, comments: [], at: 0 });

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const sample of [
  { name: "created", initial: null, pending: [attach("R1")], supplied: [], expected: ["R1:slot:0", "g"], picture: "late" },
  { name: "created and explicitly observed", initial: null, pending: [attach("R1")], supplied: ["g"], expected: ["R1:slot:0", "g"], picture: "late" },
  { name: "reassigned in", initial: "R2", pending: [reassign("R1")], supplied: ["g"], expected: ["R1:slot:0", "g"], picture: "late" },
  { name: "reassigned away", initial: "R1", pending: [reassign("R2")], supplied: [], expected: ["R1:slot:0"], picture: undefined },
  { name: "created then reassigned away", initial: null, pending: [attach("R1"), reassign("R2")], supplied: [], expected: ["R1:slot:0"], picture: undefined },
  { name: "deleted", initial: "R1", pending: [operation({ kind: "record-delete", id: "delete", by: "", target })], supplied: [], expected: ["R1:slot:0"], picture: undefined }
]) test(`removal derives ${sample.name} gallery membership from preceding list entries: ${copies}/${order}`, () => {
  const set = replicas(copies, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  const handles = [set.a, set.b, set.c].slice(0, copies);
  try {
    registerSharedRecordHandlers(set.a); registerSharedRemovalHandlers(set.a);
    if (sample.initial) { assert.deepEqual(executeSharedOperations(set.a, [attach(sample.initial)]), { ok: true }); set.queue.flush("D1"); }
    assert.deepEqual(executeSharedOperations(set.a, [...sample.pending, remove(sample.supplied)]), { ok: true }); set.queue.flush(order);
    agree(sample.name, order, handles, handle => {
      const record = readSharedRemovalCommand("structure_1_0072_removal_0", collabState(handle).roots.removalRecords.get("structure_1_0072_removal_0")); assert.ok(record?.kind === "remove");
      const result = projectSharedDocumentWithRecovery(handle), recovery = result.recovery[0]; assert.ok(recovery?.kind === "removed-beat");
      assert.equal(recovery.row.imageName, sample.picture);
      return { gallery: record.gallery, rows: result.document.rows.map(row => row.id) };
    }, { gallery: sample.expected, rows: ["R2"] });
  } finally { set.close(); }
});
