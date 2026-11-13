import type { SharedBeatSplit, SharedBeatSplitBefore, SharedContentRef, SharedSplitRestore, SharedSplitRetire } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView } from "./prepare.ts";
import type { SharedTextOperationPreparation } from "./text-description.ts";
import type { SharedTextCommandPlan } from "./executor-text-plan.ts";
import { createSharedPreparation } from "./prepare.ts";
import { preparedTextDescription, preparedTextOperation } from "./text-description.ts";
import { sharedTextCommandPlan, sharedTextOverlay, spliceSharedTextPlan, SharedTextPreparationError } from "./executor-text-plan.ts";
import { resolveSharedTextReference } from "./executor-references.ts";
import { createSharedAnchor, readSharedAnchorUnit } from "./anchors.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureIdentity, sharedStructureReference } from "./structure-identity.ts";
import { planSharedStructureOwner } from "./structure-plan.ts";
import { readSharedBeatShape, readSharedLiveStructure } from "./undo-removal.ts";

export type SharedSplitUndoPart = Extract<SharedUndoPart, { kind: "beat-split" }>;

function boundaryOf(value: unknown, beat: string): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { readonly b?: unknown }).b === beat;
}

function segmentOf(view: SharedPreparationView, beat: string): string | null {
  const segment = view.kind(["beats", beat, "segment"]) === "value" ? view.get(["beats", beat, "segment"]) : null;
  return typeof segment === "string" ? segment : null;
}

function located(view: SharedPreparationView, owner: string, beat: string): { readonly plan: SharedTextCommandPlan; readonly index: number } | null {
  const segment = segmentOf(view, beat);
  if (!segment) throw new SharedTextPreparationError("missing-target");
  const plan = sharedTextCommandPlan(view, { owner: owner as SharedContentRef, segment: segment as SharedContentRef, field: "audioText" });
  const index = plan.units.findIndex(unit => boundaryOf(unit.value, beat));
  return index < 0 ? null : { plan, index };
}

function checkAuthor(operation: { readonly id: string; readonly by: string }): void {
  if (!isStableSharedIdentity(operation.id) || !isStableSharedIdentity(operation.by)) throw new SharedTextPreparationError("unstable-identity");
}

// why: undoing a split takes its boundary out of the text; the new beat's record stays, so a redo can put the same beat back.
export function prepareSharedSplitRetire(operation: SharedSplitRetire, view: SharedPreparationView): SharedTextOperationPreparation {
  return preparedTextOperation(() => {
    checkAuthor(operation);
    const found = located(view, operation.beat, operation.beat);
    if (!found) return preparedTextDescription([], []);
    spliceSharedTextPlan(found.plan, found.index, found.index + 1, []);
    return preparedTextDescription([sharedTextOverlay(found.plan)],
      [{ kind: "edit", write: { target: found.plan.target, edit: { type: "delete", from: found.index, to: found.index + 1 }, marks: [] } }]);
  });
}

// why: the boundary is written directly after the one the undo took out, so text typed on either side keeps its side.
export function prepareSharedSplitRestore(operation: SharedSplitRestore, view: SharedPreparationView): SharedTextOperationPreparation {
  return preparedTextOperation(() => {
    checkAuthor(operation);
    if (located(view, operation.target.owner, operation.beat)) return preparedTextDescription([], []);
    const plan = sharedTextCommandPlan(view, operation.target), unit = readSharedAnchorUnit(operation.unit);
    if (!unit || unit.after) throw new SharedTextPreparationError("invalid-reference");
    const at = resolveSharedTextReference(view, plan, operation.unit, "point").from;
    const value = operation.before ? { b: operation.beat, before: operation.before } : { b: operation.beat };
    spliceSharedTextPlan(plan, at, at, [value]);
    planSharedStructureOwner(view, operation.beat, plan.target.segment);
    return preparedTextDescription([sharedTextOverlay(plan)], [{ kind: "edit", write: { target: plan.target,
      edit: { type: "atom", at, value, beside: { client: unit.client, clock: unit.clock } }, marks: [] } }]);
  });
}

function boundaryAnchor(handle: SharedDocumentHandle, source: string, beat: string): { readonly segment: string; readonly anchor: SharedContentRef } | null {
  const prep = createSharedPreparation(handle);
  try {
    const found = located(prep.view, source, beat), segment = segmentOf(prep.view, beat);
    // why: a boundary written before its source (split-before) lies outside the source's text, so it is named through the new beat.
    const anchor = found && segment ? [source, beat].map(owner => createSharedAnchor(handle, { owner: owner as SharedContentRef, segment: segment as SharedContentRef, field: "audioText" },
      found.index, "after")).find(value => value !== null) : null;
    return anchor && segment ? { segment, anchor } : null;
  } catch (error) {
    if (error instanceof SharedTextPreparationError) return null;
    throw error;
  } finally { prep.close(); }
}

export function recordSharedSplit(handle: SharedDocumentHandle, operation: SharedBeatSplit | SharedBeatSplitBefore): SharedSplitUndoPart | null {
  const prep = createSharedPreparation(handle);
  let beat: string, source: string;
  try {
    beat = sharedStructureIdentity(prep.view.writer, operation.id, "beat");
    source = sharedStructureReference(prep.view, operation.target.owner);
  } finally { prep.close(); }
  const place = boundaryAnchor(handle, source, beat);
  return place ? { kind: "beat-split", beat: beat as SharedContentRef, source: source as SharedContentRef, segment: place.segment as SharedContentRef, boundary: place.anchor,
    before: operation.kind === "split-before" ? source as SharedContentRef : null, retired: false, content: readSharedBeatShape(handle, beat) } : null;
}

export interface SharedSplitUndoPlan { readonly effective: boolean; readonly inverse: () => SharedSplitUndoPart }

// why: a split is undone only while both beats stand and the new beat is as the split left it; a redo only shows more.
export function planSharedSplitUndo(handle: SharedDocumentHandle, part: SharedSplitUndoPart, author: () => { id: string; by: string },
  push: (raw: Record<string, unknown>) => void): SharedSplitUndoPlan {
  const live = readSharedLiveStructure(handle), place = boundaryAnchor(handle, part.source, part.beat);
  const standing = live.beats.has(part.source) && (part.retired ? place === null : place !== null && live.beats.has(part.beat));
  if (!standing || !part.retired && readSharedBeatShape(handle, part.beat) !== part.content) return { effective: false, inverse: () => part };
  const command = author();
  if (part.retired) push({ kind: "split-restore", ...command, target: { owner: part.source, segment: part.segment, field: "audioText" }, beat: part.beat, unit: part.boundary, before: part.before });
  else push({ kind: "split-retire", ...command, beat: part.beat });
  return { effective: true, inverse: () => {
    const now = boundaryAnchor(handle, part.source, part.beat);
    return { ...part, boundary: now?.anchor ?? part.boundary, retired: !part.retired, content: readSharedBeatShape(handle, part.beat) };
  } };
}
