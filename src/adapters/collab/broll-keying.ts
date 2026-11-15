import type { SharedBrollLineKey } from "../../core/collab/broll-keying.ts";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabProjectedVisualTargets } from "./painted-visual-targets.ts";
import { readSharedTextHistory } from "./text-history.ts";

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
