import * as Y from "yjs";
import type { SharedContentRef, SharedOperation, SharedRestore, SharedSoftRemove } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { sharedJson } from "./snapshot.ts";
import { createSharedPreparation } from "./prepare.ts";
import { sharedStructureIdentity } from "./structure-identity.ts";
import { bindSharedStructurePlan, readSharedStructureRemoval } from "./structure-plan.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import { readSharedRemovalCommand } from "./removal-record.ts";
import type { SharedStoredRemovalCommand } from "./removal-record.ts";
import { readSharedRemovalState } from "./removal-state.ts";
import { readSharedTextHistory } from "./text-history.ts";
import { captureSharedTextRange } from "./executor-references.ts";

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

// why: undo of a restore never removes someone else's work, so it compares the beats with how the restore left them.
export function readSharedBeatContent(handle: SharedDocumentHandle, beats: readonly string[]): string {
  return JSON.stringify(beats.map(beat => {
    const segment = segmentOf(handle, beat), stored = collabState(handle).roots.beats.get(beat);
    const history = segment ? readSharedTextHistory(handle, { owner: beat as SharedContentRef, segment: segment as SharedContentRef, field: "audioText" }) : null;
    return [beat, stored instanceof Y.Map ? sharedJson(stored) : null, history?.units.map(unit => [unit.unit, unit.value, unit.marks]) ?? null];
  }));
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
    const segment = segmentOf(handle, beat), span = segment && captureSharedTextRange(handle, { owner: beat as SharedContentRef, segment: segment as SharedContentRef, field: "audioText" }, 0, Number.MAX_SAFE_INTEGER);
    return span ? [span] : [];
  });
  push({ kind: "remove", ...command, removalKind: "beat", targets: part.beats, observed, boundaries: part.beats, components: [], gallery: [], at: part.at });
  return { effective: true, inverse: () => {
    const key = sharedOwnStructureKey(handle, command.id, "removal"), record = storedRemoval(handle, key);
    return (record && describeSharedRemoval(handle, key, record, before)) ?? part;
  } };
}
