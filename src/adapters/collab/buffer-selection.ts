import type { FlowRange } from "../../core/flow/flow.ts";
import { beatPos } from "../../core/flow/flow.ts";
import type { SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { resolveSharedAnchor } from "./anchors.ts";
import { collabProjectedNarrationPoint } from "./text-target.ts";

export function resolveSharedBufferedSelection(handle: SharedDocumentHandle, anchors: readonly (SharedContentRef | null)[]): FlowRange | undefined {
  function point(anchor: SharedContentRef | null | undefined) {
    const location = anchor ? resolveSharedAnchor(handle, anchor) : "gone";
    if (location === "gone") return null;
    const projected = collabProjectedNarrationPoint(handle, location.segment, location.offset);
    return projected ? beatPos(projected.owner, projected.offset) : null;
  }
  const anchor = point(anchors[0]), head = point(anchors[1]);
  return anchor && head ? { anchor, head } : undefined;
}
