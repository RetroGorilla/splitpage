import * as Y from "yjs";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedMarkBirth, SharedTextIdentity } from "./mark-record.ts";
import type { SharedMarkWritePlan } from "./mark-plan.ts";
import { collabPreparedOperationTextTarget } from "./text-target.ts";
import { writeCollabMarkPlan } from "./mark-store.ts";

export type CollabTextMutation = { readonly type: "text"; readonly at: number; readonly value: string; readonly beside?: SharedTextIdentity }
  | { readonly type: "atom"; readonly at: number; readonly value: Readonly<Record<string, unknown>>; readonly beside?: SharedTextIdentity }
  | { readonly type: "delete"; readonly from: number; readonly to: number };
export interface SharedTextWritePlan { readonly target: SharedTextAddress; readonly edit: CollabTextMutation; readonly marks: readonly SharedMarkWritePlan[] }

// why: an insertion by index lands behind every deleted character at that place. A restored character is written
// directly after the deleted one it restores, so its place among the others is the place that one had.
function insertBeside(text: Y.Text, beside: SharedTextIdentity, value: string | Readonly<Record<string, unknown>>): SharedTextIdentity | null {
  const doc = text.doc;
  if (!doc) return null;
  return Y.transact(doc, transaction => {
    const left = Y.getItemCleanEnd(transaction, doc.store, Y.createID(beside.client, beside.clock));
    if (!(left instanceof Y.Item) || left.parent !== text) return null;
    const right = left.right, id = Y.createID(doc.clientID, Y.getState(doc.store, doc.clientID));
    new Y.Item(id, left, left.lastId, right, right && right.id, text, null, typeof value === "string" ? new Y.ContentString(value) : new Y.ContentEmbed(value))
      .integrate(transaction, 0);
    if (text._searchMarker) text._searchMarker.length = 0;
    return { client: id.client, clock: id.clock };
  });
}

export function editCollabText(text: Y.Text, edit: CollabTextMutation): SharedMarkBirth | null {
  if (edit.type === "delete") { text.delete(edit.from, edit.to - edit.from); return null; }
  const placed = edit.beside ? insertBeside(text, edit.beside, edit.value) : null;
  if (placed) return { ...placed, length: edit.type === "text" ? edit.value.length : 1 };
  if (edit.type === "text") text.insert(edit.at, edit.value);
  else text.insertEmbed(edit.at, edit.value);
  const length = edit.type === "text" ? edit.value.length : 1;
  if (!length) return null;
  const identity = Y.createRelativePositionFromTypeIndex(text, edit.at).item as SharedTextIdentity;
  return { client: identity.client, clock: identity.clock, length };
}

export function applySharedTextEdit(handle: SharedDocumentHandle, description: SharedTextWritePlan): void {
  const { text, store } = collabPreparedOperationTextTarget(handle, description.target);
  const born = editCollabText(text, description.edit);
  for (const plan of description.marks) writeCollabMarkPlan(text, store, description.target, plan, born);
}
