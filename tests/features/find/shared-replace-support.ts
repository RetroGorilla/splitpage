import assert from "node:assert/strict";
import { sharedAuthorPort } from "../../collab/editor-ports/shared-author.ts";
import { sharedUndoOwner } from "../../collab/editor-ports/shared-undo.ts";
import { sharedCommandRefusalNotice } from "../../../src/bootstrap/wiring/ports/shared-command-notices.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { operation, replicas } from "../../adapters/collab/executor-support.ts";
import { sharedHarness } from "../../application/session/shared-session-support.ts";
import { adapterReplica } from "../../application/session/legacy-shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { fakeNotices } from "../fakes.ts";

export const FIND_ORDERS = ["D1", "rev", "dup"] as const;
export type FindOrder = typeof FIND_ORDERS[number];
export const FIND_AT = "2026-11-14T10:00:00.000Z";
type Notices = ReturnType<typeof fakeNotices>;

export function findSource(cell: string, visual = false): Record<string, unknown> {
  return { schema: 2, docId: "d00000000000000000000000000000000", title: "",
    rows: [{ id: "R1", status: "todo", audioText: visual ? "" : cell, visualText: visual ? cell : "" }, { id: "R2", status: "todo", audioText: "a cup" }],
    comments: [{ id: "C1", author: "Ann", createdAt: FIND_AT, rowId: "R1", field: "audioText", anchorId: "C1", body: "note", quotedText: "cup", resolved: false, resolvedAt: null, resolvedBy: null }],
    productionTags: [{ id: "t_1", cat: "prop", name: "Gaffer tape", status: "needed" }],
    brollShots: [{ id: "S1", name: "Cup", status: "unshot", origin: "list" }] };
}

export function findReplicas(document: Record<string, unknown>) {
  const set = replicas(2, document);
  for (const handle of [set.a, set.b, set.c]) registerSharedOperationFamilies(handle, { cells: createFlowLoadRuntime().cells });
  return set;
}

export function findCopy(handle: SharedDocumentHandle, name: string, notices: Notices) {
  const author = sharedAuthorPort({ handle: () => handle, name: () => name });
  const owner = sharedUndoOwner(handle, () => author.next(), () => 0, error => { throw error; });
  const harnessed = sharedHarness(adapterReplica(handle, owner), { refused: sharedCommandRefusalNotice(notices.notices) });
  return { owner, harness: harnessed, session: harnessed.session };
}

interface FindRowCells { readonly audioText: unknown; readonly visualText: unknown; readonly updatedAt: unknown; readonly updatedBy: unknown }
export function rowCells(row: unknown): FindRowCells {
  const fields = row as Record<string, unknown>;
  return { audioText: fields.audioText, visualText: fields.visualText, updatedAt: fields.updatedAt, updatedBy: fields.updatedBy };
}
function project(handle: SharedDocumentHandle) {
  return projectSharedDocumentWithRecovery(handle).document.rows.map(rowCells);
}
function late(handle: SharedDocumentHandle) {
  const joiner = createSharedDocument();
  try { assert.equal(applySharedUpdate(joiner, encodeSharedState(handle)).ok, true); return project(joiner); } finally { destroySharedDocument(joiner); }
}
export function agreedRows(label: string, set: ReturnType<typeof findReplicas>, order: FindOrder = "D1") {
  const readings = [set.a, set.b].map((handle, index) => ({ order, replica: index ? "B" as const : "A" as const, output: project(handle) }));
  assertReplicasAgree(label, [...readings, { order: "late-C", replica: "C", output: late(set.a) }]);
  return readings[0]?.output ?? [];
}
export function deliverAll(queue: ReturnType<typeof replicas>["queue"], order: FindOrder) {
  for (let round = 0; round < 100 && queue.pending.length; round++) {
    const pending = [...queue.pending];
    if (order === "rev") pending.reverse();
    for (const message of pending) queue.deliver(message.id, order === "dup" ? 2 : 1);
  }
  assert.equal(queue.pending.length, 0);
}
export function sendAs(handle: SharedDocumentHandle, ...values: unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
