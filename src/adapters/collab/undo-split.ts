import * as Y from "yjs";
import type { SharedBeatSplit, SharedBeatSplitBefore, SharedContentRef, SharedCreateRetire, SharedSegmentCreate, SharedSplitRestore, SharedSplitRetire } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationResult, SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import { applySharedMapWrites, createSharedPreparation } from "./prepare.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureIdentity, sharedStructureReference } from "./structure-identity.ts";
import { planSharedSplitRetirement, readSharedPlannedSplitObservation, readSharedSplitRetired, readSharedStructureStream, sharedStructurePlanIndex } from "./structure-plan.ts";
import { readProjectionFields } from "./projection-reader.ts";
import { readSharedBoundaryEmbed } from "./structure-boundary.ts";
import { readSharedSplitObservationPart, sharedSplitRetiredField, sharedSplitRetireHolds, sharedSplitStoreView } from "./split-retirement.ts";
import { readSharedBeatShape, readSharedLiveStructure } from "./undo-removal.ts";
import { collabState } from "./state.ts";

export type SharedSplitUndoPart = Extract<SharedUndoPart, { kind: "beat-split" }>;
export type SharedCreateUndoPart = Extract<SharedUndoPart, { kind: "beat-create" }>;

function segmentOf(view: SharedPreparationView, beat: string): string | null {
  const segment = view.kind(["beats", beat, "segment"]) === "value" ? view.get(["beats", beat, "segment"]) : null;
  return typeof segment === "string" ? segment : null;
}

function plannedBoundary(view: SharedPreparationView, beat: string): boolean {
  const segment = segmentOf(view, beat), stream = segment === null ? undefined : readSharedStructureStream(view, segment);
  return stream !== undefined && (stream.head?.kind === "b" && stream.head.id === beat || stream.parts.some(part => part.boundary?.kind === "b" && part.boundary.id === beat));
}

function storedBoundary(handle: SharedDocumentHandle, beat: string): boolean {
  const roots = collabState(handle).roots, segment = readProjectionFields(roots.beats.get(beat), "beat")?.segment;
  const stored = typeof segment === "string" ? roots.segments.get(segment) : null, text: unknown = stored instanceof Y.Map ? stored.get("text") : null;
  const head = stored instanceof Y.Map ? readSharedBoundaryEmbed(stored.get("head")) : null;
  if (head?.kind === "b" && head.id === beat) return true;
  return text instanceof Y.Text && (text.toDelta() as { insert: unknown }[]).some(delta => {
    const boundary = readSharedBoundaryEmbed(delta.insert);
    return boundary?.kind === "b" && boundary.id === beat;
  });
}

// why: a split's undo needs the new beat's boundary after the source, as the readers' hold does; a creation's
// undo needs the new beat's text as the creation left it instead.
function shape(handle: SharedDocumentHandle, beat: string, left: "predecessor" | "content" = "predecessor"): string {
  const view = sharedSplitStoreView(collabState(handle).roots), beats = new Set([beat]);
  return JSON.stringify([readSharedBeatShape(handle, beat), ...(["boundaries", left] as const).map(part => readSharedSplitObservationPart(view, beats, part).get(beat) ?? null)]);
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
  const writes: SharedPreparedWrite[] = [{ kind: "set", path: ["meta", sharedSplitRetiredField(operation.beat)], value: { observed: readSharedPlannedSplitObservation(view, sharedStructurePlanIndex(view), operation.beat) } }];
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}

// why: undoing a creation keeps the new beat and marks it with what the undo saw of it and its text; the beat and that
// text are dropped only while they are unchanged since, so a change made without seeing the undo keeps the beat.
export function prepareSharedCreateRetire(operation: SharedCreateRetire, view: SharedPreparationView): SharedPreparationResult {
  if (!stable(operation)) return { ok: false, reason: "unstable-identity" };
  if (view.resolveOwner(operation.beat, "audioText")?.owner !== operation.beat) {
    return readSharedSplitRetired(view, operation.beat) ? { ok: true, writes: [], apply: () => undefined } : { ok: false, reason: "missing-target" };
  }
  planSharedSplitRetirement(view, operation.beat, true, true);
  const observed = readSharedPlannedSplitObservation(view, sharedStructurePlanIndex(view), operation.beat, "drop");
  const writes: SharedPreparedWrite[] = [{ kind: "set", path: ["meta", sharedSplitRetiredField(operation.beat)], value: { observed, drop: true } }];
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}

export function prepareSharedSplitRestore(operation: SharedSplitRestore, view: SharedPreparationView): SharedPreparationResult {
  if (!stable(operation)) return { ok: false, reason: "unstable-identity" };
  const writes: SharedPreparedWrite[] = [{ kind: "delete", path: ["meta", sharedSplitRetiredField(operation.beat)] }];
  // why: an earlier operation of the same list can bring the beat back by changing what its mark saw, so the mark goes.
  if (view.resolveOwner(operation.beat, "audioText")?.owner === operation.beat) {
    return view.has(["meta", sharedSplitRetiredField(operation.beat)]) ? { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) } : { ok: false, reason: "existing-boundary" };
  }
  if (!readSharedSplitRetired(view, operation.beat) || !plannedBoundary(view, operation.beat)) return { ok: false, reason: "missing-target" };
  planSharedSplitRetirement(view, operation.beat, false);
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

export function recordSharedCreate(handle: SharedDocumentHandle, operation: SharedSegmentCreate): SharedCreateUndoPart | null {
  const prep = createSharedPreparation(handle);
  let beat: string;
  try { beat = sharedStructureIdentity(prep.view.writer, operation.id, "beat"); } finally { prep.close(); }
  if (!collabState(handle).roots.beats.has(beat) || !storedBoundary(handle, beat)) return null;
  return { kind: "beat-create", beat: beat as SharedContentRef, retired: false, content: shape(handle, beat, "content") };
}

// why: a creation is undone only while its beat stands as the creation left it, with its text; a redo only shows more.
export function planSharedCreateUndo(handle: SharedDocumentHandle, part: SharedCreateUndoPart, author: () => { id: string; by: string },
  push: (raw: Record<string, unknown>) => void): { readonly effective: boolean; readonly inverse: () => SharedCreateUndoPart } {
  const hidden = sharedSplitRetireHolds(collabState(handle).roots, part.beat);
  const standing = readSharedLiveStructure(handle).beats.has(part.beat) && storedBoundary(handle, part.beat) && hidden === part.retired;
  if (!standing || !part.retired && shape(handle, part.beat, "content") !== part.content) return { effective: false, inverse: () => ({ ...part, retired: !part.retired }) };
  push({ kind: part.retired ? "split-restore" : "create-retire", ...author(), beat: part.beat });
  return { effective: true, inverse: () => ({ ...part, retired: !part.retired, content: shape(handle, part.beat, "content") }) };
}
