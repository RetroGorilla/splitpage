import * as Y from "yjs";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedMarkBirth, SharedTextIdentity } from "./mark-record.ts";
import type { SharedMarkWritePlan } from "./mark-plan.ts";
import { collabPreparedOperationTextTarget } from "./text-target.ts";
import { writeCollabMarkPlan } from "./mark-store.ts";

export type CollabTextMutation = { readonly type: "text"; readonly at: number; readonly value: string }
  | { readonly type: "atom"; readonly at: number; readonly value: Readonly<Record<string, unknown>> }
  | { readonly type: "delete"; readonly from: number; readonly to: number };
export interface SharedTextWritePlan { readonly target: SharedTextAddress; readonly edit: CollabTextMutation; readonly marks: readonly SharedMarkWritePlan[] }

export function editCollabText(text: Y.Text, edit: CollabTextMutation): SharedMarkBirth | null {
  if (edit.type === "delete") { text.delete(edit.from, edit.to - edit.from); return null; }
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
