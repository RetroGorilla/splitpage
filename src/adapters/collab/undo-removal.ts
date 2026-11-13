import * as Y from "yjs";
import type { SharedContentRef, SharedOperation, SharedRestore, SharedSoftRemove, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { createSharedPreparation } from "./prepare.ts";
import { sharedStructureIdentity } from "./structure-identity.ts";
import { bindSharedStructurePlan, readSharedStructureRemoval } from "./structure-plan.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import { readSharedRemovalCommand } from "./removal-record.ts";
import type { SharedStoredRemovalCommand } from "./removal-record.ts";
import { readSharedRemovalState } from "./removal-state.ts";
import { readSharedTextHistory } from "./text-history.ts";
import { captureSharedTextRange } from "./executor-references.ts";
import { readSharedJoinedTextGeometry } from "./joined-text-geometry.ts";
import { readSharedStatus, readSharedStatusHeads } from "./status.ts";
import { readSharedPaintedText } from "./paint-base.ts";

export type SharedRemovalUndoPart = Extract<SharedUndoPart, { kind: "remove" | "restore" }>;

// why: an operation id is unique only per writer, so a stored record is found by the key this copy wrote.
export function sharedOwnStructureKey(handle: SharedDocumentHandle, operation: string, role: "removal" | "restore"): SharedContentRef {
  const prep = createSharedPreparation(handle);
  try { return sharedStructureIdentity(prep.view.writer, operation, role); } finally { prep.close(); }
}

function storedRemoval(handle: SharedDocumentHandle, key: string): SharedStoredRemovalCommand | null {
  return readSharedRemovalCommand(key, collabState(handle).roots.removalRecords.get(key));
}

export function readSharedLiveBeats(handle: SharedDocumentHandle): ReadonlySet<string> {
  const prep = createSharedPreparation(handle);
  try {
    bindSharedStructurePlan(prep.view, observeSharedStructureIndex(handle));
    return new Set([...collabState(handle).roots.beats.keys()].filter(beat => !readSharedStructureRemoval(prep.view, beat)));
  } finally { prep.close(); }
}

function segmentOf(handle: SharedDocumentHandle, beat: string): string | null {
  const prep = createSharedPreparation(handle);
  try { return prep.view.resolveOwner(beat, "audioText")?.segment ?? null; } finally { prep.close(); }
}

function rowPieces(handle: SharedDocumentHandle, beat: string): readonly { readonly owner: string; readonly segment: string; readonly glue: string; readonly group: string | null }[] {
  const prep = createSharedPreparation(handle);
  try {
    const owner = prep.view.resolveOwner(beat, "audioText");
    const parts = owner ? readSharedJoinedTextGeometry(prep.view, beat)?.parts ?? [{ owner: beat, segment: owner.segment, glue: "", group: null }] : [];
    return parts.map(({ owner, segment, glue, group }) => ({ owner, segment, glue, group }));
  } finally { prep.close(); }
}

// why: the attachment index cannot be read inside a write, so a beat's visuals and gallery are found by the beat they name.
function attached(handle: SharedDocumentHandle, beat: string): unknown[] {
  const roots = collabState(handle).roots;
  return (["visuals", "gallery"] as const).flatMap(collection => [...roots[collection].entries()]
    .filter(([, record]) => record instanceof Y.Map && record.get("beat") === beat).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, record]) => [collection, key, (record as Y.Map<unknown>).toJSON()]));
}

// why: undo of a restore never removes someone else's work, so it compares the beats with how the restore left them:
// the stored beat, its status, its visuals and every piece of its row with characters and marks.
export function readSharedBeatContent(handle: SharedDocumentHandle, beats: readonly string[]): string {
  return JSON.stringify(beats.map(beat => {
    const stored = collabState(handle).roots.beats.get(beat), status = { scope: "beat", record: beat as SharedContentRef } as const;
    const pieces = rowPieces(handle, beat).map(piece => {
      const history = readSharedTextHistory(handle, { owner: piece.owner as SharedContentRef, segment: piece.segment as SharedContentRef, field: "audioText" });
      return [piece, history?.units.map(unit => [unit.unit, unit.value, unit.marks]) ?? null];
    });
    return [beat, stored instanceof Y.Map ? stored.toJSON() : null, readSharedStatus(handle, status), readSharedStatusHeads(handle, status), attached(handle, beat), pieces];
  }));
}

