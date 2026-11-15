import * as Y from "yjs";
import type { SharedHeadingCreate, SharedHeadingFinalize, SharedHeadingRetire, SharedOperation } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationResult, SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { collabState } from "./state.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureIdentity } from "./structure-identity.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import { readSharedBoundaryEmbed } from "./structure-boundary.ts";
import { planSharedCreationRetirement } from "./structure-plan.ts";
import { isSharedCreationRetired, readSharedHeadingCreationContent } from "./creation-retirement.ts";
import { SHARED_CREATION_RETIREMENT_FIELD } from "./creation-marker.ts";

export type SharedHeadingCreationUndoPart = Extract<SharedUndoPart, { kind: "heading-creation" }>;

function holds(raw: unknown, heading: string): boolean {
  const boundary = readSharedBoundaryEmbed(raw); return boundary?.kind === "h" && boundary.id === heading;
}

function headingSegment(handle: SharedDocumentHandle, heading: string): string | null {
  const segments = collabState(handle).roots.segments;
  for (const key of observeSharedStructureIndex(handle).candidates(heading, true)) {
    const stored = segments.get(key), text: unknown = stored instanceof Y.Map ? stored.get("text") : null;
    if (stored instanceof Y.Map && (holds(stored.get("head"), heading) || text instanceof Y.Text && (text.toDelta() as { insert: unknown }[]).some(part => holds(part.insert, heading)))) return key;
  }
  return null;
}

// why: a heading finished from a line is undone by hiding it only when that line's beat came with the same command;
// a typed line has to be given back to its beat, which this does not do.
export function sharedHeadingCreationRecorded(operation: SharedOperation, operations: readonly SharedOperation[]): operation is SharedHeadingCreate | SharedHeadingFinalize {
  return operation.kind === "heading-create" || operation.kind === "heading-finalize"
    && operations.some(item => item.kind === "segment-create" && item.beat === operation.target.owner);
}

export function recordSharedHeadingCreation(handle: SharedDocumentHandle, operation: SharedHeadingCreate | SharedHeadingFinalize): SharedUndoPart {
  const writer = String(collabState(handle).doc.clientID), heading = sharedStructureIdentity(writer, operation.id, "heading"), segment = headingSegment(handle, heading);
  if (segment === null) return { kind: "structure", command: operation.kind, operation: operation.id };
  return { kind: "heading-creation", heading, segment: segment as SharedHeadingCreationUndoPart["segment"], writer, retired: false,
    content: readSharedHeadingCreationContent(handle, heading, writer, segment) };
}

export function canReverseSharedHeadingCreation(handle: SharedDocumentHandle, part: SharedHeadingCreationUndoPart): boolean {
  return isSharedCreationRetired(handle, part.heading) === part.retired && readSharedHeadingCreationContent(handle, part.heading, part.writer, part.segment) === part.content;
}

export function prepareSharedHeadingRetire(operation: SharedHeadingRetire, view: SharedPreparationView): SharedPreparationResult {
  if (![operation.id, operation.by, operation.heading, operation.segment, operation.creator].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
  if (view.kind(["headings", operation.heading]) !== "map") return { ok: false, reason: "missing-target" };
  const retired = operation.kind === "heading-retire", field = [SHARED_CREATION_RETIREMENT_FIELD, operation.heading];
  planSharedCreationRetirement(view, operation.heading, retired);
  const writes: SharedPreparedWrite[] = [{ kind: retired ? "set" : "delete", path: field,
    ...(retired ? { value: { writer: operation.creator, observed: operation.observed, segment: operation.segment } } : {}) }];
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}
