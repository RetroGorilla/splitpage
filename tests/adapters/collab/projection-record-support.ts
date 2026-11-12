import assert from "node:assert/strict";
import * as Y from "yjs";
import { recordReplicas } from "./record-support.ts";
import { operation, agree } from "./executor-support.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { literalMergedDocument, mergedProjectionSave, readPureMergedProjection } from "./projection-merged-support.ts";
import type { DocumentShape } from "../../../src/core/document/validated.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";

export const pictureA = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
export const annotationA = { imageRef: { ...pictureA, sha256: "b".repeat(64) }, marks: [{ kind: "text", color: "#ffffff", size: 0.1, x: 0, y: 0, text: "Typed note" }] };
export const plainRow = (id: string, audioText: string) => ({ ...literalMergedDocument(audioText).rows[0], id });
export function recordProjectionReplicas(copies: number, source: Record<string, unknown>) {
  const run = recordReplicas(copies, source), handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
  handles.forEach(registerSharedTextOperationHandlers); return { ...run, handles };
}
export function submitRecords(handle: Parameters<typeof executeSharedOperations>[0], commands: readonly unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, commands.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
export function rawGalleryJoin(handle: Parameters<typeof collabState>[0], removed = false) {
  transactSharedDocument(handle, "local-command", () => {
    const beat = collabState(handle).roots.beats.get("R2"); assert.ok(beat instanceof Y.Map);
    const joins = beat.get("joins"); assert.ok(joins instanceof Y.Map); joins.set("joined", { into: "R1", glue: " " });
    if (removed) {
      const root = collabState(handle).roots.beats.get("R1"); assert.ok(root instanceof Y.Map);
      const removals = root.get("removals"); assert.ok(removals instanceof Y.Map); removals.set("removed", true);
    }
  });
}
export function checkRecordProjection(run: ReturnType<typeof recordProjectionReplicas>, order: DeliveryOrder, document: DocumentShape, recovery: readonly unknown[] = []) {
  run.queue.flush(order);
  for (const handle of run.handles) {
    const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery }); assert.equal(actual.save, mergedProjectionSave(document));
  }
  agree("merged record projection", order, run.handles, readPureMergedProjection);
}
