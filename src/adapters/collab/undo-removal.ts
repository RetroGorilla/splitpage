import * as Y from "yjs";
import type { SharedContentRef, SharedHeadingRemove, SharedOperation, SharedRestore, SharedSoftRemove, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { createSharedPreparation } from "./prepare.ts";
import { sharedStructureIdentity } from "./structure-identity.ts";
import { bindSharedStructurePlan, readSharedStructureRemoval } from "./structure-plan.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import { readSharedRemovalCommand } from "./removal-record.ts";
import type { SharedStoredRemovalCommand } from "./removal-record.ts";
import { readSharedHeadingRemovalState, readSharedRemovalState, sharedHeadingRemovalField } from "./removal-state.ts";
import { sharedFollowingBeat } from "./removal-executor.ts";
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

export interface SharedLiveStructure { readonly beats: ReadonlySet<string>; readonly headings: ReadonlySet<string> }

function headingRemoved(record: unknown): boolean {
  return record instanceof Y.Map && readSharedHeadingRemovalState(record.keys(), key => record.get(key)).removed;
}

export function readSharedLiveStructure(handle: SharedDocumentHandle): SharedLiveStructure {
  const prep = createSharedPreparation(handle), roots = collabState(handle).roots;
  try {
    bindSharedStructurePlan(prep.view, observeSharedStructureIndex(handle));
    return { beats: new Set([...roots.beats.keys()].filter(beat => !readSharedStructureRemoval(prep.view, beat))),
      headings: new Set([...roots.headings.entries()].filter(([, record]) => !headingRemoved(record)).map(([key]) => key)) };
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

// why: the attachment index cannot be read inside a write, so visuals and gallery are found by their beat.
function attached(handle: SharedDocumentHandle, beat: string): unknown[] {
  const roots = collabState(handle).roots;
  return (["visuals", "gallery"] as const).flatMap(collection => [...roots[collection].entries()]
    .filter(([, record]) => record instanceof Y.Map && record.get("beat") === beat).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, record]) => {
      const { text: _text, markRecords: _marks, ...fields } = (record as Y.Map<unknown>).toJSON();
      // why: a visual is compared by what it shows, so typing undone in it leaves no difference behind in its mark records.
      return collection === "gallery" ? [collection, key, (record as Y.Map<unknown>).toJSON()] : [collection, key, fields,
        readSharedTextHistory(handle, { owner: beat as SharedContentRef, segment: key as SharedContentRef, field: "visualText" })?.units.map(unit => [unit.unit, unit.value, unit.marks]) ?? null];
    }));
}

// why: rule 35 leaves a beat's stamp as it is through undo, so a stamp alone is no change that uses an undo up.
function unstamped(stored: unknown): unknown {
  return stored instanceof Y.Map ? Object.fromEntries(Object.entries(stored.toJSON()).filter(([key]) => key !== "stamp" && !key.startsWith("stamp:"))) : null;
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
    return [beat, unstamped(stored), readSharedStatus(handle, status), readSharedStatusHeads(handle, status), attached(handle, beat), pieces];
  }));
}

// why: a split is taken back only while nothing stored for the new beat changed; its characters join the source beat.
export function readSharedBeatShape(handle: SharedDocumentHandle, beat: string): string {
  const stored = collabState(handle).roots.beats.get(beat), status = { scope: "beat", record: beat as SharedContentRef } as const;
  return JSON.stringify([unstamped(stored), readSharedStatus(handle, status), readSharedStatusHeads(handle, status), attached(handle, beat),
    rowPieces(handle, beat).map(({ owner, segment, group }) => [owner, segment, group])]);
}

function textLength(handle: SharedDocumentHandle, target: SharedTextAddress): number {
  return target.field === "heading" ? readSharedTextHistory(handle, target)?.units.length ?? 0 : readSharedPaintedText(handle, target)?.text.length ?? 0;
}

function headingPlace(handle: SharedDocumentHandle, heading: string): { readonly segment: string; readonly first: string | null } | null {
  const prep = createSharedPreparation(handle);
  try {
    const owner = prep.view.resolveOwner(heading, "heading");
    return owner ? { segment: owner.segment, first: sharedFollowingBeat(prep.view, owner) } : null;
  } finally { prep.close(); }
}

// why: a heading is removed again only if nothing stored for it or its scene's first beat changed since the restore.
function readSharedHeadingContent(handle: SharedDocumentHandle, headings: readonly string[]): unknown[] {
  return headings.map(heading => {
    const stored = collabState(handle).roots.headings.get(heading), place = headingPlace(handle, heading);
    const history = place ? readSharedTextHistory(handle, { owner: heading as SharedContentRef, segment: place.segment as SharedContentRef, field: "heading" }) : null;
    return [heading, stored instanceof Y.Map ? stored.toJSON() : null, history?.units.map(unit => [unit.unit, unit.value, unit.marks]) ?? null,
      place?.first ?? null, place?.first ? readSharedBeatContent(handle, [place.first]) : null];
  });
}

function restoredContent(handle: SharedDocumentHandle, beats: readonly string[], headings: readonly string[]): string {
  return headings.length ? JSON.stringify([readSharedBeatContent(handle, beats), readSharedHeadingContent(handle, headings)]) : readSharedBeatContent(handle, beats);
}

