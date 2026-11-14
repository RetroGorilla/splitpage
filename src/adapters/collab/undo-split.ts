import * as Y from "yjs";
import type { SharedBeatSplit, SharedBeatSplitBefore, SharedContentRef, SharedSplitRestore, SharedSplitRetire } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationResult, SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import { applySharedMapWrites, createSharedPreparation } from "./prepare.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureIdentity, sharedStructureReference } from "./structure-identity.ts";
import { planSharedSplitRetirement, readSharedSplitRetired, readSharedStructureStream } from "./structure-plan.ts";
import { readProjectionFields, readProjectionHead } from "./projection-reader.ts";
import { sharedPreparedTextInsert } from "./prepare-value.ts";
import { markSharedSplitRetired, readSharedSplitObservationPart, sharedSplitRetiredField, sharedSplitRetireHolds } from "./split-retirement.ts";
import { readSharedBeatShape, readSharedLiveStructure } from "./undo-removal.ts";
import { collabState } from "./state.ts";

export type SharedSplitUndoPart = Extract<SharedUndoPart, { kind: "beat-split" }>;

function segmentOf(view: SharedPreparationView, beat: string): string | null {
  const segment = view.kind(["beats", beat, "segment"]) === "value" ? view.get(["beats", beat, "segment"]) : null;
  return typeof segment === "string" ? segment : null;
}

function plannedBoundary(view: SharedPreparationView, beat: string): boolean {
  const segment = segmentOf(view, beat), stream = segment === null ? undefined : readSharedStructureStream(view, segment);
  return stream?.parts.some(part => part.boundary?.kind === "b" && part.boundary.id === beat) ?? false;
}

function storedBoundary(handle: SharedDocumentHandle, beat: string): boolean {
  const roots = collabState(handle).roots, segment = readProjectionFields(roots.beats.get(beat), "beat")?.segment;
  const stored = typeof segment === "string" ? roots.segments.get(segment) : null, text: unknown = stored instanceof Y.Map ? stored.get("text") : null;
  return text instanceof Y.Text && (text.toDelta() as { insert: unknown }[]).some(delta => {
    const boundary = readProjectionHead(sharedPreparedTextInsert(delta.insert));
    return boundary?.kind === "b" && boundary.id === beat;
  });
}

// why: a heading made from the new beat's first line writes its boundary again, which is a change like any other.
function shape(handle: SharedDocumentHandle, beat: string): string {
  return JSON.stringify([readSharedBeatShape(handle, beat), readSharedSplitObservationPart(collabState(handle).roots, new Set([beat]), "boundaries").get(beat) ?? []]);
}

function stable(operation: { readonly id: string; readonly by: string; readonly beat: string }): boolean {
  return [operation.id, operation.by, operation.beat].every(isStableSharedIdentity);
}

// why: undoing a split keeps its boundary and marks the new beat with what the undo saw of it; the boundary reads as
// text only while the new beat is unchanged since, so a change made without seeing the undo keeps the split.
export function prepareSharedSplitRetire(operation: SharedSplitRetire, view: SharedPreparationView): SharedPreparationResult {
  if (!stable(operation)) return { ok: false, reason: "unstable-identity" };
  if (view.resolveOwner(operation.beat, "audioText")?.owner !== operation.beat) {
    return readSharedSplitRetired(view, operation.beat) ? { ok: true, writes: [], apply: () => undefined } : { ok: false, reason: "missing-target" };
  }
  planSharedSplitRetirement(view, operation.beat, true);
  return { ok: true, writes: [], apply: handle => markSharedSplitRetired(collabState(handle).roots, operation.beat) };
}

export function prepareSharedSplitRestore(operation: SharedSplitRestore, view: SharedPreparationView): SharedPreparationResult {
  if (!stable(operation)) return { ok: false, reason: "unstable-identity" };
  if (view.resolveOwner(operation.beat, "audioText")?.owner === operation.beat) return { ok: false, reason: "existing-boundary" };
  if (!readSharedSplitRetired(view, operation.beat) || !plannedBoundary(view, operation.beat)) return { ok: false, reason: "missing-target" };
  planSharedSplitRetirement(view, operation.beat, false);
  const writes: SharedPreparedWrite[] = [{ kind: "delete", path: ["meta", sharedSplitRetiredField(operation.beat)] }];
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}

export function recordSharedSplit(handle: SharedDocumentHandle, operation: SharedBeatSplit | SharedBeatSplitBefore): SharedSplitUndoPart | null {
  const prep = createSharedPreparation(handle);
  let beat: string, source: string;
  try {
    beat = sharedStructureIdentity(prep.view.writer, operation.id, "beat");
    source = sharedStructureReference(prep.view, operation.target.owner);
  } finally { prep.close(); }
  // why: a split of a beat made earlier in the same list names it by an alias that cannot be resolved here.
  if (!collabState(handle).roots.beats.has(source) || !storedBoundary(handle, beat)) return null;
  return { kind: "beat-split", beat: beat as SharedContentRef, source: source as SharedContentRef, retired: false, content: shape(handle, beat) };
}

export interface SharedSplitUndoPlan { readonly effective: boolean; readonly inverse: () => SharedSplitUndoPart }

// why: a split is undone only while both beats stand and the new beat is as the split left it; a redo only shows more.
export function planSharedSplitUndo(handle: SharedDocumentHandle, part: SharedSplitUndoPart, author: () => { id: string; by: string },
  push: (raw: Record<string, unknown>) => void): SharedSplitUndoPlan {
  const live = readSharedLiveStructure(handle), hidden = sharedSplitRetireHolds(collabState(handle).roots, part.beat);
  const standing = live.beats.has(part.source) && storedBoundary(handle, part.beat) && hidden === part.retired;
  // why: a used-up part's inverse points the other way, so a later redo never takes this split back.
  if (!standing || !part.retired && shape(handle, part.beat) !== part.content) return { effective: false, inverse: () => ({ ...part, retired: !part.retired }) };
  push({ kind: part.retired ? "split-restore" : "split-retire", ...author(), beat: part.beat });
  return { effective: true, inverse: () => ({ ...part, retired: !part.retired, content: shape(handle, part.beat) }) };
}