function textLength(handle: SharedDocumentHandle, target: SharedTextAddress): number {
  return readSharedPaintedText(handle, target)?.text.length ?? 0;
}

export function recordSharedRemoval(handle: SharedDocumentHandle, operation: SharedSoftRemove | SharedRestore, before: ReadonlySet<string>): SharedRemovalUndoPart | null {
  const role = operation.kind === "remove" ? "removal" : "restore", key = sharedOwnStructureKey(handle, operation.id, role), record = storedRemoval(handle, key);
  return record ? describeSharedRemoval(handle, key, record, before) : null;
}

function describeSharedRemoval(handle: SharedDocumentHandle, key: SharedContentRef, record: SharedStoredRemovalCommand, before: ReadonlySet<string>): SharedRemovalUndoPart | null {
  const after = readSharedLiveBeats(handle);
  if (record.kind === "remove") {
    return record.removalKind === "beat" ? { kind: "remove", removal: key, beats: [...before].filter(beat => !after.has(beat)).sort() as SharedContentRef[] } : null;
  }
  const removals = record.removals.map(removal => storedRemoval(handle, removal));
  const first = removals[0];
  if (!first || removals.some(removal => removal?.kind !== "remove" || removal.removalKind !== "beat") || first.kind !== "remove") return null;
  const beats = [...after].filter(beat => !before.has(beat)).sort() as SharedContentRef[];
  return { kind: "restore", restore: key, beats, at: first.at, content: readSharedBeatContent(handle, beats) };
}

// why: a removal is undone only while it is the one the beat shows; a restore or a later removal by anyone uses it up.
function activeRemoval(handle: SharedDocumentHandle, key: string): boolean {
  const record = storedRemoval(handle, key);
  return record?.kind === "remove" && record.targets.some(target => {
    const beat = collabState(handle).roots.beats.get(target.beat), flags = beat instanceof Y.Map ? beat.get("removals") : null;
    if (!(flags instanceof Y.Map) || !flags.has(key)) return false;
    const state = readSharedRemovalState([...flags.entries()]);
    return state.removed && state.generation === target.generation;
  });
}

export interface SharedRemovalUndoPlan { readonly effective: boolean; readonly inverse: () => SharedRemovalUndoPart }

export function planSharedRemovalUndo(handle: SharedDocumentHandle, part: SharedRemovalUndoPart, author: () => { id: string; by: string },
  push: (raw: Record<string, unknown>) => SharedOperation): SharedRemovalUndoPlan {
  const before = readSharedLiveBeats(handle);
  if (part.kind === "remove") {
    if (!activeRemoval(handle, part.removal)) return { effective: false, inverse: () => part };
    const command = author();
    push({ kind: "restore", ...command, removals: [part.removal] });
    return { effective: true, inverse: () => {
      const key = sharedOwnStructureKey(handle, command.id, "restore"), record = storedRemoval(handle, key);
      return (record && describeSharedRemoval(handle, key, record, before)) ?? part;
    } };
  }
  const unchanged = part.beats.length > 0 && part.beats.every(beat => before.has(beat)) && readSharedBeatContent(handle, part.beats) === part.content;
  if (!unchanged) return { effective: false, inverse: () => part };
  const command = author(), observed = part.beats.flatMap(beat => {
    const segment = segmentOf(handle, beat), target = segment ? { owner: beat as SharedContentRef, segment: segment as SharedContentRef, field: "audioText" } as const : null;
    const span = target && captureSharedTextRange(handle, target, 0, textLength(handle, target));
    return span ? [span] : [];
  });
  push({ kind: "remove", ...command, removalKind: "beat", targets: part.beats, observed, boundaries: part.beats, components: [], gallery: [], at: part.at });
  return { effective: true, inverse: () => {
    const key = sharedOwnStructureKey(handle, command.id, "removal"), record = storedRemoval(handle, key);
    return (record && describeSharedRemoval(handle, key, record, before)) ?? part;
  } };
}
