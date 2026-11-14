import type { SharedOperation, SharedSegmentCreate, SharedSegmentRetire } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationResult, SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { collabState } from "./state.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureIdentity } from "./structure-identity.ts";
import { planSharedCreationRetirement } from "./structure-plan.ts";
import { isSharedCreationRetired, readSharedCreationContent } from "./creation-retirement.ts";
import { SHARED_CREATION_RETIREMENT_FIELD } from "./creation-marker.ts";

export type SharedCreationUndoPart = Extract<SharedUndoPart, { kind: "beat-create" }>;

export function recordSharedCreation(handle: SharedDocumentHandle, operation: SharedSegmentCreate): SharedCreationUndoPart {
  const writer = String(collabState(handle).doc.clientID), beat = sharedStructureIdentity(writer, operation.id, "beat");
  return { kind: "beat-create", beat, writer, retired: false, content: readSharedCreationContent(handle, beat, writer) };
}

export function canReverseSharedCreation(handle: SharedDocumentHandle, part: SharedCreationUndoPart): boolean {
  return isSharedCreationRetired(handle, part.beat) === part.retired && readSharedCreationContent(handle, part.beat, part.writer) === part.content;
}

export function sharedCreationUndoParts(operations: readonly SharedOperation[], parts: readonly SharedUndoPart[]): readonly SharedUndoPart[] {
  const created = new Set(parts.flatMap(part => part.kind === "beat-create" ? [String(part.beat)] : []));
  if (!created.size) return parts;
  for (const operation of operations) if (operation.kind === "segment-create") created.add(operation.beat);
  const comments = new Set(parts.flatMap(part => part.kind === "record-create" && part.target.collection === "comments" && created.has(String(part.fields.rowId)) ? [String(part.target.record)] : []));
  const joins = new Set(operations.flatMap(operation => operation.kind === "join" && (created.has(operation.from) || created.has(operation.into)) ? [String(operation.id)] : []));
  return parts.filter(part => {
    if (part.kind === "text" || part.kind === "mark-add" || part.kind === "mark-remove") return !created.has(part.target.owner);
    if (part.kind === "scalar" || part.kind === "status" || part.kind === "status-retired") return part.target.scope !== "beat" || !created.has(part.target.record);
    if (part.kind === "join") return !created.has(part.from) && !created.has(part.into);
    if (part.kind === "structure" && part.command === "join") return !joins.has(part.operation);
    if (part.kind !== "record-create") return true;
    const { collection } = part.target;
    return collection === "comments" ? !created.has(String(part.fields.rowId)) : collection === "replies" ? !comments.has(String(part.fields.commentId))
      : collection !== "gallery" && collection !== "visuals" || !created.has(String(part.fields.beat));
  });
}

export function prepareSharedSegmentRetire(operation: SharedSegmentRetire, view: SharedPreparationView): SharedPreparationResult {
  if (![operation.id, operation.by, operation.beat, operation.creator].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
  const path = ["beats", operation.beat], field = [...path, SHARED_CREATION_RETIREMENT_FIELD];
  if (view.kind(path) !== "map") return { ok: false, reason: "missing-target" };
  const retired = operation.kind === "segment-retire";
  planSharedCreationRetirement(view, operation.beat, retired);
  const writes: SharedPreparedWrite[] = [{ kind: retired ? "set" : "delete", path: field, ...(retired ? { value: { writer: operation.creator, observed: operation.observed } } : {}) }];
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}