export function recordSharedRemoval(handle: SharedDocumentHandle, operation: SharedSoftRemove | SharedRestore | SharedHeadingRemove, before: SharedLiveStructure): SharedRemovalUndoPart | null {
  const role = operation.kind === "restore" ? "restore" : "removal", key = sharedOwnStructureKey(handle, operation.id, role), record = storedRemoval(handle, key);
  return record ? describeSharedRemoval(handle, key, record, before) : null;
}

function describeSharedRemoval(handle: SharedDocumentHandle, key: SharedContentRef, record: SharedStoredRemovalCommand, before: SharedLiveStructure): SharedRemovalUndoPart | null {
  const after = readSharedLiveStructure(handle);
  const gone = (from: ReadonlySet<string>, to: ReadonlySet<string>) => [...from].filter(item => !to.has(item)).sort() as SharedContentRef[];
  if (record.kind === "remove") {
    if (record.removalKind === "beat") return { kind: "remove", removal: key, beats: gone(before.beats, after.beats) };
    const headings = gone(before.headings, after.headings);
    return record.removalKind === "header" && headings.length === 1 ? { kind: "remove", removal: key, beats: [], headings } : null;
  }
  const removals = record.removals.map(removal => storedRemoval(handle, removal));
  const first = removals[0], kind = first?.kind === "remove" ? first.removalKind : null;
  if (!first || first.kind !== "remove" || kind !== "beat" && kind !== "header" || removals.some(removal => removal?.kind !== "remove" || removal.removalKind !== kind)) return null;
  const beats = gone(after.beats, before.beats), headings = gone(after.headings, before.headings);
  if (kind === "beat") return { kind: "restore", restore: key, beats, at: first.at, content: restoredContent(handle, beats, []) };
  return headings.length === 1 && !beats.length ? { kind: "restore", restore: key, beats: [], headings, at: first.at, content: restoredContent(handle, [], headings) } : null;
}

// why: a removal is undone only while it is the one the beat shows; a restore or a later removal by anyone uses it up.
function activeRemoval(handle: SharedDocumentHandle, key: string): boolean {
  const record = storedRemoval(handle, key);
  return record?.kind === "remove" && record.targets.some(target => {
    if (record.removalKind === "header") {
      const heading = collabState(handle).roots.headings.get(target.beat);
      if (!(heading instanceof Y.Map) || !heading.has(sharedHeadingRemovalField(key))) return false;
      const state = readSharedHeadingRemovalState(heading.keys(), field => heading.get(field));
      return state.removed && state.generation === target.generation;
    }
    const beat = collabState(handle).roots.beats.get(target.beat), flags = beat instanceof Y.Map ? beat.get("removals") : null;
    if (!(flags instanceof Y.Map) || !flags.has(key)) return false;
    const state = readSharedRemovalState([...flags.entries()]);
    return state.removed && state.generation === target.generation;
  });
}

export interface SharedRemovalUndoPlan { readonly effective: boolean; readonly inverse: () => SharedRemovalUndoPart }

export function planSharedRemovalUndo(handle: SharedDocumentHandle, part: SharedRemovalUndoPart, author: () => { id: string; by: string },
  push: (raw: Record<string, unknown>) => SharedOperation): SharedRemovalUndoPlan {
  const before = readSharedLiveStructure(handle);
  if (part.kind === "remove") {
    if (!activeRemoval(handle, part.removal)) return { effective: false, inverse: () => part };
    const command = author();
    push({ kind: "restore", ...command, removals: [part.removal] });
    return { effective: true, inverse: () => {
      const key = sharedOwnStructureKey(handle, command.id, "restore"), record = storedRemoval(handle, key);
      return (record && describeSharedRemoval(handle, key, record, before)) ?? part;
    } };
  }
  const headings = part.headings ?? [], unchanged = part.beats.length + headings.length > 0 && part.beats.every(beat => before.beats.has(beat))
    && headings.every(heading => before.headings.has(heading)) && restoredContent(handle, part.beats, headings) === part.content;
  if (!unchanged) return { effective: false, inverse: () => part };
  const spans = (owner: string, segment: string | null | undefined, field: "audioText" | "heading") => {
    const target = segment ? { owner: owner as SharedContentRef, segment: segment as SharedContentRef, field } as const : null;
    const span = target && captureSharedTextRange(handle, target, 0, textLength(handle, target));
    return span ? [span] : [];
  };
  const command = author(), heading = headings[0];
  if (heading) push({ kind: "heading-remove", ...command, heading, observed: spans(heading, headingPlace(handle, heading)?.segment, "heading"), newBeat: null, nextBeat: null });
  else push({ kind: "remove", ...command, removalKind: "beat", targets: part.beats, observed: part.beats.flatMap(beat => spans(beat, segmentOf(handle, beat), "audioText")),
    boundaries: part.beats, components: [], gallery: [], at: part.at });
  return { effective: true, inverse: () => {
    const key = sharedOwnStructureKey(handle, command.id, "removal"), record = storedRemoval(handle, key);
    return (record && describeSharedRemoval(handle, key, record, before)) ?? part;
  } };
}
