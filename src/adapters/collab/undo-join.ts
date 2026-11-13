import * as Y from "yjs";
import type { SharedBeatJoin, SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedUndoPart } from "../../core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { createSharedPreparation } from "./prepare.ts";
import { sharedStructureIdentity, sharedStructureReference } from "./structure-identity.ts";
import { interpretSharedStructure, readSharedStructureRemoval, readSharedStructureStream, sharedStructurePlanIndex } from "./structure-plan.ts";
import { sharedOrderPlan } from "./structure-order-index.ts";
import { sharedPlannedSegmentAt, sharedPlannedSegmentIndex } from "./structure-order.ts";
import { projectSharedJoinGlue, sharedJoinFormatRegisterField, sharedJoinGlueRegisterField } from "../../core/collab/projection/join-glue.ts";
import { FORMAT_MARKS } from "../../core/text/runs.ts";
import { readSharedJoinedTextGeometry } from "./joined-text-geometry.ts";
import { readSharedJoinEntry, sharedJoinRetirementGroup } from "./join-record.ts";

export type SharedJoinUndoPart = Extract<SharedUndoPart, { kind: "join" }>;
interface StoredJoin { readonly id: SharedContentRef; readonly into: string; readonly glue: "" | " "; readonly generation: number }

function storedJoins(handle: SharedDocumentHandle, from: string): StoredJoin[] {
  const beat = collabState(handle).roots.beats.get(from), joins = beat instanceof Y.Map ? beat.get("joins") : null;
  if (!(joins instanceof Y.Map)) return [];
  return [...joins.entries()].flatMap(([id, raw]) => {
    const entry = readSharedJoinEntry(raw);
    return entry ? [{ id: id as SharedContentRef, ...entry }] : [];
  });
}

export function isSharedJoinRetired(handle: SharedDocumentHandle, join: string, group: string): boolean {
  const retired = collabState(handle).roots.retiredJoins;
  return retired.get(join) === true || retired.get(group) === true;
}

function liveJoins(handle: SharedDocumentHandle, from: string, into: string): StoredJoin[] {
  return storedJoins(handle, from).filter(item => item.into === into && !isSharedJoinRetired(handle, item.id, sharedJoinRetirementGroup(from, item)));
}

export function recordSharedJoin(handle: SharedDocumentHandle, operation: SharedBeatJoin): SharedJoinUndoPart | null {
  const prep = createSharedPreparation(handle);
  try {
    const from = prep.view.resolveOwner(sharedStructureReference(prep.view, operation.from), "audioText");
    return from ? readSharedJoinOf(handle, from.owner, operation.id) : null;
  } finally { prep.close(); }
}

// why: an operation id is unique only per writer, so the entry is found by the key this copy's join wrote.
export function readSharedJoinOf(handle: SharedDocumentHandle, from: string, operation: string): SharedJoinUndoPart | null {
  const prep = createSharedPreparation(handle);
  let key: string;
  try { key = sharedStructureIdentity(prep.view.writer, operation, "join"); } finally { prep.close(); }
  const found = storedJoins(handle, from).find(item => item.id === key);
  return found ? { kind: "join", join: found.id, from: from as SharedContentRef, into: found.into as SharedContentRef, glue: found.glue,
    generation: found.generation, retired: false } : null;
}

export function nextSharedJoinGeneration(handle: SharedDocumentHandle, from: string, into: string, glue: "" | " "): number {
  return storedJoins(handle, from).filter(item => item.into === into && item.glue === glue).reduce((highest, item) => Math.max(highest, item.generation + 1), 0);
}

// why: rule 48 keeps a later join of the same pair by someone else, so ours is not retired while one is live.
export function hasLaterSharedJoin(handle: SharedDocumentHandle, part: SharedJoinUndoPart): boolean {
  return liveJoins(handle, part.from, part.into).some(item => item.glue === part.glue && item.generation > part.generation);
}

