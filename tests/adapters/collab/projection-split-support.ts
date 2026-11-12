import assert from "node:assert/strict";
import { replicas, operation, ref } from "./executor-support.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { literalMergedDocument } from "./projection-merged-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const structurePorts = { cells: createFlowLoadRuntime().cells };

export const splitIdentities = ["structure_1_006300750074_beat_0", "structure_2_006300750074_beat_0", "structure_3_006300750074_beat_0"] as const;
export const splitInputFields = [
  { status: "ready", lengthSeconds: 11, paragraphStart: true, stamp: { at: "t1", by: "P1" } },
  { status: "shot", lengthSeconds: 22, stamp: { at: "t2", by: "P2" } },
  { status: "todo", lengthSeconds: 33, stamp: { at: "t3", by: "P3" } }
] as const;
export function splitRow(writer: number, audioText: string) {
  const choices = [{ status: "ready", updatedAt: "t1", updatedBy: "P1", lengthSeconds: 11, paragraphStart: true },
    { status: "shot", updatedAt: "t2", updatedBy: "P2", lengthSeconds: 22 },
    { status: "todo", updatedAt: "t3", updatedBy: "P3", lengthSeconds: 33 }] as const;
  const fields = choices[writer];
  const id = splitIdentities[writer]; assert.ok(fields && id);
  const { status, ...extra } = fields;
  return { id, status, visualText: "", audioText, imageRef: null, ...extra };
}
export function splitOriginal(audioText: string) { const row = literalMergedDocument(audioText).rows[0]; assert.ok(row); return row; }
export function splitReplicas(count: number, source: Record<string, unknown>) {
  const run = replicas(count, source), handles = [run.a, run.b, ...(count === 3 ? [run.c] : [])];
  for (const handle of handles) { registerSharedSplitHandlers(handle, structurePorts); registerSharedTextOperationHandlers(handle); }
  return { ...run, handles };
}
export function submitProjectionOperations(handle: SharedDocumentHandle, commands: readonly unknown[]): void {
  assert.deepEqual(executeSharedOperations(handle, commands.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
export function splitCommand(offset: number, before = false, fields: Record<string, unknown> = { status: "todo" }, id = "cut") {
  return { kind: before ? "split-before" : "split", id, by: "Writer", target: { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" },
    at: { left: null, right: flowBaseReference("R1", "audioText", offset), affinity: "before" }, observed: [], boundary: "B", beat: "new", fields };
}
