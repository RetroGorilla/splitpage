import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { nativeStructureView, collabPurposeTextTarget } from "./text-target.ts";
import { readSharedJoinedVisualOwners } from "./joined-text-geometry.ts";
import { sortSharedRecordReadings } from "./record-reader.ts";
import { readStoredSharedRecord } from "./record-codec.ts";

export function collabProjectedVisualTargets(handle: SharedDocumentHandle, raw: SharedTextAddress) {
  try {
    if (raw.field !== "visualText") return null;
    const { view } = nativeStructureView(handle), owners = readSharedJoinedVisualOwners(view, raw.owner);
    if (!owners) return null;
    const root = collabState(handle).roots.visuals;
    const visuals = sortSharedRecordReadings("visuals", [...root.keys()].sort().flatMap(key => {
      const fields = readStoredSharedRecord("visuals", key, root.get(key));
      if (!fields) return [];
      // why: wire encoding replaces lone surrogates, so rank ties must agree before and after a late join.
      return [{ key, fields: { beat: fields.beat, rank: String(fields.rank).replace(/\p{Cs}/gu, "\ufffd") } }];
    }));
    const parts = owners.flatMap(owner => visuals.filter(visual => visual.fields.beat === owner).flatMap(visual => {
      const physical = collabPurposeTextTarget(handle, { owner: owner as SharedTextAddress["owner"], segment: visual.key as SharedTextAddress["segment"], field: "visualText" }, "stored-anchor-read");
      return physical ? [{ ...physical, from: 0, to: physical.text.length, glue: "" as const, group: null, cyclic: false }] : [];
    }));
    return { parts };
  } catch { return null; }
}