// why: a join puts the source after the whole row, so a target part anywhere before it in the row counts.
export function readSharedJoinPlace(handle: SharedDocumentHandle, from: string, into: string):
  { readonly removed: boolean; readonly joined: { readonly glue: "" | " " } | null; readonly root: string } {
  const prep = createSharedPreparation(handle);
  try {
    const owners = [prep.view.resolveOwner(from, "audioText"), prep.view.resolveOwner(into, "audioText")];
    const removed = owners.includes(null) || readSharedStructureRemoval(prep.view, from) || readSharedStructureRemoval(prep.view, into);
    const geometry = readSharedJoinedTextGeometry(prep.view, from), parts = geometry && !geometry.removed ? geometry.parts : [];
    const groups = new Set(liveJoins(handle, from, into).map(item => sharedJoinRetirementGroup(from, item)));
    const part = parts.find((part, index) => part.owner === from && part.group !== null && groups.has(part.group) && parts.slice(0, index).some(other => other.owner === into));
    return { removed, joined: part ? { glue: part.glue } : null, root: readSharedJoinedTextGeometry(prep.view, into)?.root ?? into };
  } finally { prep.close(); }
}

function findSharedJoin(handle: SharedDocumentHandle, join: string): { readonly from: string; readonly entry: StoredJoin } | null {
  for (const from of collabState(handle).roots.beats.keys()) {
    const entry = storedJoins(handle, from).find(item => item.id === join);
    if (entry) return { from, entry };
  }
  return null;
}

function shownSeparator(handle: SharedDocumentHandle, from: string, entry: StoredJoin): "" | " " {
  return projectSharedJoinGlue(entry.glue, collabState(handle).roots.meta.get(sharedJoinGlueRegisterField(sharedJoinRetirementGroup(from, entry))));
}

// why: an unjoin is recorded as the join it retired, with its separator and space formats, so its undo joins again.
export function readSharedJoinBeforeRetire(handle: SharedDocumentHandle, join: string): SharedJoinUndoPart | null {
  const found = findSharedJoin(handle, join);
  if (!found) return null;
  const { from, entry } = found, group = sharedJoinRetirementGroup(from, entry), meta = collabState(handle).roots.meta;
  if (isSharedJoinRetired(handle, entry.id, group)) return null;
  const formats = FORMAT_MARKS.filter(format => meta.get(sharedJoinFormatRegisterField(group, format)) === true);
  return { kind: "join", join: entry.id, from: from as SharedContentRef, into: entry.into as SharedContentRef, glue: shownSeparator(handle, from, entry),
    generation: entry.generation, retired: true, ...formats.length ? { formats } : {} };
}

export function readSharedJoinSeparator(handle: SharedDocumentHandle, join: string): { readonly from: string; readonly separator: "" | " " } | null {
  const found = findSharedJoin(handle, join);
  return found ? { from: found.from, separator: shownSeparator(handle, found.from, found.entry) } : null;
}

// why: a separator change is taken back only while its join stands and still shows what the change wrote (rule 28).
export function planSharedJoinGlueUndo(handle: SharedDocumentHandle, part: Extract<SharedUndoPart, { kind: "join-glue" }>, push: (glue: "" | " ") => void): boolean {
  const entry = storedJoins(handle, part.from).find(item => item.id === part.join);
  const effective = !!entry && !isSharedJoinRetired(handle, entry.id, sharedJoinRetirementGroup(part.from, entry)) && shownSeparator(handle, part.from, entry) === part.written;
  if (effective) push(part.prior);
  return effective;
}

// why: a join puts the source after the target's own row, so it is made again only while the source is next there.
export function readSharedJoinNeighbours(handle: SharedDocumentHandle, from: string, into: string): boolean {
  const prep = createSharedPreparation(handle);
  try {
    const view = prep.view;
    if (!view.resolveOwner(into, "audioText")) return false;
    const geometry = readSharedJoinedTextGeometry(view, into), parts = geometry?.root === into ? geometry.parts : geometry?.parts.filter(part => part.owner === into) ?? [];
    const last = parts.at(-1);
    if (!last) return false;
    const order = sharedStructurePlanIndex(view).order, length = sharedOrderPlan(view, order).length;
    let after = false;
    for (let index = sharedPlannedSegmentIndex(view, order, last.segment); index >= 0 && index < length; index++) {
      const segment = sharedPlannedSegmentAt(view, order, index), stream = segment === undefined ? undefined : readSharedStructureStream(view, segment);
      if (!stream) continue;
      for (const block of interpretSharedStructure(view, [], stream)) {
        if (block.segment !== segment || block.reason || block.id === null) continue;
        if (after) return block.kind === "b" && block.id === from;
        after = block.kind === "b" && block.id === last.owner;
      }
    }
    return false;
  } finally { prep.close(); }
}
