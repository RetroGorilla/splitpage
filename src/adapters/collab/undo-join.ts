import * as Y from "yjs";
import type { SharedBeatJoin, SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { sharedJson } from "./snapshot.ts";
import { createSharedPreparation } from "./prepare.ts";
import { sharedStructureReference } from "./structure-identity.ts";
import { readSharedStructureRemoval } from "./structure-plan.ts";
import { readSharedJoinedTextGeometry } from "./joined-text-geometry.ts";
import { readSharedJoinEntry } from "./join-record.ts";

export type SharedJoinUndoPart = Extract<SharedUndoPart, { kind: "join" }>;
interface StoredJoin { readonly id: SharedContentRef; readonly into: string; readonly glue: "" | " "; readonly generation: number; readonly operation: unknown }

function storedJoins(handle: SharedDocumentHandle, from: string): StoredJoin[] {
  const beat = collabState(handle).roots.beats.get(from), joins = beat instanceof Y.Map ? beat.get("joins") : null;
  if (!(joins instanceof Y.Map)) return [];
  return [...joins.entries()].flatMap(([id, raw]) => {
    const entry = readSharedJoinEntry(raw), json = sharedJson(raw) as { operation?: unknown } | null;
    return entry ? [{ id: id as SharedContentRef, ...entry, operation: json?.operation }] : [];
  });
}

export function recordSharedJoin(handle: SharedDocumentHandle, operation: SharedBeatJoin): SharedJoinUndoPart | null {
  const prep = createSharedPreparation(handle);
  try {
    const from = prep.view.resolveOwner(sharedStructureReference(prep.view, operation.from), "audioText");
    return from ? readSharedJoinOf(handle, from.owner, operation.id) : null;
  } finally { prep.close(); }
}

export function readSharedJoinOf(handle: SharedDocumentHandle, from: string, operation: string): SharedJoinUndoPart | null {
  const found = storedJoins(handle, from).find(item => item.operation === operation);
  return found ? { kind: "join", join: found.id, from: from as SharedContentRef, into: found.into as SharedContentRef, glue: found.glue,
    generation: found.generation, retired: false } : null;
}

export function isSharedJoinRetired(handle: SharedDocumentHandle, join: string, group: string): boolean {
  const retired = collabState(handle).roots.retiredJoins;
  return retired.get(join) === true || retired.get(group) === true;
}

export function nextSharedJoinGeneration(handle: SharedDocumentHandle, from: string, into: string, glue: "" | " "): number {
  return storedJoins(handle, from).filter(item => item.into === into && item.glue === glue).reduce((highest, item) => Math.max(highest, item.generation + 1), 0);
}

// why: a join is undone only while the source beat follows the target beat through it in the row as shown.
export function readSharedJoinPlace(handle: SharedDocumentHandle, from: string, into: string):
  { readonly removed: boolean; readonly joined: { readonly group: string | null; readonly glue: "" | " " } | null; readonly root: string } {
  const prep = createSharedPreparation(handle);
  try {
    const owners = [prep.view.resolveOwner(from, "audioText"), prep.view.resolveOwner(into, "audioText")];
    const removed = owners.includes(null) || readSharedStructureRemoval(prep.view, from) || readSharedStructureRemoval(prep.view, into);
    const geometry = readSharedJoinedTextGeometry(prep.view, from), parts = geometry && !geometry.removed ? geometry.parts : [];
    const at = parts.findIndex((part, index) => part.owner === from && parts[index - 1]?.owner === into), part = parts[at];
    return { removed, joined: part ? { group: part.group, glue: part.glue } : null, root: readSharedJoinedTextGeometry(prep.view, into)?.root ?? into };
  } finally { prep.close(); }
}
