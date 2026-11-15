import * as Y from "yjs";
import type { SharedBrollLineKey } from "../../core/collab/broll-keying.ts";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabProjectedVisualTargets } from "./painted-visual-targets.ts";
import { readSharedTextHistory } from "./text-history.ts";
import { collabState } from "./state.ts";
import { SHARED_RECORD_DELETION_FIELD, readStoredRecordDeletion, sharedRecordDeletionStoreView, sharedRecordStatusObservation } from "./record-deletion.ts";

export function sharedBrollShotRemoved(handle: SharedDocumentHandle, id: string): boolean {
  return readStoredRecordDeletion(collabState(handle).roots.shots.get(id)) !== null;
}

const UNMADE_SHOT_FIELDS: ReadonlySet<string> = Object.freeze(new Set(["rank", "extra", SHARED_RECORD_DELETION_FIELD]));

// why: rule 196 on #1414: cleanup may run on a copy that never held the creation's fields, so a shot is untouched only
// while each stored field is its creator's first write, with no prop entry and no standing status since.
export function sharedBrollShotUntouched(handle: SharedDocumentHandle, id: string): boolean {
  const { roots } = collabState(handle), shot: unknown = roots.shots.get(id);
  if (!(shot instanceof Y.Map) || !shot._item) return false;
  const creator = shot._item.id.client;
  for (const [field, item] of shot._map) {
    if (item.deleted || item.left !== null || item.id.client !== creator || UNMADE_SHOT_FIELDS.has(field)) return false;
    const value: unknown = item.content.getContent()[0];
    if (field === "props" && (!(value instanceof Y.Map) || value._map.size > 0)) return false;
  }
  return sharedRecordStatusObservation(sharedRecordDeletionStoreView(roots), "shot", id) === "[]";
}

// why: rule 196 on #1414: a restored character answers to the one it restored, so a line keyed again after an undo
// takes the id it had; a visual a join brought in is read-only to shared typing (rule 93), so it is not keyed.
export function sharedBrollLineKeys(handle: SharedDocumentHandle, rowId: string): SharedBrollLineKey | null {
  const target = { owner: rowId, segment: rowId, field: "visualText" } as SharedTextAddress;
  if (collabProjectedVisualTargets(handle, target)?.parts.length !== 1) return null;
  const history = readSharedTextHistory(handle, target);
  if (!history) return null;
  return at => {
    const unit = history.units[at];
    if (!unit) return null;
    const root = history.root(unit.unit);
    return "bs_k" + root.client + "_" + root.clock;
  };
}
